"""The curated set: which MCP servers THIS deployment will actually connect to.

WHY A SEPARATE TABLE FROM `mcp_servers`. That table's whole contract is "upstream
metadata, preserved verbatim, re-derivable from `raw`", and every sync run
upserts over it. An operator's decision -- this server, this version, this
endpoint, trusted or not -- must not live somewhere a sync overwrites. The
foreign key keeps the two consistent without mixing them.

WHY THIS TABLE EXISTS AT ALL. The catalogue holds 30,871 servers, of which
68,019 version records are stdio-only. The product targets roughly thirty
everyday-use servers. Without curation, a connect endpoint would accept any
catalogue row, which is both a product error and a security surface.

DEFAULT-CLOSED TWICE OVER, and the two flags are deliberately NOT one flag:

  `enabled`  -- may this deployment connect to it at all?
  `trusted`  -- may this server's own `readOnlyHint` be believed?

Curating a server makes it connectable. It does NOT make its self-reported
annotations credible: `normalize._side_effect` reads `trusted` to decide whether
a tool may skip the approval gate, and MCP's own spec says clients "should never
make tool use decisions based on ToolAnnotations received from untrusted
servers". Collapsing the two would mean adding a server to the menu silently
disarmed approvals for its tools.

NO CREDENTIAL COLUMN, and there never will be one. Phase 4 owns credentials, in
a vault, keyed per user -- not in a deployment-wide operator table.

ON DELETE IS DELIBERATELY NOT CASCADE. Phase 2 never hard-deletes (a removed
server becomes a tombstone), so the only way this FK could fire is an operator
mistake, and failing loudly beats silently dropping a curation decision.
"""

from __future__ import annotations

from alembic import op

revision = "0003_mcp_curated"
down_revision = "0002_mcp_catalogue"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE mcp_curated_servers (
            -- The registry's reverse-DNS identity, never a display name.
            server_name     text PRIMARY KEY REFERENCES mcp_servers(name),
            -- The short, stable slug every tool_id is namespaced with. UNIQUE
            -- because two curated servers sharing one slug would collide in
            -- ToolRegistry._by_id, which overwrites silently.
            slug            text NOT NULL UNIQUE,
            display_name    text NOT NULL,
            category        text NOT NULL,
            -- NULL means "follow the catalogue's latest_version at connect
            -- time"; a value PINS it. The connection record stores whichever
            -- version it actually used, so a catalogue change never re-points a
            -- live connection.
            pinned_version  text,
            -- Remote only. A CHECK rather than a comment: stdio must be
            -- unrepresentable here, not merely discouraged.
            transport       text NOT NULL
                              CHECK (transport IN ('streamable-http', 'sse')),
            -- The DELIBERATELY SELECTED remote. Stored rather than re-derived
            -- per connect so endpoint selection is deterministic and diffable.
            endpoint_url    text NOT NULL
                              CHECK (endpoint_url LIKE 'https://%'),
            auth_kind       text NOT NULL DEFAULT 'unknown',
            -- See the module docstring: NOT the same decision as `enabled`.
            trusted         boolean NOT NULL DEFAULT false,
            enabled         boolean NOT NULL DEFAULT false,
            notes           text,
            curated_at      timestamptz NOT NULL DEFAULT now(),
            curated_by      text
        )
    """)
    # Partial: the only hot query is "what may I connect to?", and the enabled
    # set is ~30 rows out of a catalogue of 30,871.
    op.execute(
        "CREATE INDEX mcp_curated_enabled ON mcp_curated_servers (enabled) "
        "WHERE enabled"
    )
    op.execute("CREATE INDEX mcp_curated_category ON mcp_curated_servers (category)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS mcp_curated_servers")
