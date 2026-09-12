"""MCP server catalogue: mcp_servers, mcp_server_versions, mcp_sync_state.

A CATALOGUE, not a connection registry. Nothing here grants trust, permission or
executability — it records what the official MCP Registry says exists, with
enough provenance to answer "where did this come from?" (Phase 2 §14).

UPSTREAM VS OURS is kept explicit. `remotes`/`packages`/`raw` are stored verbatim
as the registry published them; `transports`/`auth_kind` are DERIVED for filtering
and must never be mistaken for upstream assertions; `first_seen_at`/`last_synced_at`
are OllaSuper's own provenance. We do not present ourselves as the publisher.

IDENTITY is the registry's reverse-DNS `name` (e.g. "ac.inference.sh/mcp"), never
a display name or repository URL. Versions are a separate table keyed
(server_name, version), so two versions of one server — or two servers sharing a
tool name — cannot overwrite each other.

DELETED IS A TOMBSTONE, never a hard delete: the registry's `include_deleted` is
"always true when updated_since is provided", so an incremental sync RECEIVES
deletions, and Phase 3 may still hold a connection pinned to a version the
registry has since removed.

MEASURED, after a correction worth recording: a real full sync returned 30,871
servers / 100,198 version records / 1,002 pages in 360s. An earlier note here
said "2,600 records over 27 pages" — that came from a shell loop that mangled the
cursor encoding and stopped early. The indexes below are therefore load-bearing
at TODAY's scale, not future-proofing, and incremental sync is necessary rather
than an optimisation.
"""

from __future__ import annotations

from alembic import op

revision = "0002_mcp_catalogue"
down_revision = "0001_knowledge_init"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE mcp_servers (
            name              text PRIMARY KEY,
            title             text,
            description       text,
            -- Upstream lifecycle, verbatim: active | deprecated | deleted.
            status            text NOT NULL DEFAULT 'active',
            status_changed_at timestamptz,
            status_message    text,
            latest_version    text,
            publisher         text,
            repository_url    text,
            repository_source text,
            repository_subfolder text,
            -- OllaSuper-owned provenance (NOT upstream metadata).
            first_seen_at     timestamptz NOT NULL DEFAULT now(),
            last_synced_at    timestamptz NOT NULL DEFAULT now(),
            upstream_updated_at timestamptz,
            -- Two-argument to_tsvector: the one-argument form is STABLE, not
            -- IMMUTABLE, and Postgres refuses it in a generated column.
            search_doc        tsvector GENERATED ALWAYS AS (
                to_tsvector(
                    'english',
                    coalesce(name, '') || ' ' ||
                    coalesce(title, '') || ' ' ||
                    coalesce(description, '') || ' ' ||
                    coalesce(publisher, '')
                )
            ) STORED
        )
    """)
    op.execute("CREATE INDEX mcp_servers_search ON mcp_servers USING gin (search_doc)")
    op.execute("CREATE INDEX mcp_servers_status ON mcp_servers (status)")
    # Keyset pagination key. DESC because the catalogue is browsed newest-first,
    # and `name` breaks ties so the ordering is total (an OFFSET would drift
    # under a concurrent sync; a keyset cannot).
    op.execute(
        "CREATE INDEX mcp_servers_updated ON mcp_servers "
        "(upstream_updated_at DESC NULLS LAST, name)"
    )
    op.execute("CREATE INDEX mcp_servers_publisher ON mcp_servers (publisher)")

    op.execute("""
        CREATE TABLE mcp_server_versions (
            server_name     text NOT NULL
                              REFERENCES mcp_servers(name) ON DELETE CASCADE,
            version         text NOT NULL,
            is_latest       boolean NOT NULL DEFAULT false,
            status          text NOT NULL DEFAULT 'active',
            published_at    timestamptz,
            upstream_updated_at timestamptz,
            -- The registry serves MULTIPLE $schema revisions concurrently
            -- (2025-09-29 and 2025-12-11 both observed), so the record's own
            -- schema is stored rather than assumed.
            schema_version  text,
            -- Upstream, verbatim. The authoritative connection metadata Phase 3
            -- reads; never rewritten to match an OllaSuper assumption.
            remotes         jsonb NOT NULL DEFAULT '[]'::jsonb,
            packages        jsonb NOT NULL DEFAULT '[]'::jsonb,
            -- DERIVED for filtering only. Not upstream assertions.
            transports      text[] NOT NULL DEFAULT '{}',
            auth_kind       text NOT NULL DEFAULT 'unknown',
            -- Full upstream payload, for provenance and for re-deriving the
            -- columns above without a re-sync if the derivation changes.
            raw             jsonb NOT NULL,
            first_seen_at   timestamptz NOT NULL DEFAULT now(),
            last_synced_at  timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (server_name, version)
        )
    """)
    op.execute(
        "CREATE INDEX mcp_versions_latest ON mcp_server_versions (server_name) "
        "WHERE is_latest"
    )
    op.execute(
        "CREATE INDEX mcp_versions_transports ON mcp_server_versions "
        "USING gin (transports)"
    )
    op.execute("CREATE INDEX mcp_versions_auth ON mcp_server_versions (auth_kind)")
    op.execute("CREATE INDEX mcp_versions_status ON mcp_server_versions (status)")

    op.execute("""
        CREATE TABLE mcp_sync_state (
            source            text PRIMARY KEY,
            -- The `updated_since` value the NEXT run will use. Advanced only
            -- after a whole run succeeds, so a mid-run failure cannot skip
            -- records by moving the window forward on a partial read.
            watermark         timestamptz,
            -- Page cursor within an in-progress run. Cheap insurance: what
            -- actually prevents catalogue loss is that every write is an
            -- idempotent upsert, so a replay is free.
            cursor            text,
            last_attempt_at   timestamptz,
            last_success_at   timestamptz,
            last_error        text,
            fetched           bigint NOT NULL DEFAULT 0,
            inserted          bigint NOT NULL DEFAULT 0,
            updated           bigint NOT NULL DEFAULT 0,
            deleted           bigint NOT NULL DEFAULT 0,
            skipped           bigint NOT NULL DEFAULT 0
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS mcp_sync_state")
    op.execute("DROP TABLE IF EXISTS mcp_server_versions")
    op.execute("DROP TABLE IF EXISTS mcp_servers")
