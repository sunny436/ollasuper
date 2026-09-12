"""MCP (Model Context Protocol) — Phases 1-3.

MCP is ANOTHER TOOL PROVIDER, not a second tool system. Everything below
`ToolSelector` — selection, policy, approval, write-ahead, retry, timeout,
result framing, recovery, streaming — is OllaSuper's existing machinery and is
reused unchanged. This package contains only what that machinery cannot do.

  Phase 1 — the foundation
    models.py       what a connection IS (never what its secrets are)
    connection.py   build an SDK client, server-initiated callbacks REFUSED
    normalize.py    MCP Tool -> ToolDefinition (pure; no I/O), and the `$defs`
                    resolution without which nested arguments go unvalidated
    errors.py       protocol failure -> a CLASSIFIED error
    adapter.py      the one-method ToolAdapter the executor already dispatches to

  Phase 2 — the catalogue
    registry/       sync, parse and search the official MCP Registry
                    (measured: 30,871 servers / 100,198 version records)

  Phase 3 — connecting
    endpoint.py     is this URL safe to dial? (reuses app/ssrf.py)
    transport.py    the FACTORY over the two remote transports' auth shapes
    status.py       recover the HTTP status the SDK discards
    credentials.py  the Phase 4 seam: connection -> headers
    session.py      live sessions: one owner task each, pooled per tenant
    capabilities.py what a server advertises (and the `instructions` it does
                    NOT get to put in front of the model)
    compat.py       what we refuse to dial, decided with no network
    lifecycle.py    the connection state machine
    registry/curated.py  which ~30 servers this deployment will connect to
    compose.py      a REQUEST-SCOPED registry + adapter map for one turn

WIRING, and its deliberate limit. `main.py` builds the session pool in its
lifespan; `routers/mcp.py` exposes connect/refresh/disconnect/status behind the
service key. `runner.py` is still UNTOUCHED: `app.state.tool_registry` is
process-global while MCP tools are per-user, so registering them there would
leak one tenant's connected-server tool names to every other. `compose.py`
builds the per-turn registry that Phase 5 will hand to the live chat turn,
along with the `dispatchPayload` field that carries a user's connections.

NO LOCAL EXECUTION ANYWHERE IN THIS PACKAGE. `StdioServerParameters`,
`stdio_client` and `subprocess` appear in no module here, and a test parses the
AST of every file to keep it that way — a silent import is exactly how a
"hidden fallback" arrives.
"""
