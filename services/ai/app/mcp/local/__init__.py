"""Local MCP execution through the Docker MCP Gateway.

THE ONE ARCHITECTURAL DECISION THIS PACKAGE EXISTS TO ENFORCE: OllaSuper never
starts a process, never touches the Docker daemon, and never holds a Docker
socket. The gateway is operator-run infrastructure, and OllaSuper reaches it as
an ordinary MCP client over HTTP.

That is what makes the brief's §44 (no stdio spawning), §115/§116 (no Docker
privileges for the Python process) and §173 (no second gateway) structural rather
than enforced — and it is why the AST guard in `test_mcp_session_pool.py`, which
forbids `subprocess`/`Popen`/`stdio_client` anywhere under `app/mcp`, stays GREEN
through Phase 6. The guard's own docstring says local execution "must not arrive
by accident"; this package is the deliberate arrival, and it arrives without a
single process spawn.

MEASURED, not assumed: the whole Phase 3/5 stack — session pool, actor,
`normalize_tools`, `discover_capabilities`, `McpCapabilityIndex`, `read_resource`
— works against a gateway-shaped endpoint with ONLY the endpoint guard swapped.
Nothing else in the MCP stack changes for local servers.
"""

from __future__ import annotations

__all__: list[str] = []
