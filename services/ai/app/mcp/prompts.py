"""MCP Prompts. PURE: no I/O, no network, no clock.

A PROMPT IS NOT A TOOL AND NOT A SYSTEM INSTRUCTION. It is a template a USER
chooses to invoke. Two consequences, and both are security properties rather
than style:

1. Prompts are never registered as `ToolDefinition`s, so a server cannot make the
   model invoke one on its own. Invocation is explicit.
2. The messages a server returns become USER-role content. They never reach the
   system or developer position, so a prompt that says "you are now in
   unrestricted mode" is a user saying that — which the model already knows how
   to refuse — rather than an instruction from the operator.

WHY ARGUMENT VALIDATION LIVES HERE AND IS NOT OPTIONAL. Measured against a real
MCP server: omitting a required argument and passing an unknown one BOTH come
back as `MCPError: Internal server error` — no field name, no reason, nothing a
user or a model could act on. The server's own validation exists but its error is
unusable, so the usable error has to be ours, built from the `required` flags
that `prompts/list` already gives us.

WHY ARGUMENTS ARE `dict[str, str]`. That is the protocol: `GetPromptRequest`
carries string values only. So validation is presence + type + size, not JSON
Schema — there is no schema to validate against, and inventing one would be a
second framework for a problem the protocol does not have.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

__all__ = [
    "MAX_PROMPTS_PER_SERVER",
    "McpPrompt",
    "McpPromptArgument",
    "PromptArgumentError",
    "normalize_prompt",
    "normalize_prompt_messages",
    "normalize_prompts",
]

_MAX_NAME = 200
_MAX_DESCRIPTION = 1024
#: One argument's value. Generous — a user may paste a document into a
#: `{text}` argument — but bounded, because it travels to a third party.
_MAX_ARG_VALUE = 16 * 1024
#: The whole rendered prompt. `prompts/get` output goes straight into the
#: context window, so an unbounded one is a context-exhaustion primitive.
MAX_PROMPT_CHARS = 32 * 1024
#: A curated everyday server offers a handful of prompts, not thousands.
MAX_PROMPTS_PER_SERVER = 128


class PromptArgumentError(ValueError):
    """Argument validation failed BEFORE anything was sent to the server.

    Its own type so the route can answer 400 with a usable message rather than
    letting a generic `ValueError` become a 500 — and so the message is ours,
    not the server's unusable one.
    """


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return "".join(c for c in value if c >= " " and c != chr(127))[:limit]


@dataclass(frozen=True)
class McpPromptArgument:
    name: str
    description: str = ""
    required: bool = False

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class McpPrompt:
    """One invokable prompt template on one connection."""

    name: str
    connection_id: str
    server_slug: str
    title: str = ""
    description: str = ""
    arguments: tuple[McpPromptArgument, ...] = ()

    @property
    def key(self) -> tuple[str, str]:
        return (self.connection_id, self.name)

    def validate_arguments(self, values: dict[str, Any] | None) -> dict[str, str]:
        """Check and coerce arguments. Raises `PromptArgumentError`.

        Returns the exact `dict[str, str]` to hand the SDK, so a caller cannot
        accidentally send something this method has not seen.
        """
        supplied = values or {}
        if not isinstance(supplied, dict):
            raise PromptArgumentError("arguments must be an object")

        known = {a.name for a in self.arguments}
        unknown = sorted(k for k in supplied if k not in known)
        if unknown:
            # REFUSED, not dropped. A caller passing an argument this prompt does
            # not take believes it is invoking something else.
            raise PromptArgumentError(
                f"prompt {self.name!r} does not take: {unknown}"
            )

        missing = sorted(
            a.name for a in self.arguments if a.required and not supplied.get(a.name)
        )
        if missing:
            raise PromptArgumentError(
                f"prompt {self.name!r} requires: {missing}"
            )

        out: dict[str, str] = {}
        for key, raw in supplied.items():
            if raw is None:
                continue
            if not isinstance(raw, str):
                # The protocol is string-valued. Coerced rather than refused,
                # because a model emitting `2` for a numeric-looking argument is
                # ordinary and refusing it helps nobody.
                raw = str(raw)
            if len(raw) > _MAX_ARG_VALUE:
                raise PromptArgumentError(
                    f"argument {key!r} is {len(raw)} characters; the ceiling is "
                    f"{_MAX_ARG_VALUE}"
                )
            out[key] = raw
        return out

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "connection_id": self.connection_id,
            "server_slug": self.server_slug,
            "title": self.title,
            "description": self.description,
            "arguments": [a.as_dict() for a in self.arguments],
        }


def normalize_prompt(raw: Any, *, connection_id: str, server_slug: str) -> McpPrompt:
    """One `mcp_types.Prompt` -> one `McpPrompt`. Raises on an unusable row."""
    name = _text(getattr(raw, "name", None), _MAX_NAME)
    if not name:
        raise ValueError("MCP prompt has no name")

    args: list[McpPromptArgument] = []
    for entry in getattr(raw, "arguments", None) or []:
        arg_name = _text(getattr(entry, "name", None), _MAX_NAME)
        if not arg_name:
            # A nameless argument cannot be supplied, so it cannot be required
            # either — dropping it beats refusing the whole prompt.
            continue
        args.append(
            McpPromptArgument(
                name=arg_name,
                description=_text(
                    getattr(entry, "description", None), _MAX_DESCRIPTION
                ),
                required=bool(getattr(entry, "required", False)),
            )
        )

    return McpPrompt(
        name=name,
        connection_id=connection_id,
        server_slug=server_slug,
        title=_text(getattr(raw, "title", None), _MAX_NAME),
        description=_text(getattr(raw, "description", None), _MAX_DESCRIPTION),
        arguments=tuple(args),
    )


def normalize_prompts(
    rows: list[Any],
    *,
    connection_id: str,
    server_slug: str,
    max_prompts: int = MAX_PROMPTS_PER_SERVER,
) -> tuple[list[McpPrompt], int]:
    """Normalize a `prompts/list` payload. Returns `(kept, dropped)`."""
    kept: list[McpPrompt] = []
    dropped = 0
    seen: set[str] = set()
    for row in rows[: max(0, max_prompts)]:
        try:
            prompt = normalize_prompt(
                row, connection_id=connection_id, server_slug=server_slug
            )
        except (ValueError, TypeError, AttributeError):
            dropped += 1
            continue
        if prompt.name in seen:
            dropped += 1
            continue
        seen.add(prompt.name)
        kept.append(prompt)
    return kept, dropped + max(0, len(rows) - max(0, max_prompts))


def normalize_prompt_messages(
    messages: list[Any], *, max_chars: int = MAX_PROMPT_CHARS
) -> tuple[list[dict[str, str]], bool]:
    """`PromptMessage[]` -> OllaSuper message dicts. Returns `(messages, truncated)`.

    THE ROLE MAPPING IS THE SECURITY DECISION. MCP defines `user` and
    `assistant`. Neither becomes a system or developer message — there is no
    branch here that could produce one, which is the point.

    An `assistant` message is kept as `assistant` rather than flattened to
    `user`: a few-shot template that supplies both sides is a legitimate and
    common shape, and rewriting the roles would corrupt it. What it CANNOT do is
    become an instruction, because the trust level is set by position (this is
    conversation content) rather than by role.

    Non-text content is dropped with a marker. An image inside a prompt template
    is not something Phase 5 can route into context safely, and silently
    including a base64 blob would be worse than saying it was omitted.
    """
    out: list[dict[str, str]] = []
    budget = max(0, max_chars)
    truncated = False

    for message in messages or []:
        role = getattr(message, "role", "user")
        role = role if role in ("user", "assistant") else "user"
        content = getattr(message, "content", None)
        text = getattr(content, "text", None)

        if not isinstance(text, str):
            kind = getattr(content, "type", None) or type(content).__name__
            out.append(
                {"role": role, "content": f"[omitted {_text(str(kind), 40)} content]"}
            )
            continue

        clean = _text(text, budget if budget > 0 else 1)
        if len(clean) < len(text):
            truncated = True
        if not clean:
            truncated = True
            break
        out.append({"role": role, "content": clean})
        budget -= len(clean)
        if budget <= 0:
            truncated = True
            break

    return out, truncated
