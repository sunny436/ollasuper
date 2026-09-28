"""File Library: one logical file per ingest, and processing versions.

WHY THE UNIQUE CONSTRAINT GOES. `uq_files_user_hash UNIQUE (user_id,
content_hash)` made identical bytes one file per user. In the Library they are
not: "Q3-final.pdf" and "report.pdf" with the same bytes are two files with two
names, two lifecycles and two `ingestId`s, and deleting one must leave the
other retrievable. With the constraint, the second file's persist hit a unique
violation and failed forever. Identity is `files.id` (= the Convex ingestId).
A plain index keeps the (user_id, content_hash) lookup cheap.

VERSIONS. `parser_version`, `chunker_version` and `pipeline_version` record the
code that produced a file's chunks, so a later change can find what is stale
(pipeline_version below current, or a chunk's embedding_model not the current
model) and re-dispatch exactly those. NULL = produced before this migration.

Non-destructive: no row is changed or removed. Downgrade re-adds the unique
constraint only if no duplicates exist (it would otherwise fail, which is the
correct outcome — duplicates are legitimate Library data now).

Revision ID: 0006_library_identity
Revises: 0005_ingest_tombstones
"""

from __future__ import annotations

from alembic import op

revision = "0006_library_identity"
down_revision = "0005_ingest_tombstones"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE files DROP CONSTRAINT IF EXISTS uq_files_user_hash")
    op.execute(
        "CREATE INDEX IF NOT EXISTS files_user_hash ON files (user_id, content_hash)"
    )
    op.execute("ALTER TABLE files ADD COLUMN IF NOT EXISTS parser_version int")
    op.execute("ALTER TABLE files ADD COLUMN IF NOT EXISTS chunker_version int")
    op.execute("ALTER TABLE files ADD COLUMN IF NOT EXISTS pipeline_version int")


def downgrade() -> None:
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS pipeline_version")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS chunker_version")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS parser_version")
    op.execute("DROP INDEX IF EXISTS files_user_hash")
    op.execute(
        "ALTER TABLE files ADD CONSTRAINT uq_files_user_hash "
        "UNIQUE (user_id, content_hash)"
    )
