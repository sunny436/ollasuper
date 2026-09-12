"""One turn's view of every non-tool MCP capability, and the authorization gate
for reaching them.

WHY THIS EXISTS AT ALL, when `compose_tools` already builds a per-request tool
registry: resources and prompts are NOT tools, so they must not be in
`ToolRegistry` (§30/§39). But they need exactly what the registry provides —
per-request scope, connection-aware lookup, and a single place that decides
whether a caller may reach a thing. This is that place, for those two kinds.

THE SECURITY PROPERTY, stated once here because every method depends on it:

    the index is built ONLY from sessions this turn acquired for THIS user

so a lookup that succeeds is, by construction, a lookup the user is entitled to.
There is no `connection_id` argument taken from a model, no URI resolved against
a global table, and no fallback to "the first connection that has one". A URI or
prompt name that is not in the index is refused — not searched for elsewhere.

THAT IS ALSO THE TOCTOU ANSWER (§105). The index is a snapshot taken when the
turn started. A resource removed on the server mid-turn is still in the snapshot,
and the read fails at the server with a normal error; a resource that was NEVER
in the snapshot cannot be read at all, even if the server would serve it. Failing
closed on stale data is the direction that cannot be exploited.

NOTHING HERE IS CACHED ACROSS TURNS. Capability metadata is rediscovered per
request — measured in the plan's second pass: the SDK's response cache is
server-directed and inert against a server declaring `ttl_ms=0`, so it cannot be
the freshness mechanism even when it is enabled.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.logging import get_logger
from app.mcp.prompts import (
    MAX_PROMPTS_PER_SERVER,
    McpPrompt,
    normalize_prompts,
)
from app.mcp.resources import (
    MAX_RESOURCES_PER_SERVER,
    MAX_TEMPLATES_PER_SERVER,
    McpResource,
    McpResourceTemplate,
    normalize_resources,
    normalize_templates,
)

log = get_logger(__name__)

__all__ = ["CapabilityLookupError", "McpCapabilityIndex", "discover_capabilities"]


class CapabilityLookupError(LookupError):
    """A resource or prompt was not reachable for this caller.

    ONE error for "does not exist" and "belongs to a connection you do not have",
    deliberately — the same rule `chat/authz.ts` follows. A distinguishable
    answer would let a caller probe for other people's resource URIs.
    """


@dataclass
class _ConnectionCapabilities:
    connection_id: str
    server_slug: str
    resources: list[McpResource] = field(default_factory=list)
    templates: list[McpResourceTemplate] = field(default_factory=list)
    prompts: list[McpPrompt] = field(default_factory=list)
    #: Per-capability failure isolation (§117): `resources/list` failing must not
    #: cost this connection its prompts, and neither must cost it its tools.
    resources_error: str = ""
    prompts_error: str = ""
    dropped: int = 0


class McpCapabilityIndex:
    """Per-request lookup for resources, templates and prompts."""

    def __init__(self) -> None:
        self._by_connection: dict[str, _ConnectionCapabilities] = {}
        #: `(connection_id, uri)` and `(connection_id, name)` — never bare uri or
        #: bare name, so two servers offering the same one stay distinct (§107/§108).
        self._resources: dict[tuple[str, str], McpResource] = {}
        self._templates: dict[tuple[str, str], McpResourceTemplate] = {}
        self._prompts: dict[tuple[str, str], McpPrompt] = {}
        #: The live client for each connection, so a read goes back to the
        #: session the metadata came from. Never exposed.
        self._clients: dict[str, Any] = {}

    # ------------------------------------------------------------------ build
    def add(
        self,
        entry: _ConnectionCapabilities,
        *,
        client: Any = None,
    ) -> None:
        self._by_connection[entry.connection_id] = entry
        if client is not None:
            self._clients[entry.connection_id] = client
        for resource in entry.resources:
            self._resources[resource.key] = resource
        for template in entry.templates:
            self._templates[template.key] = template
        for prompt in entry.prompts:
            self._prompts[prompt.key] = prompt

    # ----------------------------------------------------------------- shape
    @property
    def connection_ids(self) -> list[str]:
        return list(self._by_connection)

    @property
    def has_resources(self) -> bool:
        """Whether ANY connection this turn offers a resource or template.

        The bind condition for `mcp_read_resource`: a user with no
        resource-bearing server never sees the tool, which keeps it out of the
        context budget of every turn that could not use it.
        """
        return bool(self._resources or self._templates)

    @property
    def has_prompts(self) -> bool:
        return bool(self._prompts)

    def resources(self, connection_id: str | None = None) -> list[McpResource]:
        if connection_id is None:
            return list(self._resources.values())
        entry = self._by_connection.get(connection_id)
        return list(entry.resources) if entry else []

    def templates(self, connection_id: str | None = None) -> list[McpResourceTemplate]:
        if connection_id is None:
            return list(self._templates.values())
        entry = self._by_connection.get(connection_id)
        return list(entry.templates) if entry else []

    def prompts(self, connection_id: str | None = None) -> list[McpPrompt]:
        if connection_id is None:
            return list(self._prompts.values())
        entry = self._by_connection.get(connection_id)
        return list(entry.prompts) if entry else []

    # ---------------------------------------------------------------- lookup
    def resolve_resource(self, uri: str) -> tuple[McpResource, Any]:
        """URI -> `(resource, live client)`, or `CapabilityLookupError`.

        THE AUTHORIZATION GATE FOR RESOURCE READS. A URI reaches here from the
        model, so it is untrusted input; what makes the read safe is that the
        only thing it can match is something this turn already discovered for
        this user. An unmatched URI is refused outright — never fetched, never
        guessed at, never tried against another connection.

        Exact URIs are tried first, then advertised templates: a server offering
        `mem://repo/{branch}/{path}` has authorized the shape, so a concrete URI
        matching that shape is authorized too. That is what makes templated
        resources usable without a second protocol call.
        """
        if not isinstance(uri, str) or not uri:
            raise CapabilityLookupError("no resource uri was supplied")

        for (connection_id, known), resource in self._resources.items():
            if known == uri:
                client = self._clients.get(connection_id)
                if client is None:
                    raise CapabilityLookupError("that resource is not available")
                return resource, client

        matched = self._match_template(uri)
        if matched is not None:
            template, client = matched
            return (
                McpResource(
                    uri=uri,
                    name=template.name,
                    connection_id=template.connection_id,
                    server_slug=template.server_slug,
                    description=template.description,
                    mime_type=template.mime_type,
                ),
                client,
            )

        # Same refusal for absent and unauthorized. No oracle.
        raise CapabilityLookupError("that resource is not available")

    def _match_template(
        self, uri: str
    ) -> tuple[McpResourceTemplate, Any] | None:
        """Does `uri` fit an advertised template on a connection we hold?

        Matched structurally — prefix, suffix and segment count — rather than by
        regex built from server input. A `{var}` matches exactly one path
        segment, so `mem://repo/{branch}/{path}` accepts `mem://repo/main/a` and
        REFUSES `mem://repo/main/a/b`: a variable that could swallow separators
        would let one template authorize URIs its author never offered.
        """
        for template in self._templates.values():
            if not template.fillable or not template.variables:
                continue
            pattern = template.uri_template
            literal_parts: list[str] = []
            rest = pattern
            for name in template.variables:
                marker = "{" + name + "}"
                head, sep, rest = rest.partition(marker)
                if not sep:
                    literal_parts = []
                    break
                literal_parts.append(head)
            else:
                literal_parts.append(rest)
                if self._fits(uri, literal_parts):
                    client = self._clients.get(template.connection_id)
                    if client is not None:
                        return template, client
        return None

    @staticmethod
    def _fits(uri: str, literals: list[str]) -> bool:
        """`uri` == literals[0] + <segment> + literals[1] + <segment> + ..."""
        if not literals:
            return False
        if not uri.startswith(literals[0]):
            return False
        cursor = len(literals[0])
        for literal in literals[1:-1] if len(literals) > 2 else []:
            if not literal:
                return False
            found = uri.find(literal, cursor)
            if found <= cursor:  # the variable must consume at least one char
                return False
            if "/" in uri[cursor:found]:
                return False
            cursor = found + len(literal)
        tail = literals[-1]
        if len(literals) == 1:
            return uri == literals[0]
        if tail:
            if not uri.endswith(tail):
                return False
            value = uri[cursor : len(uri) - len(tail)]
        else:
            value = uri[cursor:]
        return bool(value) and "/" not in value

    def resolve_prompt(
        self, name: str, connection_id: str | None = None
    ) -> tuple[McpPrompt, Any]:
        """Prompt name -> `(prompt, live client)`, or `CapabilityLookupError`.

        `connection_id` disambiguates when two servers offer the same prompt
        name. It is supplied by the ROUTE from Convex-verified state, never by a
        model. Omitted and ambiguous is an error, not a coin flip — silently
        choosing one server's `summarize` over another's would run the wrong
        template against the user's data.
        """
        if not isinstance(name, str) or not name:
            raise CapabilityLookupError("no prompt name was supplied")

        if connection_id is not None:
            found = self._prompts.get((connection_id, name))
            if found is None:
                raise CapabilityLookupError("that prompt is not available")
            client = self._clients.get(connection_id)
            if client is None:
                raise CapabilityLookupError("that prompt is not available")
            return found, client

        matches = [p for (_cid, n), p in self._prompts.items() if n == name]
        if not matches:
            raise CapabilityLookupError("that prompt is not available")
        if len(matches) > 1:
            raise CapabilityLookupError(
                f"{len(matches)} connected servers offer a prompt named {name!r}; "
                "name the connection to use"
            )
        client = self._clients.get(matches[0].connection_id)
        if client is None:
            raise CapabilityLookupError("that prompt is not available")
        return matches[0], client

    def as_dict(self) -> dict[str, Any]:
        """Safe projection for a route or a log. Carries no client and no session."""
        return {
            "connections": [
                {
                    "connection_id": entry.connection_id,
                    "server_slug": entry.server_slug,
                    "resources": len(entry.resources),
                    "templates": len(entry.templates),
                    "prompts": len(entry.prompts),
                    "dropped": entry.dropped,
                    "resources_error": entry.resources_error,
                    "prompts_error": entry.prompts_error,
                }
                for entry in self._by_connection.values()
            ]
        }


async def discover_capabilities(
    client: Any,
    *,
    connection_id: str,
    server_slug: str,
    snapshot: Any = None,
    max_resources: int = MAX_RESOURCES_PER_SERVER,
    max_templates: int = MAX_TEMPLATES_PER_SERVER,
    max_prompts: int = MAX_PROMPTS_PER_SERVER,
) -> _ConnectionCapabilities:
    """Ask ONE live session for its resources, templates and prompts.

    PER-CAPABILITY FAILURE ISOLATION (§117). Each list is attempted separately
    and a failure is RECORDED, never raised: a server whose `resources/list`
    throws must still contribute its prompts, and — because this runs beside
    `compose_tools` rather than inside it — must still contribute its tools. A
    server that is simply down contributes nothing and costs the turn nothing.

    `snapshot` is the Phase 3 `CapabilitySnapshot`. When it says a server
    advertises neither resources nor prompts, the corresponding calls are SKIPPED
    rather than attempted-and-failed — one fewer round trip per connection per
    turn, and no spurious error recorded against a server behaving correctly.
    """
    entry = _ConnectionCapabilities(
        connection_id=connection_id, server_slug=server_slug
    )

    wants_resources = snapshot is None or getattr(snapshot, "has_resources", True)
    wants_prompts = snapshot is None or getattr(snapshot, "has_prompts", True)

    if wants_resources:
        try:
            listed = await client.list_resources()
            resources, dropped = normalize_resources(
                list(getattr(listed, "resources", None) or []),
                connection_id=connection_id,
                server_slug=server_slug,
                max_resources=max_resources,
            )
            entry.resources = resources
            entry.dropped += dropped
        except Exception as exc:  # noqa: BLE001 — recorded, never fatal
            entry.resources_error = type(exc).__name__
            log.warning(
                "mcp.resources_list_failed",
                extra={"server": server_slug, "reason": type(exc).__name__},
            )

        try:
            listed = await client.list_resource_templates()
            templates, dropped = normalize_templates(
                list(getattr(listed, "resource_templates", None) or []),
                connection_id=connection_id,
                server_slug=server_slug,
                max_templates=max_templates,
            )
            entry.templates = templates
            entry.dropped += dropped
        except Exception as exc:  # noqa: BLE001
            # Templates are optional even for a resource server; a failure here
            # must not discard the plain resources already collected above.
            log.info(
                "mcp.resource_templates_unavailable",
                extra={"server": server_slug, "reason": type(exc).__name__},
            )

    if wants_prompts:
        try:
            listed = await client.list_prompts()
            prompts, dropped = normalize_prompts(
                list(getattr(listed, "prompts", None) or []),
                connection_id=connection_id,
                server_slug=server_slug,
                max_prompts=max_prompts,
            )
            entry.prompts = prompts
            entry.dropped += dropped
        except Exception as exc:  # noqa: BLE001
            entry.prompts_error = type(exc).__name__
            log.warning(
                "mcp.prompts_list_failed",
                extra={"server": server_slug, "reason": type(exc).__name__},
            )

    if entry.dropped:
        log.info(
            "mcp.capabilities_dropped",
            extra={"server": server_slug, "dropped": entry.dropped},
        )
    return entry
