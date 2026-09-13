-- Eight more official remote MCP servers, none in the public registry, each
-- probed live on 2026-09-13 before curation (same rule as curate_google.sql):
-- `initialize` answered 401 with a protected-resource document, or 200 for the
-- open AWS Knowledge server. `trusted` stays false everywhere. Idempotent.
--
-- Dynamic client registration (no operator credentials needed), proven by a real
-- OAuth start on production: Canva, Sentry, ClickUp. Pre-registered client
-- required (seed with `qa/seed_oauth_client.py <slug>` once the operator has
-- one): HubSpot, Box, and Asana (its DCR rejects our redirect URI). Dropbox
-- refuses registration to anyone but its pre-registered MCP partners. AWS
-- Knowledge needs no sign-in.
BEGIN;

INSERT INTO mcp_servers (name, title, description, status, latest_version, publisher)
VALUES
  ('com.asana/mcp', 'Asana', 'Search, read and update tasks and projects in Asana.', 'active', '1.0.0', 'com.asana'),
  ('com.canva/mcp', 'Canva', 'Find, create and edit designs in Canva.', 'active', '1.0.0', 'com.canva'),
  ('dev.sentry/mcp', 'Sentry', 'Search issues, errors and traces in Sentry.', 'active', '1.0.0', 'dev.sentry'),
  ('com.clickup/mcp', 'ClickUp', 'Read and manage tasks, docs and spaces in ClickUp.', 'active', '1.0.0', 'com.clickup'),
  ('com.dropbox/mcp', 'Dropbox', 'Search and read files in Dropbox.', 'active', '1.0.0', 'com.dropbox'),
  ('com.hubspot/mcp', 'HubSpot', 'Search and update contacts, companies and deals in HubSpot.', 'active', '1.0.0', 'com.hubspot'),
  ('com.box/mcp', 'Box', 'Search, read and manage files in Box.', 'active', '1.0.0', 'com.box'),
  ('com.amazonaws.knowledge/mcp', 'AWS Knowledge', 'Search and read AWS documentation, regions and best practices.', 'active', '1.0.0', 'com.amazonaws')
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_server_versions
  (server_name, version, is_latest, status, remotes, transports, auth_kind, raw)
SELECT n, '1.0.0', true, 'active',
       jsonb_build_array(jsonb_build_object('url', u, 'type', 'streamable-http')),
       '{streamable-http}', a,
       jsonb_build_object('name', n, 'version', '1.0.0',
         'remotes', jsonb_build_array(jsonb_build_object('url', u, 'type', 'streamable-http')),
         'source', 'operator: official vendor endpoint, not in the public registry')
FROM (VALUES
  ('com.asana/mcp', 'https://mcp.asana.com/mcp', 'oauth'),
  ('com.canva/mcp', 'https://mcp.canva.com/mcp', 'oauth'),
  ('dev.sentry/mcp', 'https://mcp.sentry.dev/mcp', 'oauth'),
  ('com.clickup/mcp', 'https://mcp.clickup.com/mcp', 'oauth'),
  ('com.dropbox/mcp', 'https://mcp.dropbox.com/mcp', 'oauth'),
  ('com.hubspot/mcp', 'https://mcp.hubspot.com/', 'oauth'),
  ('com.box/mcp', 'https://mcp.box.com/mcp', 'oauth'),
  ('com.amazonaws.knowledge/mcp', 'https://knowledge-mcp.global.api.aws', 'none')
) AS v(n, u, a)
ON CONFLICT (server_name, version) DO NOTHING;

INSERT INTO mcp_curated_servers
  (server_name, slug, display_name, category, transport, endpoint_url,
   auth_kind, trusted, enabled, notes, curated_by)
VALUES
  ('com.asana/mcp', 'asana', 'Asana', 'productivity', 'streamable-http', 'https://mcp.asana.com/mcp', 'oauth', false, true, 'official; DCR rejects our redirect URI — needs an Asana-registered OAuth app client seeded', 'qa/curate_more.sql'),
  ('com.canva/mcp', 'canva', 'Canva', 'documents', 'streamable-http', 'https://mcp.canva.com/mcp', 'oauth', false, true, 'official; DCR', 'qa/curate_more.sql'),
  ('dev.sentry/mcp', 'sentry', 'Sentry', 'developer', 'streamable-http', 'https://mcp.sentry.dev/mcp', 'oauth', false, true, 'official; DCR', 'qa/curate_more.sql'),
  ('com.clickup/mcp', 'clickup', 'ClickUp', 'productivity', 'streamable-http', 'https://mcp.clickup.com/mcp', 'oauth', false, true, 'official; DCR', 'qa/curate_more.sql'),
  ('com.dropbox/mcp', 'dropbox', 'Dropbox', 'documents', 'streamable-http', 'https://mcp.dropbox.com/mcp', 'oauth', false, true, 'official; DCR refused: Dropbox allows only pre-registered MCP trusted partners', 'qa/curate_more.sql'),
  ('com.hubspot/mcp', 'hubspot', 'HubSpot', 'business', 'streamable-http', 'https://mcp.hubspot.com/', 'oauth', false, true, 'official; NO DCR — needs a HubSpot public app client seeded', 'qa/curate_more.sql'),
  ('com.box/mcp', 'box', 'Box', 'documents', 'streamable-http', 'https://mcp.box.com/mcp', 'oauth', false, true, 'official; NO DCR — needs a Box OAuth 2.0 app client seeded', 'qa/curate_more.sql'),
  ('com.amazonaws.knowledge/mcp', 'aws-knowledge', 'AWS Knowledge', 'developer', 'streamable-http', 'https://knowledge-mcp.global.api.aws', 'none', false, true, 'official AWS docs server; no sign-in', 'qa/curate_more.sql')
ON CONFLICT (server_name) DO NOTHING;

COMMIT;
