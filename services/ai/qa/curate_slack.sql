-- Slack's official MCP server. Not in the public registry, so its catalogue rows
-- are written here (same shape as curate_google.sql). Probed live 2026-09-13:
-- `initialize` answers 401 `missing_token` with
-- `WWW-Authenticate: Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"`,
-- the authorization server is https://mcp.slack.com (authorize at
-- slack.com/oauth/v2_user/authorize, token at slack.com/api/oauth.v2.user.access,
-- PKCE S256, no dynamic registration). `trusted` stays false. Idempotent.
--
-- Slack's own rule: "Only apps published in the Slack Marketplace and internal
-- apps can use MCP at this time; unlisted apps are prohibited." The seeded
-- client is an internal app of the operator's workspace, so members of that
-- workspace can connect; other workspaces cannot until the app is published.
--
--   uv run python -m qa.seed_oauth_client slack
BEGIN;

INSERT INTO mcp_servers (name, title, description, status, latest_version, publisher)
VALUES ('com.slack/mcp', 'Slack',
        'Search messages and channels, read conversations and post to Slack.',
        'active', '1.0.0', 'com.slack')
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_server_versions
  (server_name, version, is_latest, status, remotes, transports, auth_kind, raw)
VALUES ('com.slack/mcp', '1.0.0', true, 'active',
        '[{"url": "https://mcp.slack.com/mcp", "type": "streamable-http"}]'::jsonb,
        '{streamable-http}', 'oauth',
        '{"name": "com.slack/mcp", "version": "1.0.0", "remotes": [{"url": "https://mcp.slack.com/mcp", "type": "streamable-http"}], "source": "operator: official Slack endpoint, not in the public registry"}'::jsonb)
ON CONFLICT (server_name, version) DO NOTHING;

INSERT INTO mcp_curated_servers
  (server_name, slug, display_name, category, transport, endpoint_url,
   auth_kind, trusted, enabled, notes, curated_by)
VALUES ('com.slack/mcp', 'slack', 'Slack', 'communication', 'streamable-http',
        'https://mcp.slack.com/mcp', 'oauth', false, true,
        'official Slack; internal app of the operator workspace only until published',
        'qa/curate_slack.sql')
ON CONFLICT (server_name) DO NOTHING;

COMMIT;
