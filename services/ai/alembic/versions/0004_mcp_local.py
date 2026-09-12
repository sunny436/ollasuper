"""Phase 6: the local MCP server allowlist.

A SEPARATE TABLE FROM `mcp_curated_servers`, deliberately, and the reason is the
brief's §49: "local execution should be even more restricted than the remote
curated set" and a server may legitimately be remote-allowed and local-blocked.
Adding columns to the curated table would have made those one decision.

It also keeps the remote table's CHECK constraints intact. Those constraints —
`transport IN ('streamable-http','sse')` and `endpoint_url LIKE 'https://%'` —
are what make local execution *unrepresentable* for a remote row, and Phase 6
opens exactly one door without widening that one.

WHAT THIS TABLE DELIBERATELY CANNOT EXPRESS. There is no `privileged`, no
`network_mode`, no `bind_mounts`, no `capabilities` and no `user` column. A row
cannot request host networking or a Docker socket mount because there is nowhere
to write it — which is stronger than validating it away afterwards (§102/§130).

Revision ID: 0004_mcp_local
Revises: 0003_mcp_curated
"""

from __future__ import annotations

from alembic import op

revision = "0004_mcp_local"
down_revision = "0003_mcp_curated"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE mcp_local_servers (
            -- Shares the namespace with `mcp_curated_servers.slug`: one slug is
            -- one provider in ToolRegistry, so a local row claiming a remote
            -- row's slug would make `mcp:<slug>:<tool>` ambiguous. The overlap
            -- is refused by the validator, which can see both tables.
            slug            text PRIMARY KEY,
            display_name    text NOT NULL,
            -- The name the gateway knows this server by, passed as `--servers`.
            gateway_name    text NOT NULL,
            -- Each local server runs its OWN gateway instance on its own port.
            -- One gateway aggregates many servers behind one endpoint and the
            -- convention it uses to namespace their tool names is undocumented,
            -- so one-server-per-gateway keeps identity structural rather than
            -- dependent on parsing a string Docker never specified.
            gateway_port    integer NOT NULL
                              CHECK (gateway_port BETWEEN 1 AND 65535),
            image           text NOT NULL,
            -- PINNED, not a tag. An image that changes under the same tag must
            -- not be silently trusted. A CHECK rather than a comment so the
            -- unpinned form is unrepresentable.
            image_digest    text NOT NULL
                              CHECK (image_digest LIKE 'sha256:%'),
            -- `test` is startable only under the unsafe development flag.
            trust           text NOT NULL DEFAULT 'blocked'
                              CHECK (trust IN ('test', 'approved', 'blocked')),
            -- No 'internet' value exists to select. Restrictive by default.
            network         text NOT NULL DEFAULT 'none'
                              CHECK (network IN ('none', 'allowlist')),
            -- Hostnames only; the validator refuses addresses and CIDRs.
            network_allow   text[] NOT NULL DEFAULT '{}',
            -- OPAQUE REFERENCES, never values. The gateway resolves them from
            -- its own store at launch; OllaSuper never puts a secret here.
            secret_refs     text[] NOT NULL DEFAULT '{}',
            -- An ALLOWLIST. Nothing reaches the container unless named here,
            -- and the validator refuses anything secret-shaped even if it is.
            env_allow       text[] NOT NULL DEFAULT '{}',
            cpus            numeric NOT NULL DEFAULT 1,
            memory_mb       integer NOT NULL DEFAULT 512,
            -- Default OFF, like the curated table. Curation is two decisions:
            -- the row existing, and the row being enabled.
            enabled         boolean NOT NULL DEFAULT false,
            notes           text,
            curated_at      timestamptz NOT NULL DEFAULT now(),
            curated_by      text
        )
    """)
    # One gateway instance per port. Two rows sharing a port would silently give
    # one server another's endpoint.
    op.execute(
        "CREATE UNIQUE INDEX mcp_local_port ON mcp_local_servers (gateway_port)"
    )
    op.execute(
        "CREATE INDEX mcp_local_enabled ON mcp_local_servers (enabled) WHERE enabled"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS mcp_local_servers")
