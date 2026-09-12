"""What an MCP connection IS — deliberately not what its secrets are.

THE ONE RULE IN THIS FILE: no credential is ever stored on a config object.
`headers_provider` is a CALLABLE, so Phase 4's vault can be injected later
without changing this shape, and a config can be logged or repr'd without
leaking a token. A `str` field here would guarantee the opposite.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

# A server slug is part of every tool_id, and `_sanitize_name` (agent/executor.py)
# truncates the model-facing name at 64 chars. A long slug therefore pushes the
# DISCRIMINATING part of the name past the cut, and the model has to choose
# between tools whose names differ only after truncation. Short and strict.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,23}$")

HeadersProvider = Callable[[], Awaitable[dict[str, str]]]


class McpConfigError(ValueError):
    """A connection described in a way the foundation refuses to build."""


@dataclass(frozen=True)
class McpServerIdentity:
    """Stable internal identity for one MCP server.

    NOT the server's self-reported display name. A server names itself, and a
    name it controls must never become the key that other servers' tools are
    de-duplicated against — that is how `Server A: search` silently overwrites
    `Server B: search` in the registry's flat `_by_id` map.
    """

    slug: str
    display_name: str = ""
    # Phase 1 carries trust as a plain operator-set flag. Real trust TIERS
    # (registry-verified / community / unverified) are DEFERRED to Phase 5-6.
    # It exists now because `normalize` must not downgrade an untrusted server's
    # tool to read-only, and that decision cannot be retrofitted safely.
    trusted: bool = False

    def __post_init__(self) -> None:
        if not _SLUG_RE.match(self.slug):
            raise McpConfigError(
                f"invalid server slug {self.slug!r}: lowercase letters, digits, "
                "'_' and '-', max 24 chars, must start alphanumeric"
            )

    @property
    def provider_id(self) -> str:
        """Keys `ToolExecContext.adapters` AND `ToolRegistry.replace_provider`,
        so one server's catalogue can be swapped without touching another's."""
        return f"mcp:{self.slug}"

    def tool_id(self, tool_name: str) -> str:
        """Globally unique id for one tool on this server.

        Namespacing is mandatory, not cosmetic: `ToolRegistry._add` writes
        `self._by_id[tool.tool_id] = tool`, so two servers exposing the same
        bare tool name would silently overwrite each other.
        """
        return f"mcp:{self.slug}:{tool_name}"


@dataclass(frozen=True)
class McpConnectionConfig:
    """How to reach one MCP server. Holds NO secret material.

    `server` is handed to the SDK's `Client(server=...)`, which accepts a URL
    string, a StdioServerParameters, a Transport, or an in-process server object
    (the SDK wraps that last one itself — which is why the tests need no private
    import). Phase 3 adds a FOURTH accepted form: a zero-argument callable
    returning a fresh `Transport`.

    WHY A CALLABLE. `streamable_http_client` is an `@asynccontextmanager`, so the
    object it returns is SINGLE-USE — entering it twice raises. A pooled session
    that reconnects must therefore build a new transport each time, and a stored
    instance cannot survive the first reconnect. `build_client` calls this.

    A bare URL string is accepted by the SDK but is NOT how Phase 3 connects:
    `Client(server=<str>)` constructs the transport with no `http_client`, so it
    can carry no authentication header at all. Local stdio remains forbidden;
    spawning a process is Phase 6, behind a container boundary.
    """

    identity: McpServerIdentity
    server: Any
    # Credentials arrive through this hook, never through a stored field.
    # Phase 4 supplies a provider backed by the encrypted vault; Phase 1 leaves
    # it None (the in-process test server needs no auth).
    headers_provider: HeadersProvider | None = None
    read_timeout_seconds: float | None = 30.0
    # Applied to every ToolDefinition this connection produces, so the executor's
    # per-tool `asyncio.wait_for` has a bound even before Phase 3 tuning.
    tool_timeout_s: float = 30.0
    _extra: dict[str, Any] = field(default_factory=dict, repr=False)

    def __repr__(self) -> str:  # pragma: no cover - trivial
        # Explicit, because the default dataclass repr would render whatever a
        # future field holds. Identity and endpoint shape only; never the hook.
        return (
            f"McpConnectionConfig(slug={self.identity.slug!r}, "
            f"server={type(self.server).__name__}, "
            f"auth={'yes' if self.headers_provider else 'none'})"
        )


#: Transports Phase 3 will connect over. stdio is deliberately absent and must
#: stay that way: `Client(server=StdioServerParameters(...))` spawns a local
#: process, which the phase boundary forbids.
REMOTE_TRANSPORTS = ("streamable-http", "sse")


@dataclass(frozen=True)
class McpConnectionSpec:
    """A resolved, ready-to-dial connection — catalogue + curation + tenant.

    The bridge between what Phase 2 KNOWS about a server and what Phase 3 DOES
    with it. Every field is decided by OllaSuper (from an operator-curated row
    and a Convex-authorized connection record); none is taken from the model,
    from a request body, or from the MCP server's own self-description.

    HOLDS NO CREDENTIAL, for the same reason `McpConnectionConfig` does not: the
    resolver is called at connect time and its output goes straight into the
    HTTP client's headers, never onto a stored object.

    `version` is EXPLICIT and never mutated behind a live connection. A
    catalogue sync moving `latest_version` must not silently re-point a
    connection at a different server build.
    """

    connection_id: str
    identity: McpServerIdentity
    server_name: str
    version: str
    transport: str
    endpoint_url: str
    auth_kind: str = "unknown"
    #: WHICH ENDPOINT GUARD THIS SPEC GETS. Phase 6.
    #:
    #: A catalogue endpoint and a local-gateway endpoint are different things
    #: that happen to both be URLs, and they need OPPOSITE checks: a catalogue
    #: endpoint must be public HTTPS on a standard port, while the gateway is
    #: local infrastructure on loopback and a non-standard port. Measured, the
    #: strict guard refuses a gateway URL on three independent grounds — scheme,
    #: port and loopback — every one of which is correct for its own case.
    #:
    #: DEFAULTS TO "catalogue", deliberately. A spec that forgets to declare
    #: itself gets the STRICT guard, which is the failure direction that cannot
    #: be exploited. Only `app/mcp/local/gateway.py` ever sets "gateway", and a
    #: test asserts no other module does.
    endpoint_trust: str = "catalogue"
    #: Trusted OllaSuper context. Authoritative — the MCP server never gets a
    #: say in who is calling it.
    user_id: str = ""
    workspace_id: str = ""
    #: TCP/TLS connect bound, enforced by httpx2 on the session's own client.
    connect_timeout_s: float = 10.0
    #: Bounds EVERY protocol request on this session -- initialize, tools/list
    #: and each tool call -- because that is the only shape the SDK offers
    #: (`ClientSession._session_read_timeout_seconds`).
    #:
    #: SEPARATE PER-OPERATION TIMEOUTS ARE NOT IMPLEMENTABLE HERE, and the honest
    #: thing is to not pretend otherwise. The obvious approach --
    #: `with anyio.fail_after(...): await stack.enter_async_context(client)` --
    #: raises "Attempted to exit a cancel scope that isn't the current task's
    #: current cancel scope", because the timeout scope closes while the Client's
    #: own task group is still open on the stack. Measured, not theorised.
    request_timeout_s: float = 30.0
    #: Applied to every ToolDefinition this connection produces, so the
    #: executor's per-tool `asyncio.wait_for` has its own outer bound. This one
    #: IS independent: it lives outside the SDK entirely.
    tool_timeout_s: float = 30.0

    def __post_init__(self) -> None:
        if self.transport not in REMOTE_TRANSPORTS:
            raise McpConfigError(
                f"transport {self.transport!r} is not remote; Phase 3 connects "
                f"only over {', '.join(REMOTE_TRANSPORTS)}"
            )

    @property
    def pool_key(self) -> tuple[str, str, str]:
        """The session-pool key.

        TENANT FIRST, and both halves of it. `connection_id` alone would be
        enough only if connection resolution were infallible; including the
        authenticated user and workspace makes cross-tenant reuse impossible to
        reach even through a resolution bug, which is the one failure here that
        would be a security incident rather than an outage.
        """
        return (self.user_id, self.workspace_id, self.connection_id)

    def __repr__(self) -> str:  # pragma: no cover - trivial
        # Explicit, like McpConnectionConfig's: the endpoint is shown host-only
        # so a query string carrying a token-in-URL cannot reach a log line.
        host = self.endpoint_url.split("//", 1)[-1].split("/", 1)[0]
        return (
            f"McpConnectionSpec(slug={self.identity.slug!r}, "
            f"version={self.version!r}, transport={self.transport!r}, "
            f"host={host!r}, auth={self.auth_kind!r})"
        )
