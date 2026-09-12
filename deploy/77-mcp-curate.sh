#!/usr/bin/env bash
# 76-mcp-curate.sh — seed a SMALL DEVELOPMENT set into mcp_curated_servers.
#
# WHAT THIS IS NOT. It is not the product's curated ~30. Choosing thirty real
# servers means committing an endpoint URL and an auth kind for each into a
# security-sensitive allowlist, and neither can be verified from a machine with
# no Postgres, no registry mirror and every MCP flag off. Writing thirty
# unverified rows into an allowlist would be exactly the guess this program has
# refused since Phase 2, where `parse.py` declined to infer OAuth for the same
# reason. Real curation is Phase 8 work, done against the synced mirror with the
# probe available.
#
# WHAT IT IS. Four rows that exercise the four shapes the UI must handle, so the
# catalogue page can be developed and demonstrated against real SQL rather than
# a mock: one that needs no credential, one that will 401, one that is curated
# but disabled, and one whose upstream entry is deprecated.
#
# IT REFUSES TO RUN WITHOUT AN EXPLICIT OPT-IN. These rows name endpoints that
# do not resolve; a deployment that acquired them by accident would present a
# catalogue of servers nobody can connect to.
#
# Idempotent: every insert is ON CONFLICT DO UPDATE, so re-running converges.
set -euo pipefail

if [[ "${MCP_SEED_DEV_CATALOGUE:-}" != "1" ]]; then
  echo "76-mcp-curate: skipped (set MCP_SEED_DEV_CATALOGUE=1 to seed the dev catalogue)"
  exit 0
fi

DB_URL="${KNOWLEDGE_DATABASE_URL:-}"
if [[ -z "$DB_URL" ]]; then
  echo "76-mcp-curate: KNOWLEDGE_DATABASE_URL is not set" >&2
  exit 1
fi

# `mcp_curated_servers.server_name` REFERENCES `mcp_servers(name)`, so the
# catalogue rows have to exist first. In production they arrive from the
# registry sync; here they are written explicitly, which also gives the cards
# their titles and descriptions.
psql "$DB_URL" <<'SQL'
BEGIN;

INSERT INTO mcp_servers (name, title, description, status, latest_version, publisher)
VALUES
  ('dev.ollasuper/echo',    'Echo',    'A no-credential test server that echoes what it is given.', 'active',     '1.0.0', 'OllaSuper'),
  ('dev.ollasuper/notes',   'Notes',   'Read and write short notes. Requires you to sign in.',      'active',     '1.0.0', 'OllaSuper'),
  ('dev.ollasuper/staging', 'Staging', 'Curated but switched off on this deployment.',              'active',     '1.0.0', 'OllaSuper'),
  ('dev.ollasuper/legacy',  'Legacy',  'Upstream marked this server deprecated.',                   'deprecated', '0.9.0', 'OllaSuper')
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  latest_version = EXCLUDED.latest_version,
  publisher = EXCLUDED.publisher,
  last_synced_at = now();

-- `trusted` STAYS FALSE ON EVERY ROW. It is the second, separate decision: it
-- governs whether a server's own `readOnlyHint` may skip the approval gate, and
-- no development fixture has earned that. `enabled` is what makes a server
-- connectable; conflating the two would silently disarm approvals.
INSERT INTO mcp_curated_servers
  (server_name, slug, display_name, category, transport, endpoint_url,
   auth_kind, trusted, enabled, notes, curated_by)
VALUES
  ('dev.ollasuper/echo',    'dev-echo',    'Echo',    'developer',    'streamable-http',
   'https://echo.dev.invalid/mcp',    'none',    false, true,
   'dev fixture: connects with no credential', 'deploy/76-mcp-curate.sh'),
  ('dev.ollasuper/notes',   'dev-notes',   'Notes',   'productivity', 'streamable-http',
   'https://notes.dev.invalid/mcp',   'unknown', false, true,
   'dev fixture: 401s, so the runtime OAuth discovery path is exercised', 'deploy/76-mcp-curate.sh'),
  ('dev.ollasuper/staging', 'dev-staging', 'Staging', 'developer',    'streamable-http',
   'https://staging.dev.invalid/mcp', 'none',    false, false,
   'dev fixture: curated but disabled', 'deploy/76-mcp-curate.sh'),
  ('dev.ollasuper/legacy',  'dev-legacy',  'Legacy',  'other',        'streamable-http',
   'https://legacy.dev.invalid/mcp',  'none',    false, true,
   'dev fixture: upstream deprecated', 'deploy/76-mcp-curate.sh')
ON CONFLICT (server_name) DO UPDATE SET
  slug = EXCLUDED.slug,
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  transport = EXCLUDED.transport,
  endpoint_url = EXCLUDED.endpoint_url,
  auth_kind = EXCLUDED.auth_kind,
  trusted = EXCLUDED.trusted,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  curated_by = EXCLUDED.curated_by;

COMMIT;
SQL

echo "76-mcp-curate: seeded 4 development rows (3 enabled, 1 disabled)"
echo "76-mcp-curate: these are FIXTURES. Real curation is Phase 8."
