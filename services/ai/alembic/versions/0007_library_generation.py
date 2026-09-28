"""File Library: the processing generation fence and per-file embedding model.

GENERATION. Convex names every processing attempt (userFiles.generation) and
sends it with the dispatch. `files.generation` records the attempt that wrote a
file's chunks, and persist_ingest refuses to write for an OLDER attempt — so a
slow worker the reaper gave up on, or the predecessor of a retry or re-index,
can never overwrite a newer result. NULL = written before this migration.

EMBEDDING MODEL. Each chunk already records its model; this puts it on the file
too, so "which files are stale for the current model" and "which query
embeddings does retrieval need for these files" are one indexed read of
`files` instead of a scan of every chunk. Backfilled from the chunks.

Non-destructive: two nullable columns, a backfill, one index.

Revision ID: 0007_library_generation
Revises: 0006_library_identity
"""

from __future__ import annotations

from alembic import op

revision = "0007_library_generation"
down_revision = "0006_library_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE files ADD COLUMN IF NOT EXISTS generation int")
    op.execute("ALTER TABLE files ADD COLUMN IF NOT EXISTS embedding_model text")
    op.execute(
        """
        UPDATE files f SET embedding_model = c.embedding_model
        FROM (
            SELECT DISTINCT ON (file_id) file_id, embedding_model
            FROM file_chunks ORDER BY file_id, chunk_index
        ) c
        WHERE c.file_id = f.id AND f.embedding_model IS NULL
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS files_user_model "
        "ON files (user_id, embedding_model)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS files_user_model")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS embedding_model")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS generation")
