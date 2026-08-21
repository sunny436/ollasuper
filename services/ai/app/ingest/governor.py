"""Interactive-priority provider governor.

Interactive chat gets highest priority and RESERVED provider capacity; background
ingestion (embeddings + any vision-OCR fallback) uses only the remaining safe
capacity. A sustained ingest flood once exhausted the shared OpenRouter account
and queued an interactive chat's LLM request for 179 s (measured). Chat calls are
UNGATED — so they always have at least `reserve` slots available — while every
ingest provider call passes through a semaphore sized to (hard_limit - reserve).
This respects the provider's hard concurrency limit (chat + ingest <= hard_limit)
and never exceeds it. (OCR is now local, so this chiefly guards the rare vision
fallback; embeddings measured as non-starving but are gated too for safety.)
"""

from __future__ import annotations

import asyncio

from app.config import Settings

_ingest_sem: asyncio.Semaphore | None = None


def ingest_provider_gate(settings: Settings) -> asyncio.Semaphore:
    """Shared semaphore every BACKGROUND-ingest provider call must hold. Sized to
    leave `ai_provider_chat_reserve` slots free for interactive chat at all times."""
    global _ingest_sem
    if _ingest_sem is None:
        leftover = max(
            1,
            settings.ai_provider_max_concurrency - settings.ai_provider_chat_reserve,
        )
        _ingest_sem = asyncio.Semaphore(leftover)
    return _ingest_sem
