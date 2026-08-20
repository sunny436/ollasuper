"""Embeddings through OpenRouter's OpenAI-compatible /embeddings endpoint.

Verified live: the prod key reaches text-embedding-3-large (3072-dim) and honors
the `dimensions` param. Reuses the single OPENROUTER_API_KEY — no second key.
check_embedding_ctx_length=False: chunks are already token-bounded (chunk.py), and
OpenRouter proxies the request, so langchain's tiktoken re-batching would only add
work and risk. Batched by ai_ingest_embed_batch.
"""

from __future__ import annotations

from langchain_openai import OpenAIEmbeddings

from app.config import Settings


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


async def embed_documents(settings: Settings, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    return await build_embeddings(settings).aembed_documents(texts)


async def embed_query(settings: Settings, text: str) -> list[float]:
    return await build_embeddings(settings).aembed_query(text)
