"""Tier-2 RAG semantic eval (live embeddings). NOT a pytest file.

Ingests a labeled synthetic corpus into TEST_DATABASE_URL via the REAL pipeline
(parse -> chunk_docs -> embed_documents -> persist_ingest), then scores each
query at Retrieved / Injected / Used, plus a config sweep. Run:
  PGPASSWORD=.. TEST_DATABASE_URL=.. OPENROUTER_API_KEY=.. uv run python bench_rag_eval.py
"""
from __future__ import annotations

# ruff: noqa: E501  (audit/bench script, not shipped app code)
import asyncio
import os
import sys

from langchain_core.messages import HumanMessage, SystemMessage
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.agent.context import build_system_prompt
from app.agent.llm import build_llm
from app.config import get_settings
from app.db import store
from app.ingest import embed, retrieve
from app.ingest.chunk import chunk_docs
from app.ingest.types import NormalizedDoc

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

S = get_settings()
USER = "eval-user"
FILLER = (
    "This paragraph is deliberate filler describing routine operational context "
    "with no unique identifiers whatsoever. " * 45
)

# name, type, body, [(query, [expected substrings lowercased], category, run_used)]
CORPUS = [
    ("zephyr.txt", "text",
     "Project Zephyr operations log. The launch authorization code is "
     "ZEPHYR-QX-7742, issued by mission control on the morning of the review.",
     [("What is Project Zephyr's launch authorization code?", ["zephyr-qx-7742"], "exact", True),
      ("Launch code?", ["zephyr-qx-7742"], "short", False)]),
    ("falcon.md", "markdown",
     "# Falcon Initiative\n\nThe Falcon initiative's quarterly deadline is "
     "14 March 2027; all deliverables must be complete by then.",
     [("By when does the Falcon initiative have to be finished?", ["14 march"], "semantic", True)]),
    ("config.txt", "text",
     "project = Nimbus\nowner = Priya Sharma\nstatus = greenlit\nregion = Pune",
     [("In the config file I uploaded, what exact value is in the owner field?", ["priya sharma"], "meta", True),
      ("Owner?", ["priya sharma"], "short", False)]),
    ("budget.txt", "text",
     "The board approved a budget of 88 lakh rupees for the initiative this year.",
     [("Budget?", ["88 lakh"], "short", False),
      ("How much money did the board approve?", ["88 lakh"], "semantic", False)]),
    ("sales.md", "markdown",
     "| Region | Sales |\n| --- | --- |\n| Kerala | 9931 |\n| Tamil Nadu | 5120 |\n| Karnataka | 7204 |",
     [("What were the sales for Kerala?", ["9931"], "table", False)]),
    ("orion.txt", "text",
     "La fecha limite del proyecto Orion es el 5 de diciembre de 2026.",
     [("When is the Orion project deadline?", ["diciembre"], "multilingual", False)]),
    ("vault.txt", "text",
     "Security addendum. The vault access passphrase is CRIMSON-ELEPHANT-77. "
     + FILLER
     + " For completeness, the vault itself is located in Building B, Level 3, "
     "behind the secure corridor near the loading bay.",
     [("Where is the vault located and what is its access passphrase?",
       ["crimson-elephant-77", "building b"], "multihop", False)]),
    ("reportA.txt", "text",
     "Report Alpha findings: the measured anomaly rate was 4242 incidents per million units.",
     [("What anomaly rate did Report Alpha measure?", ["4242"], "dupname", False)]),
    ("reportB.txt", "text",
     "Report Beta findings: the sustained throughput measured was 8137 messages per second.",
     [("What throughput did Report Beta measure?", ["8137"], "dupname", False)]),
    ("price_old.txt", "text",
     "As of Q1 the unit price was set to 100 USD across all regions.", []),
    ("price_new.txt", "text",
     "Updated Q3 pricing bulletin: the unit price is now 250 USD, superseding earlier figures.",
     [("What is the CURRENT unit price?", ["250"], "conflict", False)]),
]
DISPLAY = {"reportA.txt": "report.txt", "reportB.txt": "report.txt"}


async def ingest(engine, name, ftype, body, idx):
    disp = DISPLAY.get(name, name)
    docs = [NormalizedDoc(text=body, metadata={"source": disp})]
    chunks = chunk_docs(docs, "markdown" if ftype == "markdown" else "text", S)
    vecs = await embed.embed_documents(S, [c.content for c in chunks])
    for c, v in zip(chunks, vecs, strict=True):
        c.embedding = v
    await store.persist_ingest(
        engine, file_id=f"eval-{idx}", user_id=USER, workspace_id="W",
        filename=disp, mime_type="text/plain", detected_type=ftype,
        file_size=len(body), content_hash=f"eval-{idx}-h", parser_used="text",
        page_count=None, raw_bytes=body.encode(),
        chunks=[{"chunk_index": c.chunk_index, "content": c.content,
                 "token_count": c.token_count, "page": c.page, "section": c.section,
                 "source_metadata": c.source_metadata, "embedding": c.embedding}
                for c in chunks],
        embedding_model=S.openrouter_embedding_model,
        embedding_dimensions=S.embedding_dimensions)
    return len(chunks)


def hit(cands, subs):
    for i, c in enumerate(cands, 1):
        t = (c.get("content") or "").lower()
        if all(sub in t for sub in subs):
            return i, c.get("distance")
    return None, None


async def main():
    url = os.environ["TEST_DATABASE_URL"]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    eng = create_async_engine(url)
    async with eng.begin() as c:
        await c.execute(text("DELETE FROM files"))

    total_chunks = 0
    for i, (name, ftype, body, _qs) in enumerate(CORPUS):
        total_chunks += await ingest(eng, name, ftype, body, i)
    print(f"ingested {len(CORPUS)} docs -> {total_chunks} chunks")

    queries = [(name, q, subs, cat, used)
               for _n, _t, _b, qs in CORPUS for (q, subs, cat, used) in qs]

    rows = []
    for name, q, subs, cat, used in queries:
        qv = await embed.embed_query(S, q)
        cands = await store.retrieve(eng, user_id=USER, query_embedding=qv,
                                     fetch_k=20, embedding_dimensions=S.embedding_dimensions)
        rank, dist = hit(cands, subs)
        kept = await retrieve.retrieve_context(S, eng, user_id=USER, query=q)
        kept_hit = hit(kept, subs)[0] is not None
        block, _ = retrieve.render_rag_block(kept, S)
        injected = bool(kept) and all(s in block.lower() for s in subs)
        gated = len(q.strip()) < S.ai_rag_min_query_chars
        rows.append(dict(q=q, subs=subs, cat=cat, used=used, cands=cands, rank=rank,
                         dist=dist, kept_hit=kept_hit, injected=injected,
                         gated=gated, block=block))

    print("\n==== SHIPPED (floor dist<=0.65, fallback<=0.80, top_k 6, min_query 16) ====")
    print("cat          rank   dist  kept  inj  gate  query")
    for r in rows:
        ds = "  -  " if r["dist"] is None else f"{r['dist']:.3f}"
        rk = "-" if r["rank"] is None else str(r["rank"])
        print(f"{r['cat']:<12}{rk:>4}  {ds:>6}   {'Y' if r['kept_hit'] else 'N'}    "
              f"{'Y' if r['injected'] else 'N'}   {'SKIP' if r['gated'] else '-':<4}  {r['q'][:50]}")

    print("\n==== CONFIG SWEEP (recall = expected chunk survives filter) ====")
    print("floor  ceil  topk  minq   recall  short_recall")
    for floor_d, ceil_d, topk, minq in [
            (0.65, 0.80, 6, 16), (0.65, 0.80, 6, 4), (0.70, 0.85, 8, 4),
            (0.75, 0.85, 8, 4), (0.65, 0.80, 8, 8)]:
        rec = tot = short = short_tot = 0
        for r in rows:
            tot += 1
            if len(r["q"].strip()) < minq:
                survived = False
            else:
                cut = [c for c in r["cands"] if c["distance"] <= floor_d]
                if not cut and r["cands"] and r["cands"][0]["distance"] <= ceil_d:
                    cut = [r["cands"][0]]
                survived = hit(cut[:topk], r["subs"])[0] is not None
            rec += survived
            if r["cat"] == "short":
                short_tot += 1
                short += survived
        sr = short / short_tot if short_tot else 0.0
        print(f"{floor_d:>5}  {ceil_d:>4}  {topk:>4}  {minq:>4}   {rec / tot:>6.2f}   {sr:>6.2f}")

    print("\n==== USED (assembled context -> model answer contains sentinel) ====")
    llm = build_llm(S, model="google/gemini-2.5-flash-lite", streaming=False, max_tokens=300)
    for r in rows:
        if not r["used"]:
            continue
        sysp = build_system_prompt(custom=None, about=None, style=None, summary=None,
                                   summary_through_seq=0, rag=r["block"] or None)
        ans = await llm.ainvoke([SystemMessage(content=sysp), HumanMessage(content=r["q"])])
        a = (ans.content if isinstance(ans.content, str) else str(ans.content)).lower()
        ok = all(s in a for s in r["subs"])
        print(f"  {'PASS' if ok else 'FAIL'}  [{r['cat']}] {r['q'][:46]} -> {a[:55].strip()}")

    await eng.dispose()


asyncio.run(main())
