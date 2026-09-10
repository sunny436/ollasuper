"""Per-process model health, learned from real traffic.

WHY THIS EXISTS. The first cut of the capacity failover re-tried the refusing
model on EVERY model step: a five-step agentic turn paid five doomed primary
calls, and each of those is three attempts inside openai-python (it retries the
gateway's 502), so the "recovery" quietly cost more than the failure it was
recovering from. It also had nothing to say when EVERY model is exhausted — the
user waited through two full doomed calls to be told no.

Both are the same missing idea: what we learn from one failed call should apply
to the next one. Nothing here probes anything; it only remembers what production
traffic already proved.

DELIBERATELY IN-PROCESS AND TTL'd. A model that is out of weekly quota now may
have capacity in an hour, and the service is a single uvicorn worker, so a dict
is the whole mechanism. Losing it on restart is correct — a restart is exactly
when a stale belief should be dropped.
"""

from __future__ import annotations

import time

from app.logging import get_logger

log = get_logger(__name__)

# model -> monotonic deadline after which we try it again.
_exhausted: dict[str, float] = {}
# Models whose tool-call DELTAS break langchain's accumulator. Not time-bound:
# this is a property of the gateway's serialization for that model, not a
# transient condition, so one observation holds for the life of the process.
_stream_broken: set[str] = set()


def mark_exhausted(model: str, ttl_s: float) -> None:
    """Record that the provider refused this model for capacity."""
    if not model:
        return
    first = model not in _exhausted or _exhausted[model] <= time.monotonic()
    _exhausted[model] = time.monotonic() + max(1.0, ttl_s)
    if first:
        log.warning("model.marked_exhausted", extra={"model": model, "ttl_s": ttl_s})


def mark_hard_failure(model: str, ttl_s: float) -> None:
    """Record a NON-capacity provider failure (5xx, expired upstream credential).

    Separate from mark_exhausted only in how long it is believed. A weekly quota
    resets; an upstream whose credential expired does not, and two catalogue
    models were answering 502 that way during the routing benchmark. Believing a
    hard failure for the same short window as a quota refusal means a real user
    pays for re-learning it every TTL.
    """
    mark_exhausted(model, ttl_s)


def is_exhausted(model: str) -> bool:
    """True while this model is believed to be refusing for capacity."""
    until = _exhausted.get(model)
    if until is None:
        return False
    if time.monotonic() >= until:
        # Expired: forget it so the next turn probes the real provider again,
        # which is how a recovered model comes back without a restart.
        _exhausted.pop(model, None)
        return False
    return True


def mark_stream_broken(model: str) -> None:
    """Record that streaming tool-call deltas from this model cannot be
    accumulated, so later steps skip straight to the non-streaming client."""
    if model and model not in _stream_broken:
        _stream_broken.add(model)
        log.warning("model.stream_tool_calls_broken", extra={"model": model})


def streams_tool_calls_cleanly(model: str) -> bool:
    return model not in _stream_broken


def reset() -> None:
    """Tests only — the singletons are module state by design."""
    _exhausted.clear()
    _stream_broken.clear()
