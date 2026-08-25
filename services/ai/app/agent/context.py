"""Context assembly and trimming.

Three layers keep history bounded, and none of them is "send everything":

  1. Convex already caps what it sends (<=60 messages + the rolling summary).
  2. trim_messages enforces a token budget here.
  3. A rolling summary, stored on the thread in Convex, covers what falls out.

The budget defaults to 32k rather than the model's 1M window because at Opus-5
input rates a full 32k context is ~$0.16 per turn and 1M would be $5.00 per
message. 32k holds roughly 60 turns of ordinary chat.
"""

from __future__ import annotations

from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    SystemMessage,
    trim_messages,
)
from langchain_core.messages.utils import count_tokens_approximately

from app.models.chat import CONTEXT_WINDOW, IMAGE_TOKENS, HistoryMessage

SYSTEM_BASE = (
    "You are the assistant in myos. Be direct and useful.\n"
    "Format answers in Markdown. Use fenced code blocks with a language tag "
    "for any code. Prefer short paragraphs over walls of text."
)


def build_system_prompt(
    *,
    custom: str | None,
    about: str | None,
    style: str | None,
    summary: str | None,
    summary_through_seq: int,
    rag: str | None = None,
) -> str:
    parts = [custom.strip() if custom and custom.strip() else SYSTEM_BASE]
    if about and about.strip():
        parts.append(f"<about_the_user>\n{about.strip()}\n</about_the_user>")
    if style and style.strip():
        parts.append(f"<response_style>\n{style.strip()}\n</response_style>")
    if summary and summary.strip():
        parts.append(
            f'<conversation_summary through_message="{summary_through_seq}">\n'
            f"{summary.strip()}\n</conversation_summary>"
        )
    # Retrieved knowledge goes LAST and is pre-framed as untrusted DATA (see
    # ingest/retrieve.render_rag_block), so genuine instructions keep precedence.
    if rag and rag.strip():
        parts.append(rag)
    return "\n\n".join(parts)


def budget_for(
    model: str,
    n_images: int,
    max_output: int,
    base_budget: int,
    context_window: int = 0,
    fixed_tokens: int = 4_000,
) -> int:
    """Token budget for history, after reserving output, the FIXED costs, and
    image costs.

    `context_window` is the real value from the OpenRouter catalogue, passed
    through by Convex. It wins over the curated table because that table only
    covers three models and the catalogue covers several hundred -- including
    models with a 4k window, where the 200k default would overrun badly.

    Phase 6: `fixed_tokens` is the MEASURED cost of the system prompt + bound tool
    schemas + latest turn (the runner passes it), replacing the old flat 4k guess
    for "system headroom" so history is trimmed against the TRUE remainder. The
    output reservation is CLAMPED to the window (mirrors llm._clamp_output) so a
    small-window model does not over-reserve and leave negative input room.
    """
    window = context_window or CONTEXT_WINDOW.get(model, 200_000)
    eff_out = max(256, min(max_output, window // 4)) if window > 0 else max_output
    hard = window - eff_out - fixed_tokens
    image_cost = n_images * IMAGE_TOKENS.get(model, 1_600)
    return max(2_000, min(base_budget, hard) - image_cost)


def to_lc_messages(history: list[HistoryMessage]) -> list[AnyMessage]:
    out: list[AnyMessage] = []
    for h in history:
        if h.role == "user":
            out.append(HumanMessage(content=h.content))
        elif h.role == "assistant":
            out.append(AIMessage(content=h.content))
        else:
            out.append(SystemMessage(content=h.content))
    return out


def trim(
    messages: list[AnyMessage],
    *,
    model: str,
    n_images: int,
    max_output: int,
    base_budget: int,
    safety_factor: float,
    context_window: int = 0,
    fixed_tokens: int = 4_000,
) -> list[AnyMessage]:
    """Trim to the token budget, oldest-first.

    count_tokens_approximately is calibrated for OpenAI-ish tokenizers and
    undercounts Claude — badly on code. There is no Claude tokenizer reachable
    through OpenRouter, so the honest answer is approximate-and-pad; the safety
    factor should be re-tuned against real usage.prompt_tokens.

    Phase 6: `fixed_tokens` (system + schemas + latest, measured by the runner)
    is subtracted so history fits alongside them within the real window.
    """
    if not messages:
        return []
    budget = budget_for(
        model, n_images, max_output, base_budget, context_window, fixed_tokens
    )
    return trim_messages(
        messages,
        max_tokens=int(budget / max(1.0, safety_factor)),
        token_counter=count_tokens_approximately,
        strategy="last",
        # Never begin on an orphaned assistant turn — some providers reject it,
        # and it reads as the model talking to itself.
        start_on="human",
        include_system=False,  # the system block is prepended separately
        allow_partial=False,
    )


