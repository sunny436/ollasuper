"""The local MCP bridge: a SEPARATE process from the AI plane.

It lives outside `app/mcp/` on purpose. `test_mcp_session_pool.py` asserts
that no module in the MCP package can spawn a local process, and that stays
true: this package is what spawns the container, and it runs as its own
systemd unit with its own privileges (the Docker socket), never inside the
plane.
"""
