-- Operator trust for the vendor-official remote MCP servers, 2026-09-15.
--
-- WHAT `trusted` NOW MEANS (audit H-05). Since normalize.py's fix, a tool runs
-- without a human approval ONLY when BOTH hold: the server declares it
-- `readOnlyHint: true`, AND an operator marked the server trusted here. An
-- untrusted server's tools ask on every call, whatever its annotations say; a
-- trusted server's WRITES still ask. So this file is the whole allowlist of
-- "whose read-only claims we believe", and every row below was reviewed:
--
--   * the endpoint is on the vendor's own domain, verified by live probe when
--     it was curated (curate_google.sql / curate_slack.sql / curate_more.sql /
--     the everyday-set commits), so the annotations come from the party that
--     owns the data;
--   * the operator connected and exercised the server on production (Google x6,
--     GitHub, Slack) or the vendor documents its tool annotations.
--
-- DELIBERATELY NOT TRUSTED (reads ask): aggregators that front other vendors'
-- APIs (klavis, context7, exa), and servers not yet connected and reviewed on
-- this deployment (algolia, hubspot, box, asana, dropbox, elevenlabs, zoom x4).
-- Flip one here only after connecting it and reading its tool list.
--
-- Idempotent; re-runnable. `notes` is appended, not replaced, so the original
-- curation note survives.
BEGIN;

UPDATE mcp_curated_servers
SET trusted = true,
    notes = COALESCE(notes, '') || ' | trusted 2026-09-15: vendor-official endpoint, declared reads run unasked, writes ask'
WHERE enabled
  AND trusted = false
  AND slug IN (
    'gmail', 'google-calendar', 'google-docs', 'google-drive', 'google-maps', 'google-sheets',
    'github', 'slack', 'notion', 'linear', 'atlassian', 'clickup', 'canva', 'sentry',
    'stripe', 'paypal', 'zapier', 'make', 'airtable', 'figma', 'miro', 'todoist', 'monday',
    'gitlab', 'vercel', 'supabase', 'grafana', 'circleci', 'newrelic', 'honeycomb',
    'posthog', 'amplitude', 'bitly', 'jotform', 'webflow', 'wix', 'fireflies', 'egnyte',
    'huggingface', 'apify', 'cloudflare', 'ms-learn', 'aws-knowledge', 'mux'
  );

-- Explicitly untrusted, stated so a later "why does X ask every time" has an
-- answer in the row itself.
UPDATE mcp_curated_servers
SET notes = COALESCE(notes, '') || ' | untrusted 2026-09-15: every call asks until connected and reviewed'
WHERE enabled
  AND trusted = false
  AND slug IN (
    'klavis', 'context7', 'exa', 'algolia', 'hubspot', 'box', 'asana', 'dropbox',
    'elevenlabs', 'zoom-chat', 'zoom-meetings', 'zoom-tasks', 'zoom-workspace'
  )
  AND COALESCE(notes, '') NOT LIKE '%untrusted 2026-09-15%';

COMMIT;
