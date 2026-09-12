"""OAuth 2.1 for MCP — the SDK does the protocol, OllaSuper does the boundaries.

    storage.py   the SDK's TokenStorage, backed by the encrypted vault
    attempts.py  pending authorizations, routed by `state`
    probe.py     read-only: what auth does this server actually want?
    provider.py  construct the SDK's OAuthClientProvider for one connection
    flow.py      start / callback / disconnect orchestration
    errors.py    OAuth failure -> the existing McpErrorKind vocabulary

NO OAUTH PROTOCOL CODE LIVES HERE. PKCE, `state` generation and validation,
RFC 9207 issuer checks, Protected Resource Metadata discovery, authorization
server metadata, RFC 8707 resource indicators, dynamic client registration,
token exchange, refresh with rotation carry-forward and the 403 step-up are all
the SDK's, and were verified against a live authorization server before this
package was written. What OllaSuper owns is everything the SDK deliberately
leaves open: whose credential this is, where the ciphertext goes, and how a
browser callback arriving in a different HTTP request finds the flow that is
waiting for it.
"""
