"""Deletion tombstones for ingestion (audit F-13).

THE RACE. `DELETE /v1/ingest/{id}` removed the current rows, but an ingestion
already running for that id kept going: it had fetched the bytes before the
delete and wrote them (and every chunk + embedding) back afterwards. The delete
answered success, the Convex row was gone, and the resurrected document had no
cleanup handle left anywhere.

A process-local cancel cannot close that — a restarted or retried worker has no
memory of it. So deletion writes a DURABLE row here, under the same per-file
advisory lock persistence takes, and persistence refuses to commit for any id
that has one. Whichever transaction takes the lock second sees the other's
outcome: delete-then-persist finds the tombstone; persist-then-delete is
deleted.

Ingest ids are random per upload and never reused, so a tombstone never blocks
a legitimate later ingestion. Rows are tiny (id + timestamp).

Revision ID: 0005_ingest_tombstones
Revises: 0004_mcp_local
"""

from __future__ import annotations

from alembic import op

revision = "0005_ingest_tombstones"
down_revision = "0004_mcp_local"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS ingest_tombstones (
            file_id     text PRIMARY KEY,
            deleted_at  timestamptz NOT NULL DEFAULT now()
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS ingest_tombstones")
