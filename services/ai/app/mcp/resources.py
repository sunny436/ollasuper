"""MCP Resources and Resource Templates. PURE: no I/O, no network, no clock.

RESOURCES ARE NOT TOOLS, and this module exists to keep that true. A resource is
a thing you can READ; a tool is a thing you can RUN. Collapsing them would put a
`resources/read` behind the tool policy ladder — where a read-only fetch would
inherit approval semantics designed for side effects — and would publish every
resource URI into the model's tool list, which is the context explosion §37
warns about. So resources live in their own model, their own index
(`app/mcp/index.py`), and reach the model through exactly ONE generic tool.

THE URI IS AN OPAQUE IDENTIFIER, NOT A URL. Measured shapes from real servers:
`file://`, `git://`, `mem://`, `https://`, and vendor schemes nobody has seen
before. Nothing in this module resolves, fetches, or interprets one — the string
is a key handed back to `resources/read` on the SAME MCP session it came from.
That is the whole SSRF story: there is no code path here that could dial
anything, so there is nothing to guard.

TEMPLATES TAKE NO EXTRA PROTOCOL STEP, and that was measured rather than assumed.
A server advertising `mem://repo/{branch}/{path}` answers an ordinary
`read_resource("mem://repo/main/README.md")` with the templated content — there
is no "expand template" call. So a template is metadata plus `fill()`, and the
concrete URI goes through the same read as any other.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

__all__ = [
    "MAX_RESOURCES_PER_SERVER",
    "MAX_TEMPLATES_PER_SERVER",
    "McpResource",
    "McpResourceTemplate",
    "normalize_resource",
    "normalize_resources",
    "normalize_template",
    "normalize_templates",
]

#: Bounded because every one of these is a server-controlled string that reaches
#: logs, an API response and eventually a UI.
_MAX_URI = 2048
_MAX_NAME = 200
_MAX_DESCRIPTION = 1024
_MAX_MIME = 128

#: Ceilings on what one server may contribute. A server advertising 50,000
#: resources would swamp the index and the Phase 7 picker alike. Chosen to match
#: `MAX_TOOLS_PER_SERVER`'s reasoning rather than invented: a curated everyday
#: server exposes tens, not thousands.
MAX_RESOURCES_PER_SERVER = 256
MAX_TEMPLATES_PER_SERVER = 64

#: RFC 6570 level-1 placeholders — `{name}` only. Deliberately NOT the full
#: expression grammar: operators like `{+path}`, `{#frag}` and `{?q,r}` change
#: escaping rules, and guessing wrong builds a URI that silently addresses
#: something other than what the user asked for. An unsupported template is
#: reported and not filled, which is the honest failure.
_PLACEHOLDER = re.compile(r"\{([A-Za-z0-9_]+)\}")
_ANY_EXPRESSION = re.compile(r"\{([^}]*)\}")


def _text(value: Any, limit: int) -> str:
    """Bounded, control-characters stripped.

    The same treatment `connections.ts` gives server-supplied error text, and for
    the same reason: this string originates on a third party's server and is
    rendered in a browser and written to logs, so a crafted value must not be
    able to forge log structure or carry a terminal escape.
    """
    if not isinstance(value, str):
        return ""
    return "".join(c for c in value if c >= " " and c != chr(127))[:limit]


@dataclass(frozen=True)
class McpResource:
    """One readable resource on one connection.

    `connection_id` is part of the identity, not decoration: two servers may
    advertise the same URI, and a read must go back to the session it came from.
    """

    uri: str
    name: str
    connection_id: str
    server_slug: str
    description: str = ""
    mime_type: str = ""
    #: Server-declared, and NOT trusted as a bound — the read path applies its
    #: own cap regardless. Reported so a UI can warn before a large fetch.
    size: int | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.connection_id, self.uri)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class McpResourceTemplate:
    """A URI pattern that becomes a readable resource once filled."""

    uri_template: str
    name: str
    connection_id: str
    server_slug: str
    description: str = ""
    mime_type: str = ""
    #: Placeholder names, in order of first appearance.
    variables: tuple[str, ...] = ()
    #: False when the template uses RFC 6570 syntax beyond `{name}`. Such a
    #: template is still LISTED — a user may want to see it exists — but `fill`
    #: refuses it rather than guessing at the escaping.
    fillable: bool = True

    @property
    def key(self) -> tuple[str, str]:
        return (self.connection_id, self.uri_template)

    def fill(self, values: dict[str, str]) -> str:
        """Build a concrete URI. Raises `ValueError` on anything unsafe.

        EVERY VARIABLE MUST BE SUPPLIED, and no extra ones are tolerated. A
        missing variable would leave a literal `{branch}` in the URI, which the
        server would resolve to something nobody asked for; an extra one means
        the caller believes this template is something it is not.

        Values are NOT percent-encoded here. Encoding depends on the scheme, and
        this module deliberately does not interpret schemes — so a value
        containing a delimiter is REFUSED rather than mangled into a URI that
        addresses a different resource.
        """
        if not self.fillable:
            raise ValueError(
                f"template {self.uri_template!r} uses URI-template syntax beyond "
                "simple {name} placeholders and cannot be filled safely"
            )
        missing = [v for v in self.variables if v not in values]
        if missing:
            raise ValueError(f"missing template variables: {sorted(missing)}")
        extra = [k for k in values if k not in self.variables]
        if extra:
            raise ValueError(f"unknown template variables: {sorted(extra)}")

        out = self.uri_template
        for name in self.variables:
            value = values[name]
            if not isinstance(value, str) or not value:
                raise ValueError(
                    f"template variable {name!r} must be a non-empty string"
                )
            # A value that carries structure would change which resource the URI
            # addresses — `branch="main/../../etc"` is the classic shape.
            if any(c in value for c in "{}/?#[]@ \t\n") or ".." in value:
                raise ValueError(
                    f"template variable {name!r} contains characters that would "
                    "change which resource the URI addresses"
                )
            out = out.replace("{" + name + "}", value)
        if len(out) > _MAX_URI:
            raise ValueError("filled template exceeds the URI length cap")
        return out

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _variables(uri_template: str) -> tuple[tuple[str, ...], bool]:
    """Placeholder names plus whether every expression is a plain `{name}`."""
    simple = _PLACEHOLDER.findall(uri_template)
    every = _ANY_EXPRESSION.findall(uri_template)
    fillable = len(simple) == len(every) and all(
        expr in simple for expr in every
    )
    seen: list[str] = []
    for name in simple:
        if name not in seen:
            seen.append(name)
    return tuple(seen), fillable


def normalize_resource(
    raw: Any, *, connection_id: str, server_slug: str
) -> McpResource:
    """One `mcp_types.Resource` -> one `McpResource`. Raises on an unusable row.

    Typed `Any` rather than importing `mcp_types.Resource`, for the same reason
    `normalize.py` does it: this module stays importable and testable with no SDK
    present, and only the attributes the protocol guarantees are read.
    """
    uri = _text(getattr(raw, "uri", None) or "", _MAX_URI)
    if not uri:
        # `AnyUrl` and friends stringify; a resource with no URI is not
        # addressable and there is nothing useful to store.
        uri = _text(str(getattr(raw, "uri", "") or ""), _MAX_URI)
    if not uri:
        raise ValueError("MCP resource has no uri")

    size = getattr(raw, "size", None)
    return McpResource(
        uri=uri,
        # The URI is the fallback name: a nameless entry in a picker is worse
        # than a long one.
        name=_text(getattr(raw, "name", None), _MAX_NAME) or uri,
        connection_id=connection_id,
        server_slug=server_slug,
        description=_text(getattr(raw, "description", None), _MAX_DESCRIPTION),
        mime_type=_text(getattr(raw, "mime_type", None), _MAX_MIME),
        size=size if isinstance(size, int) and size >= 0 else None,
    )


def normalize_template(
    raw: Any, *, connection_id: str, server_slug: str
) -> McpResourceTemplate:
    """One `mcp_types.ResourceTemplate` -> one `McpResourceTemplate`."""
    template = _text(getattr(raw, "uri_template", None) or "", _MAX_URI)
    if not template:
        template = _text(str(getattr(raw, "uri_template", "") or ""), _MAX_URI)
    if not template:
        raise ValueError("MCP resource template has no uriTemplate")

    variables, fillable = _variables(template)
    return McpResourceTemplate(
        uri_template=template,
        name=_text(getattr(raw, "name", None), _MAX_NAME) or template,
        connection_id=connection_id,
        server_slug=server_slug,
        description=_text(getattr(raw, "description", None), _MAX_DESCRIPTION),
        mime_type=_text(getattr(raw, "mime_type", None), _MAX_MIME),
        variables=variables,
        fillable=fillable,
    )


@dataclass
class _Normalized:
    """Internal: what a batch normalization produced, including what it refused."""

    resources: list[McpResource] = field(default_factory=list)
    dropped: int = 0


def normalize_resources(
    rows: list[Any],
    *,
    connection_id: str,
    server_slug: str,
    max_resources: int = MAX_RESOURCES_PER_SERVER,
) -> tuple[list[McpResource], int]:
    """Normalize a `resources/list` payload. Returns `(kept, dropped)`.

    A malformed entry is SKIPPED, never fatal — the same rule `normalize_tools`
    follows, and for the same reason: one bad row must not cost the user every
    other resource on that server. The dropped count is returned rather than
    logged here so this module stays pure; the caller reports it.
    """
    kept: list[McpResource] = []
    dropped = 0
    seen: set[str] = set()
    for row in rows[: max(0, max_resources)]:
        try:
            resource = normalize_resource(
                row, connection_id=connection_id, server_slug=server_slug
            )
        except (ValueError, TypeError, AttributeError):
            dropped += 1
            continue
        # A server repeating a URI would otherwise give the index two entries
        # that read the same thing; first wins, matching `ToolRegistry._by_name`.
        if resource.uri in seen:
            dropped += 1
            continue
        seen.add(resource.uri)
        kept.append(resource)
    return kept, dropped + max(0, len(rows) - max(0, max_resources))


def normalize_templates(
    rows: list[Any],
    *,
    connection_id: str,
    server_slug: str,
    max_templates: int = MAX_TEMPLATES_PER_SERVER,
) -> tuple[list[McpResourceTemplate], int]:
    """Normalize a `resources/templates/list` payload. Returns `(kept, dropped)`."""
    kept: list[McpResourceTemplate] = []
    dropped = 0
    seen: set[str] = set()
    for row in rows[: max(0, max_templates)]:
        try:
            template = normalize_template(
                row, connection_id=connection_id, server_slug=server_slug
            )
        except (ValueError, TypeError, AttributeError):
            dropped += 1
            continue
        if template.uri_template in seen:
            dropped += 1
            continue
        seen.add(template.uri_template)
        kept.append(template)
    return kept, dropped + max(0, len(rows) - max(0, max_templates))
