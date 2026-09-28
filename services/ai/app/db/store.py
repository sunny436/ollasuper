"""Query layer for the pgvector knowledge database.

Embeddings are bound as pgvector text literals ("[1,2,...]") with an explicit
``::vector`` / ``::halfvec`` cast, so no per-connection adapter is needed. The
vector DIMENSION is part of the SQL type, not a value, so it is interpolated as a
trusted int from config (``embedding_dimensions``), never a bind parameter.

Account isolation lives in the SQL itself: every retrieve/delete is
``WHERE user_id = :uid``. Idempotency: a per-file advisory lock serializes a
reaper re-dispatch racing an in-flight run, and chunks are delete-then-reinserted
under ``UNIQUE (file_id, chunk_index)``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


class IngestDeleted(RuntimeError):
    """The file was deleted while this ingestion was running (audit F-13).

    Raised by `persist_ingest` instead of writing: the deletion's tombstone was
    found under the same advisory lock persistence holds, so committing now
    would resurrect a document the user has already been told is gone."""


def _vec_literal(vec: Sequence[float]) -> str:
    return "[" + ",".join(format(float(x), ".8g") for x in vec) + "]"


def _advisory_key(file_id: str) -> int:
    # Stable signed 63-bit int for pg_advisory_xact_lock.
    h = hashlib.blake2b(file_id.encode(), digest_size=8).digest()
    return int.from_bytes(h, "big", signed=True)


async def persist_ingest(
    engine: AsyncEngine,
    *,
    file_id: str,
    user_id: str,
    workspace_id: str,
    filename: str | None,
    mime_type: str | None,
    detected_type: str | None,
    file_size: int | None,
    content_hash: str,
    parser_used: str | None,
    page_count: int | None,
    raw_bytes: bytes,
    chunks: list[dict[str, Any]],
    embedding_model: str,
    embedding_dimensions: int,
) -> int:
    """One transaction: files row + blob (BYTEA) + chunks. Returns chunk count."""
    dim = int(embedding_dimensions)
    async with engine.begin() as conn:
        await conn.execute(
            text("SELECT pg_advisory_xact_lock(:k)"), {"k": _advisory_key(file_id)}
        )
        # THE FENCE (audit F-13). Deletion writes its tombstone under this same
        # lock, so exactly one order is possible: either the delete ran first
        # and is visible here, or this transaction commits first and the delete
        # then removes what it wrote. A late or restarted worker is refused the
        # same way — the tombstone is durable, not process memory.
        tomb = await conn.execute(
            text("SELECT 1 FROM ingest_tombstones WHERE file_id = :id"),
            {"id": file_id},
        )
        if tomb.first() is not None:
            raise IngestDeleted(file_id)
        await conn.execute(
            text("""
                INSERT INTO files (id, user_id, workspace_id, original_filename,
                    mime_type, detected_type, file_size, content_hash, parser_used,
                    page_count, status, metadata, created_at, updated_at, completed_at)
                VALUES (:id, :uid, :wid, :fn, :mime, :dt, :sz, :ch, :pu, :pc,
                    'ready', '{}'::jsonb, now(), now(), now())
                ON CONFLICT (id) DO UPDATE SET
                    detected_type = EXCLUDED.detected_type,
                    parser_used = EXCLUDED.parser_used,
                    page_count = EXCLUDED.page_count,
                    content_hash = EXCLUDED.content_hash,
                    file_size = EXCLUDED.file_size,
                    status = 'ready', error = NULL,
                    updated_at = now(), completed_at = now()
            """),
            {
                "id": file_id, "uid": user_id, "wid": workspace_id, "fn": filename,
                "mime": mime_type, "dt": detected_type, "sz": file_size,
                "ch": content_hash, "pu": parser_used, "pc": page_count,
            },
        )
        await conn.execute(
            text("""
                INSERT INTO file_blobs (file_id, content_hash, bytes)
                VALUES (:id, :ch, :bytes)
                ON CONFLICT (file_id) DO UPDATE SET
                    content_hash = EXCLUDED.content_hash, bytes = EXCLUDED.bytes
            """),
            {"id": file_id, "ch": content_hash, "bytes": raw_bytes},
        )
        await conn.execute(
            text("DELETE FROM file_chunks WHERE file_id = :id"), {"id": file_id}
        )
        if chunks:
            params = [
                {
                    "fid": file_id, "uid": user_id, "ci": c["chunk_index"],
                    "content": c["content"], "tc": c.get("token_count"),
                    "page": c.get("page"), "section": c.get("section"),
                    "meta": json.dumps(c.get("source_metadata") or {}),
                    "emb": _vec_literal(c["embedding"]),
                    "em": embedding_model, "ed": dim,
                }
                for c in chunks
            ]
            # dim is a trusted int from config; it is the SQL TYPE size, which
            # cannot be a bind parameter — hence the f-string, never user input.
            await conn.execute(
                text(f"""
                    INSERT INTO file_chunks (file_id, user_id, chunk_index, content,
                        token_count, page, section, source_metadata, embedding,
                        embedding_model, embedding_dimensions)
                    VALUES (:fid, :uid, :ci, :content, :tc, :page, :section,
                        CAST(:meta AS jsonb), CAST(:emb AS vector({dim})), :em, :ed)
                """),
                params,
            )
    return len(chunks)


async def _tombstone(conn: Any, file_id: str) -> None:
    """Take the per-file lock and record the deletion BEFORE removing rows, in
    the caller's transaction (audit F-13 — see persist_ingest's fence)."""
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(:k)"), {"k": _advisory_key(file_id)}
    )
    await conn.execute(
        text("""
            INSERT INTO ingest_tombstones (file_id) VALUES (:id)
            ON CONFLICT (file_id) DO NOTHING
        """),
        {"id": file_id},
    )


async def delete_file(engine: AsyncEngine, *, file_id: str, user_id: str) -> bool:
    """Cascade delete (file_blobs + file_chunks via FK). Account-scoped.
    Tombstoned first, so a running ingestion cannot write it back."""
    async with engine.begin() as conn:
        await _tombstone(conn, file_id)
        res = await conn.execute(
            text("DELETE FROM files WHERE id = :id AND user_id = :uid"),
            {"id": file_id, "uid": user_id},
        )
    return (res.rowcount or 0) > 0


async def delete_by_id(engine: AsyncEngine, *, file_id: str) -> bool:
    """Cascade delete by id only. For the Convex purge path, which is
    service-key-authenticated and already capability-scoped by the ingestId.
    Tombstoned first, so a running ingestion cannot write it back."""
    async with engine.begin() as conn:
        await _tombstone(conn, file_id)
        res = await conn.execute(
            text("DELETE FROM files WHERE id = :id"), {"id": file_id}
        )
    return (res.rowcount or 0) > 0


async def retrieve(
    engine: AsyncEngine,
    *,
    user_id: str,
    query_embedding: Sequence[float],
    fetch_k: int,
    embedding_dimensions: int,
    embedding_model: str | None = None,
    file_ids: list[str] | None = None,
    ef_search: int = 100,
    iterative_scan: str = "relaxed_order",
) -> list[dict[str, Any]]:
    """Account-scoped top-fetch_k by cosine distance. The ORDER BY expression is
    byte-identical to the index expression, or the planner drops to a seq-scan.

    When ``embedding_model`` is given, only vectors from that model are compared —
    cosine distance across DIFFERENT embedding models is meaningless, so a model
    swap must not silently return stale vectors (dimension is already pinned by
    the column type; model is the only thing not enforced by the schema).

    A TOMBSTONED file never surfaces, whatever the scope says: deletion writes the
    tombstone before its rows go, so a turn that was dispatched before the delete
    (and so still lists the file) cannot retrieve it once the purge has begun."""
    dim = int(embedding_dimensions)
    ef = int(ef_search)
    _valid = {"relaxed_order", "strict_order", "off"}
    scan = iterative_scan if iterative_scan in _valid else "relaxed_order"
    # Fixed literals, never user input (like `dim`); every value stays a bind.
    model_clause = "AND embedding_model = :model" if embedding_model else ""
    # Optional per-file narrowing. ALWAYS under the user_id clause, so it can only
    # restrict WITHIN the caller's own corpus — a foreign/invalid file_id simply
    # matches nothing. `= ANY(:fids)` binds a Python list as a text[] array
    # (psycopg3), so file ids stay parameterized.
    #
    # THREE STATES, and they must never collapse into two:
    #
    #   None  -> no narrowing. The caller's whole corpus. (No longer sent by
    #            Convex, which always spells the scope out — kept for callers
    #            that pass nothing.)
    #   []    -> narrow to NOTHING. Return no rows.        (A Project with no files.)
    #   [ids] -> narrow to exactly those ids.               (A Project with files.)
    #
    # This used to read `if file_ids`, which is FALSY FOR AN EMPTY LIST — so an
    # empty scope emitted no clause at all and silently returned the user's entire
    # corpus. Harmless while nothing passed `[]`; a cross-Project data leak the
    # moment Project scope is expressed as a list of files.
    #
    # The empty case returns before touching SQL rather than relying on
    # `= ANY(ARRAY[]::text[])`: an empty Python list gives psycopg3 no element
    # type to infer, so leaving it to the driver risks an error where the whole
    # point is a guaranteed empty result. Explicit beats clever for the one
    # branch whose failure mode is a silent leak.
    if file_ids is not None and not file_ids:
        return []
    file_clause = "AND file_id = ANY(:fids)" if file_ids is not None else ""
    params: dict[str, Any] = {
        "uid": user_id,
        "qvec": _vec_literal(query_embedding),
        "k": int(fetch_k),
    }
    if embedding_model:
        params["model"] = embedding_model
    # Same rule as the clause above, so removing the early return could never
    # silently resurrect the leak by leaving the clause bound to nothing.
    if file_ids is not None:
        params["fids"] = list(file_ids)
    async with engine.begin() as conn:
        await conn.execute(text(f"SET LOCAL hnsw.ef_search = {ef}"))
        await conn.execute(text(f"SET LOCAL hnsw.iterative_scan = {scan}"))
        rows = (
            await conn.execute(
                text(f"""
                    SELECT file_id, content, source_metadata, page, section,
                        embedding::halfvec({dim}) <=> CAST(:qvec AS halfvec({dim}))
                        AS distance
                    FROM file_chunks
                    WHERE user_id = :uid {model_clause} {file_clause}
                      AND NOT EXISTS (
                          SELECT 1 FROM ingest_tombstones t
                          WHERE t.file_id = file_chunks.file_id
                      )
                    ORDER BY embedding::halfvec({dim})
                        <=> CAST(:qvec AS halfvec({dim}))
                    LIMIT :k
                """),
                params,
            )
        ).mappings().all()
    return [dict(r) for r in rows]
