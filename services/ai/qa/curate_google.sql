-- Google's official MCP servers: Gmail, Calendar, Drive, Docs, Sheets, Maps.
--
-- Gmail/Calendar/Drive/Docs/Sheets are NOT in the public MCP registry (only the
-- Google Cloud servers are, mapstools among them), so their catalogue rows are
-- written here rather than by the sync. Every endpoint was probed live on
-- 2026-09-13: `initialize` and `tools/list` answer without a token, `tools/call`
-- answers 401, and each publishes protected-resource metadata naming
-- https://accounts.google.com/ — so auth_kind is `oauth`. `trusted` stays false,
-- as on every curated row. Idempotent.
--
-- The OAuth client is seeded separately, per slug:
--   uv run python -m qa.seed_oauth_client <slug>
BEGIN;

INSERT INTO mcp_servers (name, title, description, status, latest_version, publisher)
VALUES
  ('com.googleapis.gmailmcp/mcp', 'Gmail',
   'Search, read, draft and organize email in Gmail.', 'active', '1.0.0', 'com.googleapis.gmailmcp'),
  ('com.googleapis.calendarmcp/mcp', 'Google Calendar',
   'List, search, create and update events in Google Calendar.', 'active', '1.0.0', 'com.googleapis.calendarmcp'),
  ('com.googleapis.drivemcp/mcp', 'Google Drive',
   'Search, read and create files in Google Drive.', 'active', '1.0.0', 'com.googleapis.drivemcp'),
  ('com.googleapis.docsmcp/mcp', 'Google Docs',
   'Read and update Google Docs.', 'active', '1.0.0', 'com.googleapis.docsmcp'),
  ('com.googleapis.sheetsmcp/mcp', 'Google Sheets',
   'Read and update values and formulas in Google Sheets.', 'active', '1.0.0', 'com.googleapis.sheetsmcp')
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_server_versions
  (server_name, version, is_latest, status, remotes, transports, auth_kind, raw)
SELECT n, '1.0.0', true, 'active',
       jsonb_build_array(jsonb_build_object('url', u, 'type', 'streamable-http')),
       '{streamable-http}', 'oauth',
       jsonb_build_object(
         'name', n, 'version', '1.0.0',
         'remotes', jsonb_build_array(jsonb_build_object('url', u, 'type', 'streamable-http')),
         'source', 'operator: official Google endpoint, not in the public registry')
FROM (VALUES
  ('com.googleapis.gmailmcp/mcp', 'https://gmailmcp.googleapis.com/mcp/v1'),
  ('com.googleapis.calendarmcp/mcp', 'https://calendarmcp.googleapis.com/mcp/v1'),
  ('com.googleapis.drivemcp/mcp', 'https://drivemcp.googleapis.com/mcp/v1'),
  ('com.googleapis.docsmcp/mcp', 'https://docsmcp.googleapis.com/mcp/v1'),
  ('com.googleapis.sheetsmcp/mcp', 'https://sheetsmcp.googleapis.com/mcp/v1')
) AS v(n, u)
ON CONFLICT (server_name, version) DO NOTHING;

INSERT INTO mcp_curated_servers
  (server_name, slug, display_name, category, transport, endpoint_url,
   auth_kind, trusted, enabled, notes, curated_by)
VALUES
  ('com.googleapis.gmailmcp/mcp', 'gmail', 'Gmail', 'email', 'streamable-http',
   'https://gmailmcp.googleapis.com/mcp/v1', 'oauth', false, true,
   'official Google; tools/call 401 without token', 'qa/curate_google.sql'),
  ('com.googleapis.calendarmcp/mcp', 'google-calendar', 'Google Calendar', 'calendar', 'streamable-http',
   'https://calendarmcp.googleapis.com/mcp/v1', 'oauth', false, true,
   'official Google; tools/call 401 without token', 'qa/curate_google.sql'),
  ('com.googleapis.drivemcp/mcp', 'google-drive', 'Google Drive', 'documents', 'streamable-http',
   'https://drivemcp.googleapis.com/mcp/v1', 'oauth', false, true,
   'official Google; tools/call 401 without token', 'qa/curate_google.sql'),
  ('com.googleapis.docsmcp/mcp', 'google-docs', 'Google Docs', 'documents', 'streamable-http',
   'https://docsmcp.googleapis.com/mcp/v1', 'oauth', false, true,
   'official Google; tools/call 401 without token', 'qa/curate_google.sql'),
  ('com.googleapis.sheetsmcp/mcp', 'google-sheets', 'Google Sheets', 'documents', 'streamable-http',
   'https://sheetsmcp.googleapis.com/mcp/v1', 'oauth', false, true,
   'official Google; tools/call 401 without token', 'qa/curate_google.sql'),
  ('com.googleapis.mapstools/mcp', 'google-maps', 'Google Maps', 'travel', 'streamable-http',
   'https://mapstools.googleapis.com/mcp', 'oauth', false, true,
   'official Google; PRM names accounts.google.com', 'qa/curate_google.sql')
ON CONFLICT (server_name) DO NOTHING;

-- mapstools came from the registry sync with auth_kind 'unknown'; record what
-- the probe established.
UPDATE mcp_server_versions SET auth_kind = 'oauth'
WHERE server_name = 'com.googleapis.mapstools/mcp' AND auth_kind = 'unknown';

COMMIT;
