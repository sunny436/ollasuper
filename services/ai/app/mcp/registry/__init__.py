"""The MCP server CATALOGUE — discovery, not connection.

    Official MCP Registry → client → parse → store → search → (Phase 3)

A catalogued server is not trusted, not connected, not executable and not
installed. This package answers exactly one question: *what MCP servers exist?*

Registry metadata is UNTRUSTED INPUT. It is stored, bounded and searched; it is
never fetched, executed, installed or shelled out with. In particular, no URL
appearing in registry metadata is ever requested by this package — which is why
Phase 2 adds no SSRF surface at all.
"""
