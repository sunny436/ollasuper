"""Tier-2 ingest benchmark (live embedding provider). NOT a pytest file.

Measures each pipeline STAGE separately (parse / chunk / embed / db) across a
format matrix, and sweeps the embedding batch-size x concurrency knobs against
the real provider so the ~10-12s SLO is set from data, not guessed. Run on a box
that has OPENROUTER_API_KEY + the knowledge DB (i.e. the VM), e.g.:

  PGPASSWORD=.. TEST_DATABASE_URL=..  uv run python bench_ingest.py
  BENCH_SWEEP=1                        uv run python bench_ingest.py   # + knob sweep

It calls the stages directly (no Convex) so the numbers are the actual work:
parse -> chunk_docs_bounded -> embed_documents -> persist_ingest.
"""

from __future__ import annotations

# ruff: noqa: E501, T201  (bench script, not shipped app code)
import asyncio
import os
import sys
import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import get_settings
from app.db import store
from app.ingest import embed as embedmod
from app.ingest.chunk import chunk_docs_bounded
from app.ingest.detect import detect_type
from app.ingest.pdf import parse_pdf
from app.ingest.pipeline import _parse

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

S = get_settings()
USER = "bench-user"
LOREM = (
    "The knowledge base ingestion pipeline parses, chunks, embeds and persists "
    "documents with bounded parallelism and honest progress reporting. "
)


def _make_pdf(pages: int) -> bytes:
    """A minimal multi-page DIGITAL PDF with `pages` text pages."""
    objs: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{3 + i} 0 R" for i in range(pages))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode())
    font_obj = 3 + pages * 2
    for i in range(pages):
        content_obj = 3 + pages + i
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_obj} 0 R /Resources << /Font << /F1 {font_obj} 0 R >> >> >>".encode()
        )
    for i in range(pages):
        stream = (
            b"BT /F1 12 Tf 72 700 Td (Page "
            + str(i + 1).encode()
            + b": "
            + (LOREM * 6).encode("latin-1")[:900]
            + b") Tj ET"
        )
        objs.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += b"trailer\n<< /Size " + str(len(objs) + 1).encode() + b" /Root 1 0 R >>\nstartxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    return bytes(out)


def _fixtures() -> list[tuple[str, str, bytes]]:
    big_text = (LOREM * 4000).encode()
    csv = ("a,b,c\n" + "\n".join(f"{i},{i * 2},row{i}" for i in range(4000))).encode()
    md = ("# Title\n\n" + LOREM * 2000).encode()
    html = (b"<html><body><h1>Doc</h1><p>" + (LOREM * 2000).encode() + b"</p></body></html>")
    return [
        ("pdf", "digital100.pdf", _make_pdf(100)),
        ("text", "big.txt", big_text),
        ("csv", "big.csv", csv),
        ("markdown", "big.md", md),
        ("html", "big.html", html),
    ]


async def _bench_file(engine, name: str, ftype_hint: str, raw: bytes) -> dict:
    file_type = detect_type(raw, "application/octet-stream", name)
    t = time.monotonic()
    if file_type == "pdf":
        pdf = await parse_pdf(raw, name=name, settings=S, deadline_s=S.ai_ingest_overall_deadline_s)
        docs = pdf.docs
    else:
        docs = (await _parse(raw, file_type, name, S)).docs
    parse_ms = (time.monotonic() - t) * 1000

    t = time.monotonic()
    chunks, _trunc = chunk_docs_bounded(docs, file_type, S)
    chunk_ms = (time.monotonic() - t) * 1000

    t = time.monotonic()
    vectors = await embedmod.embed_documents(S, [c.content for c in chunks])
    embed_ms = (time.monotonic() - t) * 1000
    for c, v in zip(chunks, vectors, strict=True):
        c.embedding = v

    t = time.monotonic()
    await store.persist_ingest(
        engine, file_id=f"bench-{name}", user_id=USER, workspace_id="W",
        filename=name, mime_type="text/plain", detected_type=file_type,
        file_size=len(raw), content_hash=f"bench-{name}", parser_used=file_type,
        page_count=None, raw_bytes=raw,
        chunks=[{"chunk_index": c.chunk_index, "content": c.content, "token_count": c.token_count,
                 "page": c.page, "section": c.section, "source_metadata": c.source_metadata,
                 "embedding": c.embedding} for c in chunks],
        embedding_model=S.openrouter_embedding_model, embedding_dimensions=S.embedding_dimensions)
    db_ms = (time.monotonic() - t) * 1000
    total = parse_ms + chunk_ms + embed_ms + db_ms
    return dict(format=file_type, bytes=len(raw), chunks=len(chunks), parse_ms=parse_ms,
                chunk_ms=chunk_ms, embed_ms=embed_ms, db_ms=db_ms, total_ms=total)


async def _sweep(texts: list[str]) -> None:
    print("\n==== EMBEDDING KNOB SWEEP (batch x concurrency) ====")
    print("batch  conc   embed_ms   texts")
    for batch in (64, 128, 256):
        for conc in (1, 2, 4, 8):
            s = S.model_copy(update={"ai_ingest_embed_batch": batch, "ai_ingest_embedding_concurrency": conc})
            t = time.monotonic()
            try:
                await embedmod.embed_documents(s, texts)
                ms = (time.monotonic() - t) * 1000
                print(f"{batch:>5}  {conc:>4}   {ms:>8.0f}   {len(texts)}")
            except Exception as e:  # noqa: BLE001
                print(f"{batch:>5}  {conc:>4}   ERROR {str(e)[:40]}")


async def main() -> None:
    url = os.environ["TEST_DATABASE_URL"]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    eng = create_async_engine(url)
    async with eng.begin() as c:
        await c.execute(text("DELETE FROM files WHERE user_id = :u"), {"u": USER})

    print("==== INGEST STAGE TIMINGS (median of 2) ====")
    print("format     bytes     chunks   parse   chunk   embed     db    TOTAL")
    for ftype_hint, name, raw in _fixtures():
        runs = [await _bench_file(eng, name, ftype_hint, raw) for _ in range(2)]
        r = min(runs, key=lambda x: x["total_ms"])
        print(f"{r['format']:<9} {r['bytes']:>8}  {r['chunks']:>6}  {r['parse_ms']:>6.0f}  "
              f"{r['chunk_ms']:>5.0f}  {r['embed_ms']:>6.0f}  {r['db_ms']:>5.0f}  {r['total_ms']:>7.0f}")

    if os.environ.get("BENCH_SWEEP"):
        docs = (await _parse((LOREM * 4000).encode(), "text", "s.txt", S)).docs
        chunks, _ = chunk_docs_bounded(docs, "text", S)
        await _sweep([c.content for c in chunks])

    await eng.dispose()


asyncio.run(main())
