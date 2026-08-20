"""LLM listwise reranking over a small candidate set (reuses the OpenRouter key).

Candidate generation (vector + keyword) is recall-oriented; this is the precision
gate. A cheap model scores the fused candidates against the query and returns a
relevance ordering. It runs on TRUNCATED snippets (not full chunks) to bound
latency/cost, and NEVER raises: any failure / timeout / malformed output returns
the input order unchanged, so RAG degrades to the fused ranking.
"""

from __future__ import annotations

import json
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.llm import build_llm
from app.config import Settings
from app.logging import get_logger

log = get_logger(__name__)

_SYS = (
    "You rank passages by how well they answer the user's question. "
    "Return ONLY a JSON array of passage numbers, most relevant first, omitting "
    "clearly irrelevant passages. Example: [3,1,5]. No prose, no other text."
)


def _snippet(text: str, max_tokens: int) -> str:
    return text[: max_tokens * 4].strip()  # ~4 chars/token, cheap cap


def _parse_order(raw: str, n: int) -> list[int] | None:
    """Extract a JSON array of 1-based passage numbers; keep valid, in-range,
    de-duplicated. None on anything unparseable."""
    m = re.search(r"\[[\s\d,]*\]", raw)
    if not m:
        return None
    try:
        arr = json.loads(m.group(0))
    except (json.JSONDecodeError, ValueError):
        return None
    out: list[int] = []
    seen: set[int] = set()
    for x in arr:
        if isinstance(x, int) and 1 <= x <= n and x not in seen:
            seen.add(x)
            out.append(x)
    return out or None


async def rerank(
    settings: Settings,
    query: str,
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Reorder `candidates` by LLM-judged relevance. Returns the input unchanged
    on any problem (safe fallback). Caller still applies top_k + its own deadline."""
    if len(candidates) < 2:
        return candidates
    subset = candidates[: settings.ai_rag_rerank_candidates]
    stoks = settings.ai_rag_rerank_snippet_tokens
    listing = "\n".join(
        f"[{i}] {_snippet(str(c.get('content') or ''), stoks)}"
        for i, c in enumerate(subset, start=1)
    )
    try:
        llm = build_llm(
            settings,
            model=settings.ai_rag_rerank_model,
            streaming=False,
            max_tokens=200,
        )
        msg = await llm.ainvoke(
            [
                SystemMessage(content=_SYS),
                HumanMessage(content=f"Question: {query}\n\nPassages:\n{listing}"),
            ]
        )
        raw = msg.content if isinstance(msg.content, str) else str(msg.content)
        order = _parse_order(raw, len(subset))
        if not order:
            return candidates
        # Ranked subset first, then any subset item the model dropped (fused order),
        # then the untouched tail beyond ai_rag_rerank_candidates.
        ranked = [subset[i - 1] for i in order]
        picked = set(order)
        ranked += [subset[i] for i in range(len(subset)) if (i + 1) not in picked]
        return ranked + candidates[settings.ai_rag_rerank_candidates :]
    except Exception:  # noqa: BLE001 - rerank is best-effort; never break RAG
        log.warning("rerank_skipped")
        return candidates
