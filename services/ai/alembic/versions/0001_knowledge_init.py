"""Knowledge base: files, file_blobs, file_chunks (pgvector).

Revision ID: 0001_knowledge_init
Revises:
Create Date: 2026-08-20

The embedding dimension (3072, openai/text-embedding-3-large) is BAKED IN here.
It must match Settings.embedding_dimensions; changing the model/dimension needs a
new migration + reindex + re-embed (each chunk stores embedding_model/dimensions
so old vectors stay distinguishable). 3072 > pgvector's 2000-dim `vector` HNSW
cap, so the index is built on the `halfvec` cast (needs pgvector >= 0.7; the
tenant-filtered query needs hnsw.iterative_scan, pgvector >= 0.8).
"""

from __future__ import annotations

from alembic import op

revision = "0001_knowledge_init"
down_revision = None
branch_labels = None
depends_on = None

DIM = 3072


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.execute("""
        CREATE TABLE files (
            id            text PRIMARY KEY,
            user_id       text NOT NULL,
            workspace_id  text NOT NULL,
            original_filename text,
            mime_type     text,
            detected_type text,
            file_size     bigint,
            content_hash  text NOT NULL,
            parser_used   text,
            page_count    int,
            status        text NOT NULL,
            error         text,
            metadata      jsonb,
            created_at    timestamptz NOT NULL DEFAULT now(),
            updated_at    timestamptz,
            completed_at  timestamptz,
            CONSTRAINT uq_files_user_hash UNIQUE (user_id, content_hash)
        )
    """)
    op.execute("CREATE INDEX files_user_created ON files (user_id, created_at DESC)")

    op.execute("""
        CREATE TABLE file_blobs (
            file_id       text PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
            content_hash  text NOT NULL,
            bytes         bytea NOT NULL
        )
    """)

    op.execute(f"""
        CREATE TABLE file_chunks (
            id            bigserial PRIMARY KEY,
            file_id       text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            user_id       text NOT NULL,
            chunk_index   int NOT NULL,
            content       text NOT NULL,
            token_count   int,
            page          int,
            section       text,
            source_metadata jsonb,
            embedding     vector({DIM}) NOT NULL,
            embedding_model text NOT NULL,
            embedding_dimensions int NOT NULL,
            created_at    timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_chunk_file_idx UNIQUE (file_id, chunk_index)
        )
    """)
    # HNSW on the halfvec cast (3072 exceeds the 2000-dim vector index cap).
    op.execute(f"""
        CREATE INDEX file_chunks_embedding_hnsw ON file_chunks
        USING hnsw ((embedding::halfvec({DIM})) halfvec_cosine_ops)
        WITH (m = 16, ef_construction = 128)
    """)
    op.execute("CREATE INDEX file_chunks_user ON file_chunks (user_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS file_chunks")
    op.execute("DROP TABLE IF EXISTS file_blobs")
    op.execute("DROP TABLE IF EXISTS files")
