"""ChatOpenAI pointed at OpenRouter.

OpenRouter is OpenAI-compatible, so langchain-openai is the correct client.
langchain-anthropic speaks the native Anthropic Messages API and cannot reach
OpenRouter at all.

`temperature=None` is deliberate and load-bearing: the Claude 5 series REJECTS
non-default sampling parameters with a 400. ChatOpenAI defaults temperature to
0.7 and would send it on every request, breaking every single call. Passing
None keeps it off the wire.
"""

from __future__ import annotations

from langchain_openai import ChatOpenAI

from app.config import Settings


def build_llm(
    settings: Settings,
    *,
    model: str,
    max_tokens: int | None = None,
    streaming: bool = True,
) -> ChatOpenAI:
    return ChatOpenAI(
        model=model,
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        # Without this, usage_metadata never appears on streamed chunks and
        # token accounting is silently always zero.
        stream_usage=True,
        streaming=streaming,
        max_tokens=max_tokens or settings.ai_max_output_tokens,
        temperature=None,
        timeout=180.0,
        max_retries=2,
        default_headers={
            # OpenRouter attribution headers — purely cosmetic, they populate
            # the app's entry on openrouter.ai/rankings.
            "HTTP-Referer": settings.openrouter_app_url,
            "X-Title": settings.openrouter_app_title,
        },
    )
