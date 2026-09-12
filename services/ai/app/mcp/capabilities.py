"""What a connected server says it can do — recorded, bounded, and defanged.

Read ONCE per session open, right after initialize. Three rules shape it:

1. `instructions` IS THE PROMPT-INJECTION CHANNEL, and it is the one piece of
   initialize data that must not be kept. A server returns free text at
   handshake time, and the obvious thing to do with it -- paste it into the
   system prompt, the way a local MCP host does -- hands an arbitrary third
   party a direct line to the model, upstream of every OllaSuper instruction.
   The brief is explicit: "the model must not receive a hidden instruction
   channel from MCP metadata". So this records `instructions_present: bool` and
   DISCARDS THE TEXT. A later phase may show it to an OPERATOR; it never reaches
   a prompt in Phase 3.

2. `server_info` IS UNTRUSTED DISPLAY DATA. A server names itself, so its name
   and version are recorded for diagnostics and are never used as an identity,
   a cache key, or a de-duplication key -- `McpServerIdentity.slug` is.

3. RESOURCES AND PROMPTS ARE FLAGGED, NOT FETCHED. `resources/list` and
   `prompts/list` are never called and no prompt becomes a tool. Recording the
   capability costs nothing and is what lets Phase 5/7 build the real experience
   without a re-discovery migration; fetching would be building it now.

PURE GIVEN A CLIENT: no I/O of its own beyond reading already-negotiated
attributes, so a snapshot is testable against any object with the right shape.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

__all__ = ["CapabilitySnapshot", "snapshot_from"]

# Bounded: both are server-controlled strings that reach logs and the UI.
_MAX_NAME = 120


def _text(value: Any, limit: int = _MAX_NAME) -> str:
    if not isinstance(value, str):
        return ""
    return "".join(c for c in value if c >= " ")[:limit]


def _flag(caps: Any, name: str) -> bool:
    return getattr(caps, name, None) is not None


def _sub_flag(caps: Any, name: str, attr: str) -> bool:
    section = getattr(caps, name, None)
    return bool(getattr(section, attr, False)) if section is not None else False


@dataclass(frozen=True)
class CapabilitySnapshot:
    """One server's advertised surface at one moment."""

    protocol_version: str = ""
    server_name: str = ""
    server_version: str = ""
    has_tools: bool = False
    has_resources: bool = False
    has_prompts: bool = False
    has_logging: bool = False
    has_completions: bool = False
    tools_list_changed: bool = False
    resources_list_changed: bool = False
    prompts_list_changed: bool = False
    resources_subscribe: bool = False
    #: Whether `client.listen()` would work. It requires protocol 2026-07-28 and
    #: raises `ListenNotSupportedError` below it, so this is recorded rather
    #: than assumed -- essentially no deployed third-party server speaks it yet.
    listen_supported: bool = False
    #: THE FLAG, NEVER THE TEXT. See rule 1 in the module docstring.
    instructions_present: bool = False
    tool_count: int = 0
    #: Tools the server advertised but we refused (over the count cap, oversized
    #: schema, malformed). Surfaced so "12 tools" never silently means "12 of 900".
    tools_dropped: int = 0
    discovered_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def as_dict(self) -> dict:
        out = asdict(self)
        out["discovered_at"] = self.discovered_at.isoformat()
        return out


def snapshot_from(
    client: Any,
    *,
    tool_count: int = 0,
    tools_dropped: int = 0,
    now: datetime | None = None,
) -> CapabilitySnapshot:
    """Read an entered `Client` into a snapshot. Never raises on a hostile or
    partial server: a missing capability block reads as absent, not as a crash."""
    from mcp_types.version import MODERN_PROTOCOL_VERSIONS  # noqa: PLC0415

    caps = getattr(client, "server_capabilities", None)
    info = getattr(client, "server_info", None)
    protocol = _text(getattr(client, "protocol_version", "") or "", 40)

    # `instructions` is READ so we can record that it existed, and then goes out
    # of scope. It is deliberately not assigned to any field.
    instructions = getattr(client, "instructions", None)

    return CapabilitySnapshot(
        protocol_version=protocol,
        server_name=_text(getattr(info, "name", "")),
        server_version=_text(getattr(info, "version", "")),
        has_tools=_flag(caps, "tools"),
        has_resources=_flag(caps, "resources"),
        has_prompts=_flag(caps, "prompts"),
        has_logging=_flag(caps, "logging"),
        has_completions=_flag(caps, "completions"),
        tools_list_changed=_sub_flag(caps, "tools", "list_changed"),
        resources_list_changed=_sub_flag(caps, "resources", "list_changed"),
        prompts_list_changed=_sub_flag(caps, "prompts", "list_changed"),
        resources_subscribe=_sub_flag(caps, "resources", "subscribe"),
        listen_supported=protocol in MODERN_PROTOCOL_VERSIONS,
        instructions_present=bool(
            isinstance(instructions, str) and instructions.strip()
        ),
        tool_count=max(0, int(tool_count)),
        tools_dropped=max(0, int(tools_dropped)),
        discovered_at=now or datetime.now(UTC),
    )
