"""Embeddings through OpenRouter's OpenAI-compatible /embeddings endpoint.

Verified live: the prod key reaches text-embedding-3-large (3072-dim) and honors
the `dimensions` param. Reuses the single OPENROUTER_API_KEY — no second key.
check_embedding_ctx_length=False: chunks are already token-bounded (chunk.py), and
OpenRouter proxies the request, so langchain's tiktoken re-batching would only add
work and risk.

Concurrency: langchain's aembed_documents awaits its `chunk_size` batches
SEQUENTIALLY (base.py:778 on the check_embedding_ctx_length=False path), so a
large file pays one round trip per 64-text batch. We instead fan the batches out
with a bounded semaphore — ORDER-PRESERVING (gather returns in submission order,
each batch is one API call), with langchain's own bounded retry (max_retries) as
the 429/5xx backoff. Bound = ai_ingest_embedding_concurrency, so the provider's
TPM/RPM is respected and memory stays flat.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from langchain_openai import OpenAIEmbeddings

from app.config import Settings
from app.ingest.governor import ingest_provider_gate
from app.logging import get_logger

log = get_logger(__name__)

# Called after each batch completes with (embedded_so_far, total). Awaited, so
# the caller can push throttled progress. Order of completion is arbitrary; only
# the running count is reported.
ProgressCb = Callable[[int, int], Awaitable[None]]


def build_embeddings(settings: Settings) -> OpenAIEmbeddings:
    return OpenAIEmbeddings(
        model=settings.openrouter_embedding_model,
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        dimensions=settings.embedding_dimensions,
        chunk_size=settings.ai_ingest_embed_batch,
        check_embedding_ctx_length=False,
        timeout=60.0,
        max_retries=3,  # bounded backoff on 429/5xx; no infinite retry
        default_headers={
            "HTTP-Referer": settings.openrouter_app_url,
            "X-Title": settings.openrouter_app_title,
        },
    )


async def embed_documents(
    settings: Settings,
    texts: list[str],
    *,
    progress_cb: ProgressCb | None = None,
) -> list[list[float]]:
    """Embed `texts` in the SAME order, via bounded-concurrent batch requests.

    One shared client (its httpx pool is safe for concurrent requests). Each
    batch is <= ai_ingest_embed_batch texts -> exactly one API call. gather
    preserves submission order, so concatenating the per-batch results restores
    the input order 1:1 (load-bearing: chunk_index binds a vector to its chunk).

    `progress_cb(done, total)` fires as batches complete (for truthful UI
    progress); the caller is responsible for throttling the writes it triggers.
    """
    if not texts:
        return []
    size = max(1, settings.ai_ingest_embed_batch)
    conc = max(1, settings.ai_ingest_embedding_concurrency)
    client = build_embeddings(settings)
    batches = [texts[i : i + size] for i in range(0, len(texts), size)]
    sem = asyncio.Semaphore(conc)
    total = len(texts)
    done = 0
    done_lock = asyncio.Lock()

    async def _one(sub: list[str]) -> list[list[float]]:
        nonlocal done
        # Own batch-concurrency bound AND the shared interactive-priority gate,
        # so background embedding never eats the chat's reserved provider slots.
        async with sem, ingest_provider_gate(settings):
            vecs = await client.aembed_documents(sub)
        if progress_cb is not None:
            async with done_lock:
                done += len(sub)
                current = done
            await progress_cb(current, total)
        return vecs

    log.info(
        "embedding_batches",
        extra={"texts": total, "batches": len(batches), "concurrency": conc},
    )
    results = await asyncio.gather(*(_one(b) for b in batches))
    out: list[list[float]] = []
    for r in results:
        out.extend(r)
    return out


async def embed_query(settings: Settings, text: str) -> list[float]:
    return await build_embeddings(settings).aembed_query(text)
