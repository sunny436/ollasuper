"""Hybrid retrieval indexes: FTS + pg_trgm for keyword / exact-ID search.

Revision ID: 0002_hybrid_indexes
Revises: 0001_knowledge_init

Adds two GIN indexes on file_chunks.content so the keyword retrieval path is
index-accelerated: an FTS index (natural-language words/phrases) and a pg_trgm
index (exact IDs, numbers, codes, filenames — where both vector search and FTS
are weak). Additive + reversible; the vector path is untouched.

Plain (non-CONCURRENT) CREATE INDEX on purpose: the knowledge table is small and
migrations run inside a transaction under the async env (env.py run_sync), where
CONCURRENTLY + autocommit_block is fragile. The brief write lock is milliseconds
on this table. 2-arg to_tsvector('english', ...) is IMMUTABLE — required for a
functional index and the query must use the same 2-arg form to hit it.
"""

from __future__ import annotations

from alembic import op

revision = "0002_hybrid_indexes"
down_revision = "0001_knowledge_init"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("""
        CREATE INDEX IF NOT EXISTS file_chunks_content_fts
        ON file_chunks USING gin (to_tsvector('english', content))
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS file_chunks_content_trgm
        ON file_chunks USING gin (content gin_trgm_ops)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS file_chunks_content_trgm")
    op.execute("DROP INDEX IF EXISTS file_chunks_content_fts")
