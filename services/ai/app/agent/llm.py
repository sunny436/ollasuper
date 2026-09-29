"""ChatOpenAI client factory.

User-chat generation is pointed at Ollima (OpenAI-compatible, TensorZero-backed)
via the base_url/api_key overrides below; title-generation and OCR keep the
default OpenRouter client. Both gateways are OpenAI-compatible, so
langchain-openai is the correct client for either.

`temperature=None` is deliberate and load-bearing: the Claude 5 series REJECTS
non-default sampling parameters with a 400, and it is harmless everywhere else.
ChatOpenAI defaults temperature to 0.7 and would send it on every request;
passing None keeps it off the wire for all models and both gateways.
"""

from __future__ import annotations

import httpx
from langchain_openai import ChatOpenAI

from app.config import Settings

# Substrings the gateway actually returns when it refuses for CAPACITY rather
# than for anything about the request. Matched on TEXT, not status code: Ollima
# wraps the upstream refusal, answering **502** with a body like `All variants
# failed ... Error 429 Too Many Requests ... "you (...) have reached your weekly
# usage limit"`. A 502 is indistinguishable from a transient gateway fault by
# type alone, which is why this reads the message.
_QUOTA_MARKERS = (
    "usage limit",
    "quota",
    "insufficient_quota",
    "too many requests",
    "rate limit",
    "429",
)


def is_quota_error(e: BaseException) -> bool:
    """The provider refused for capacity, not for anything in this turn."""
    text = f"{type(e).__name__} {e}".lower()
    return any(m in text for m in _QUOTA_MARKERS)


#: The host could not be REACHED — nothing was refused, because nothing was
#: answered. Distinct from a 5xx or an expired credential: those say something
#: about the model, this says something about the network between us and it.
_UNREACHABLE_MARKERS = (
    "apiconnectionerror",
    "connecterror",
    "connecttimeout",
    "connection refused",
    "connection reset",
    "connection timed out",
    "name or service not known",
    "temporary failure in name resolution",
    "network is unreachable",
    "timed out",
)


def is_unreachable_error(e: BaseException) -> bool:
    """Could not reach the provider at all.

    Kept apart from `_is_provider_error` because the two deserve very different
    memories. An expired upstream credential does not fix itself, so believing
    it for an hour saves every later user from re-learning it. An unreachable
    host usually DOES fix itself, and believing that for an hour means the
    outage keeps costing users long after it ended (measured 2026-09-16:
    api.ollima.com refused TCP for minutes, and every model it serves was
    blacklisted for 3600s on the way out).
    """
    text = f"{type(e).__name__} {e}".lower()
    if any(m in text for m in _QUOTA_MARKERS):
        return False
    return any(m in text for m in _UNREACHABLE_MARKERS)


def _clamp_output(requested: int, context_window: int) -> int:
    """Cap the output request so it cannot exceed what the window can hold."""
    if context_window <= 0:
        return requested
    return max(256, min(requested, context_window // 4))


def _with_connect_timeout(
    timeout: float | httpx.Timeout, settings: Settings
) -> httpx.Timeout:
    """Wait minutes for TOKENS, seconds for a CONNECTION.

    A scalar timeout in httpx applies to every phase, so `timeout=180` gave the
    TCP+TLS handshake 180 seconds — and with `max_retries=2` an unreachable
    provider spent 540 seconds before raising anything. The generation deadline
    (300s) fired first, so the user waited five minutes and was told only that
    the response "took too long"; nothing reached the router's health
    bookkeeping either, so the next request picked the same dead model.
    Measured on production 2026-09-16, when api.ollima.com stopped accepting
    connections while DNS still resolved and the rest of the VM's egress was
    healthy.

    A caller that already passes a Timeout has made its own decision and is
    respected unchanged.

    DUCK-TYPED, NOT `isinstance`. `openai.DEFAULT_TIMEOUT` — which schedule.py
    passes deliberately (46fdff3: a complex parse must not die on a short
    deadline) — is a Timeout built by the httpx that the OPENAI package imports,
    and in this environment that is `httpx2`, a DIFFERENT module object. So
    `isinstance(openai.DEFAULT_TIMEOUT, httpx.Timeout)` is False even though the
    value is a perfectly good Timeout, execution fell through to `float()`, and
    every scheduled-task parse raised TypeError before a socket was opened.
    Measured on production 2026-09-24: 100% of parses, both candidate models,
    with the composer's Create button disabled for every user. Anything carrying
    the four phase attributes is already a decision — pass it through and let the
    openai client use its own type.
    """
    if isinstance(timeout, httpx.Timeout) or all(
        hasattr(timeout, phase) for phase in ("connect", "read", "write", "pool")
    ):
        return timeout  # type: ignore[return-value]
    read = float(timeout)
    connect = min(float(settings.ai_model_connect_timeout_s), read)
    return httpx.Timeout(read, connect=connect)


def build_llm(
    settings: Settings,
    *,
    model: str,
    max_tokens: int | None = None,
    context_window: int = 0,
    streaming: bool = True,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float | httpx.Timeout = 180.0,
    max_retries: int = 2,
    temperature: float | None = None,
    reasoning_effort: str | None = None,
) -> ChatOpenAI:
    # base_url/api_key default (None) => OpenRouter, so title-gen + OCR stay
    # byte-for-byte unchanged; only the user-chat call site overrides them for
    # Ollima. `is None` (NOT `or`) is load-bearing: an empty Ollima key must not
    # silently fall back to — and leak — the OpenRouter key.
    on_openrouter = base_url is None
    resolved_base = settings.openrouter_base_url if base_url is None else base_url
    resolved_key = settings.openrouter_api_key if api_key is None else api_key
    return ChatOpenAI(
        model=model,
        api_key=resolved_key,
        base_url=resolved_base,
        # Stream-usage only applies to a STREAMING call (usage rides the final
        # chunk). A non-streaming call already returns usage in the response body,
        # and requesting stream-usage there makes langchain-openai send
        # `stream=True` and then choke on the returned stream
        # (`AsyncStream has no attribute model_dump`). Gate it on `streaming` so
        # the tool-bound (streaming=False) client is cleanly non-streaming.
        stream_usage=streaming,
        streaming=streaming,
        # Clamped against the context window: the catalogue contains models
        # with a 4095-token window, and asking those for 8192 output tokens is
        # an immediate provider 400. Quarter of the window leaves room for the
        # prompt; the floor keeps a reply possible at all.
        max_tokens=_clamp_output(
            max_tokens or settings.ai_max_output_tokens, context_window
        ),
        # Defaults to None — see the module docstring: the Claude 5 series
        # REJECTS non-default sampling params, so nothing may be sent unless a
        # caller asks. A classifier on a small model passes 0 explicitly, where
        # the default sampling makes a yes/no judgement flap between runs.
        temperature=temperature,
        # None (the default) sends nothing. Set only by the runner, only for a
        # skill turn on a model known to honour it (ai_high_reasoning_models).
        reasoning_effort=reasoning_effort,
        # Defaults suit a generation. An INTERACTIVE caller (the scheduling
        # composer blocks a user behind a spinner) passes a much shorter budget.
        # CONNECT IS BUDGETED SEPARATELY: see `_with_connect_timeout`.
        timeout=_with_connect_timeout(timeout, settings),
        max_retries=max_retries,
        # OpenRouter attribution headers — cosmetic, and meaningless to Ollima,
        # so send them only on the OpenRouter (title/OCR) path.
        default_headers=(
            {
                "HTTP-Referer": settings.openrouter_app_url,
                "X-Title": settings.openrouter_app_title,
            }
            if on_openrouter
            else None
        ),
    )
