"""Per-process model health registry, learned from real traffic AND background probes.

WHY THIS EXISTS. The first cut of the capacity failover re-tried the refusing
model on EVERY model step: a five-step agentic turn paid five doomed primary
calls, and each of those is three attempts inside openai-python (it retries the
gateway's 502), so the "recovery" quietly cost more than the failure it was
recovering from. It also had nothing to say when EVERY model is exhausted — the
user waited through two full doomed calls to be told no.

WHY IT GREW INTO A REGISTRY. A TTL dict fed only by failures inside user turns
never re-checked anything, never recorded success, and did not know that two
models share one upstream quota: deepseek-v4-flash and gpt-oss-120b both sit on
`ollima-sidecar` and ran out TOGETHER, so a fallback between them was useless and
fixing it took a manual `.env` edit. Now every model has a state, a failure
reason, success/failure/check timestamps, an exponential cooldown, and an
upstream (`owned_by` from the gateway's /models); `app/agent/health_probe.py`
re-checks models in the background and puts recovered ones back automatically.

DELIBERATELY IN-PROCESS. The service is a single uvicorn worker, so a dict is the
whole mechanism. A restart forgets cooldowns and the probe relearns them within a
couple of ticks — failing OPEN meanwhile, never closed. Nothing here awaits, so
the chat path only ever reads memory.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from app.logging import get_logger

log = get_logger(__name__)

HEALTHY = "healthy"
RATE_LIMITED = "rate_limited"
PROVIDER_ERROR = "provider_error"
TIMEOUT = "timeout"
UNREACHABLE = "unreachable"
QUARANTINE = "operator_quarantine"
UNKNOWN = "unknown"
FAILING = frozenset({RATE_LIMITED, PROVIDER_ERROR, TIMEOUT, UNREACHABLE, QUARANTINE})

#: Bound on tracked models: the catalogue is a handful, so anything past this is
#: noise and must not grow a dict without limit.
MAX_MODELS = 64
#: A stream-accumulator break was believed forever; a WRONG mark (a transport
#: error that looked like one) then cost that model its streaming until restart.
STREAM_BROKEN_TTL_S = 6 * 3600.0

# Phrases a capacity refusal actually carries. NOT a bare "429": a real grok
# response id was `02e025d9-429d-…`, and such text in a 5xx body would have been
# misread as a quota refusal.
_QUOTA_PHRASES = (
    "usage limit",
    "rate limit",
    "rate_limit",
    "too many requests",
    "quota",
    "error 429",
    "error code: 429",
    "status 429",
)
_UNREACHABLE_PHRASES = (
    "connecterror",
    "connecttimeout",
    "connection refused",
    "connection reset",
    "connection timed out",
    "name or service not known",
    "temporary failure in name resolution",
    "network is unreachable",
    "remoteprotocolerror",
    "readerror",
    "readtimeout",
    "timed out",
)
_ACCOUNT = re.compile(r"you \([^)]*\)", re.IGNORECASE)

# Clocks are module-level so tests can drive time without sleeping.
_now = time.monotonic
_wall = time.time


@dataclass
class _Config:
    rate_limited_s: float = 600.0
    provider_error_s: float = 3600.0
    unreachable_s: float = 60.0
    timeout_s: float = 60.0
    max_backoff_s: float = 3600.0
    probe_interval_s: float = 60.0


_config = _Config()


@dataclass(frozen=True)
class Failure:
    kind: str
    # True when the provider refused BEFORE any token could have streamed —
    # the only case where answering with a different model cannot duplicate text.
    pre_stream: bool


@dataclass
class ModelHealth:
    model: str
    state: str = UNKNOWN
    reason: str = ""
    source: str = ""
    consecutive_failures: int = 0
    last_success_at: float | None = None  # wall clock, for reporting
    last_failure_at: float | None = None
    last_checked_at: float | None = None
    retry_at: float | None = None  # monotonic
    last_success_mono: float | None = None
    last_checked_mono: float | None = None
    probe_due: bool = False
    stream_broken_until: float | None = None  # monotonic


_models: dict[str, ModelHealth] = {}
_upstreams: dict[str, str] = {}
_last_tick: float | None = None


def configure(settings) -> None:
    """Read the cooldown bases from settings. Safe to call more than once."""
    global _config
    _config = _Config(
        rate_limited_s=float(settings.ai_model_health_ttl_s),
        provider_error_s=float(settings.ai_model_health_hard_ttl_s),
        unreachable_s=float(settings.ai_model_health_unreachable_ttl_s),
        timeout_s=float(settings.ai_model_health_unreachable_ttl_s),
        max_backoff_s=float(settings.ai_model_health_max_backoff_s),
        probe_interval_s=float(settings.ai_model_health_probe_interval_s),
    )


def _entry(model: str) -> ModelHealth | None:
    if not model:
        return None
    h = _models.get(model)
    if h is None and len(_models) < MAX_MODELS:
        h = _models[model] = ModelHealth(model=model)
    return h


def _clean_reason(text: str) -> str:
    return _ACCOUNT.sub("you (…)", " ".join(str(text).split()))[:160]


def _transition(h: ModelHealth, state: str, *, reason: str, source: str) -> None:
    before = h.state
    h.state, h.reason, h.source = state, reason, source
    if before != state or state in FAILING:
        retry_in = None
        if h.retry_at is not None:
            retry_in = max(0, round(h.retry_at - _now()))
        # Failures are warnings; a recovery (or a first success) is information.
        (log.warning if state in FAILING else log.info)(
            "model.health_changed",
            extra={
                "model": h.model,
                "provider": upstream_of(h.model) or None,
                "from": before,
                "to": state,
                "reason": reason,
                "retry_in_s": retry_in,
                "failures": h.consecutive_failures,
                "source": source,
            },
        )


# ---------------------------------------------------------------- classification
def _base_for(kind: str) -> float:
    return {
        RATE_LIMITED: _config.rate_limited_s,
        PROVIDER_ERROR: _config.provider_error_s,
        UNREACHABLE: _config.unreachable_s,
        TIMEOUT: _config.timeout_s,
    }.get(kind, _config.rate_limited_s)


def classify_status(status: int, text: str = "") -> str | None:
    """A provider status (+ body) as a health kind; None = not the model's fault."""
    low = text.lower()
    if status == 429 or (status >= 500 and any(p in low for p in _QUOTA_PHRASES)):
        return RATE_LIMITED
    if status in (408, 504):
        # The gateway gave up waiting on the upstream (seen on prod for grok-4.3
        # while its provider was down): slow or unavailable, never "bad request".
        return TIMEOUT
    if status >= 500 or status in (401, 403, 404):
        # 502 is also what this gateway answers for an unknown/removed model id.
        return PROVIDER_ERROR
    return None  # 400/422: the REQUEST was refused, the model is fine


def classify(exc: BaseException) -> Failure | None:
    """What a model-call exception says about the MODEL, if anything."""
    import openai  # noqa: PLC0415 — provider SDK, imported where it is used

    text = f"{type(exc).__name__} {exc}".lower()
    status = getattr(exc, "status_code", None)
    if isinstance(exc, openai.APIStatusError) and isinstance(status, int):
        kind = classify_status(status, text)
        return Failure(kind, True) if kind else None
    # Request-phase failures: raised after openai's own retries, before a byte of
    # the response — so nothing can have streamed. Timeout FIRST: it subclasses
    # APIConnectionError.
    if isinstance(exc, openai.APITimeoutError):
        return Failure(TIMEOUT, True)
    if isinstance(exc, openai.APIConnectionError):
        return Failure(UNREACHABLE, True)
    if any(p in text for p in _QUOTA_PHRASES):
        # A status-less capacity refusal (the gateway wraps upstream 429s in text).
        return Failure(RATE_LIMITED, True)
    if any(p in text for p in _UNREACHABLE_PHRASES):
        # Raw transport errors surface from stream ITERATION: possibly mid-stream.
        return Failure(UNREACHABLE, False)
    return None


# ---------------------------------------------------------------- recording
def record_failure(
    model: str,
    kind: str,
    reason: str = "",
    *,
    base_s: float | None = None,
    retry_after: float | None = None,
    source: str = "traffic",
) -> None:
    h = _entry(model)
    if h is None:
        return
    now = _now()
    h.consecutive_failures += 1
    base = float(base_s) if base_s else _base_for(kind)
    cap = max(_config.max_backoff_s, base)
    cooldown = min(cap, base * (2 ** (h.consecutive_failures - 1)))
    if retry_after is not None and retry_after > 0:
        cooldown = min(cap, max(float(retry_after), 1.0))
    cooldown = max(1.0, cooldown)
    h.retry_at = now + cooldown
    h.last_failure_at = h.last_checked_at = _wall()
    h.last_checked_mono = now
    h.probe_due = False
    _transition(h, kind, reason=_clean_reason(reason or kind), source=source)
    if kind == RATE_LIMITED:
        # Same upstream = same quota: re-check siblings soon, but never bench them
        # on a guess.
        up = upstream_of(model)
        if up:
            for other in _models.values():
                if other.model != model and upstream_of(other.model) == up:
                    other.probe_due = True


def record_exception(
    model: str, exc: BaseException, *, base_s: float | None = None
) -> Failure | None:
    """Classify and record once per exception object (graph and runner both see it)."""
    failure = classify(exc)
    if failure is None or getattr(exc, "_ollasuper_health_recorded", False):
        return failure
    record_failure(
        model,
        failure.kind,
        f"{type(exc).__name__}: {exc}",
        base_s=base_s if failure.kind == RATE_LIMITED else None,
    )
    try:
        exc._ollasuper_health_recorded = True  # type: ignore[attr-defined]
    except (AttributeError, TypeError):
        pass
    return failure


def record_success(model: str, *, source: str = "traffic") -> None:
    h = _entry(model)
    if h is None:
        return
    now = _now()
    h.last_success_at = h.last_checked_at = _wall()
    h.last_success_mono = h.last_checked_mono = now
    h.probe_due = False
    if h.state == QUARANTINE and h.retry_at is not None and now < h.retry_at:
        return  # an operator's quarantine is not lifted by a lucky call
    h.consecutive_failures = 0
    h.retry_at = None
    if h.state != HEALTHY:
        _transition(h, HEALTHY, reason="ok", source=source)
    h.source = source


def record_probe_inconclusive(model: str, reason: str) -> None:
    """The probe itself was refused (400/422): says nothing about the model."""
    h = _entry(model)
    if h is None:
        return
    h.last_checked_at = _wall()
    h.last_checked_mono = _now()
    h.probe_due = False
    log.info("model.probe_inconclusive", extra={"model": model, "reason": reason[:120]})


def quarantine(model: str, seconds: float) -> bool:
    """Operator action: take a KNOWN model out of rotation; a real probe restores it."""
    h = _models.get(model)
    if h is None:
        return False
    h.retry_at = _now() + max(1.0, float(seconds))
    h.last_failure_at = _wall()
    _transition(
        h, QUARANTINE, reason=f"operator quarantine {int(seconds)}s", source="operator"
    )
    return True


# ---------------------------------------------------------------- reading
def _worker_alive(now: float) -> bool:
    return _last_tick is not None and now - _last_tick <= 3 * _config.probe_interval_s


def is_exhausted(model: str) -> bool:
    """True while this model should not be chosen."""
    h = _models.get(model)
    if h is None or h.state not in FAILING or h.retry_at is None:
        return False
    now = _now()
    if now < h.retry_at:
        return True
    # Cooldown over. Wait for the worker's re-probe rather than make a user the
    # probe — but only briefly, and only while the worker is actually running, so
    # a dead worker can never strand a model.
    probed_since = h.last_checked_mono is not None and h.last_checked_mono >= h.retry_at
    return (
        _worker_alive(now)
        and not probed_since
        and now < h.retry_at + 2 * _config.probe_interval_s
    )


def upstream_of(model: str) -> str:
    return _upstreams.get(model, "")


def set_upstreams(mapping: dict[str, str]) -> None:
    _upstreams.clear()
    _upstreams.update({k: v for k, v in mapping.items() if k and v})


def observe(model_ids) -> None:
    """Models the router can choose; the probe worker keeps these fresh."""
    for m in model_ids:
        _entry(m)


def mark_worker_tick() -> None:
    global _last_tick
    _last_tick = _now()


def due_for_probe(*, limit: int, revalidate_s: float) -> list[str]:
    """Which models the worker should check now, most urgent first."""
    now = _now()
    recovery, siblings, never, stale = [], [], [], []
    for h in _models.values():
        checked_since_retry = (
            h.retry_at is not None
            and h.last_checked_mono is not None
            and h.last_checked_mono >= h.retry_at
        )
        if h.state in FAILING:
            if h.retry_at is not None and now >= h.retry_at and not checked_since_retry:
                recovery.append(h.model)
            continue
        if h.probe_due:
            siblings.append(h.model)
        elif h.last_checked_mono is None:
            never.append(h.model)
        elif now - max(h.last_checked_mono, h.last_success_mono or 0.0) >= revalidate_s:
            stale.append(h.model)
    return (recovery + siblings + never + stale)[: max(0, limit)]


def snapshot() -> list[dict]:
    now = _now()
    out = []
    for h in sorted(_models.values(), key=lambda x: x.model):
        out.append(
            {
                "model": h.model,
                "provider": upstream_of(h.model) or None,
                "state": h.state,
                "available": not is_exhausted(h.model),
                "reason": h.reason or None,
                "source": h.source or None,
                "consecutive_failures": h.consecutive_failures,
                "last_success_at": _iso(h.last_success_at),
                "last_failure_at": _iso(h.last_failure_at),
                "last_checked_at": _iso(h.last_checked_at),
                "retry_in_s": (
                    max(0, round(h.retry_at - now))
                    if h.retry_at is not None and h.state in FAILING
                    else None
                ),
                "stream_broken": not streams_tool_calls_cleanly(h.model),
            }
        )
    return out


def worker_status() -> dict:
    now = _now()
    return {
        "alive": _worker_alive(now),
        "last_tick_age_s": None if _last_tick is None else round(now - _last_tick),
    }


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


# ---------------------------------------------------------------- compatibility API
def mark_exhausted(model: str, ttl_s: float) -> None:
    """Record that the provider refused this model for capacity."""
    record_failure(model, RATE_LIMITED, "capacity refusal", base_s=ttl_s)


def mark_hard_failure(model: str, ttl_s: float) -> None:
    """Record a NON-capacity provider failure (5xx, expired upstream credential)."""
    record_failure(model, PROVIDER_ERROR, "provider failure", base_s=ttl_s)


def mark_stream_broken(model: str) -> None:
    """Streaming tool-call deltas from this model cannot be accumulated, so later
    steps skip straight to the non-streaming client. Believed for hours, not for
    the process lifetime, so a mark that was really a transport glitch heals."""
    h = _entry(model)
    if h is None:
        return
    if h.stream_broken_until is None or h.stream_broken_until <= _now():
        log.warning("model.stream_tool_calls_broken", extra={"model": model})
    h.stream_broken_until = _now() + STREAM_BROKEN_TTL_S


def streams_tool_calls_cleanly(model: str) -> bool:
    h = _models.get(model)
    return h is None or h.stream_broken_until is None or h.stream_broken_until <= _now()


def reset() -> None:
    """Tests only — the singletons are module state by design."""
    global _last_tick, _config
    _models.clear()
    _upstreams.clear()
    _last_tick = None
    _config = _Config()
