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

from langchain_openai import ChatOpenAI

from app.config import Settings


def _clamp_output(requested: int, context_window: int) -> int:
    """Cap the output request so it cannot exceed what the window can hold."""
    if context_window <= 0:
        return requested
    return max(256, min(requested, context_window // 4))


def build_llm(
    settings: Settings,
    *,
    model: str,
    max_tokens: int | None = None,
    context_window: int = 0,
    streaming: bool = True,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float = 180.0,
    max_retries: int = 2,
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
        temperature=None,
        # Defaults suit a generation. An INTERACTIVE caller (the scheduling
        # composer blocks a user behind a spinner) passes a much shorter budget.
        timeout=timeout,
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
