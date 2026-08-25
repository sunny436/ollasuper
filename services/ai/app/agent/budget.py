"""Phase 6 — the central context-budget / accounting contract.

ONE place that measures every component of a turn's model input with a single
token counter and ALLOCATES the model's real context window, so the assembled
input can never exceed `context_window - max_output`. Later agents/skills/tools
inherit this instead of re-deriving ad-hoc caps.

Before Phase 6, budgeting only trimmed HISTORY against a flat 32k and reserved a
fixed 4k for "system" + 0 for tool schemas — so the actual system prompt, the
bound tool schemas, the latest turn (attachments/images), the resumed tool
messages, and the accumulated multi-step results were all uncounted and could
overrun the window (badly on a small-context model). This module counts them.

The token counter (`count_tokens_approximately`) is OpenAI-calibrated and
UNDERCOUNTS Claude; callers pad with `safety_factor`. That is the honest
approximate-and-pad — there is no Claude tokenizer reachable through the
provider.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.messages.utils import count_tokens_approximately

from app.models.chat import CONTEXT_WINDOW, IMAGE_TOKENS

# Headroom (tokens) for tokenizer drift + request-envelope overhead, on top of
# the per-component `safety_factor`.
_HEADROOM = 1_000
# Even a tiny window keeps at least this much room for prior history / results,
# so a 4k model degrades (shrinks) instead of dropping the turn entirely.
_HISTORY_FLOOR = 1_000
# count_tokens_approximately assumes ~4 chars/token; used to turn a token budget
# into a char budget for the latest-turn document text.
_CHARS_PER_TOKEN = 4
# Minimal system-block reservation kept when sizing the latest turn on a tiny
# window (the base system prompt is short; custom instructions compete with it).
_MIN_SYSTEM_RESERVE = 400
# A compacted tool result keeps a short head for continuity + a size marker.
_COMPACT_KEEP_CHARS = 240


def tokens(text: str) -> int:
    """Approximate token count of a raw string (wraps it as one message)."""
    if not text:
        return 0
    return count_tokens_approximately([HumanMessage(content=text)])


def spec_tokens(specs: list[dict] | None) -> int:
    """Approximate token cost of the bound tool schemas (serialized as JSON)."""
    if not specs:
        return 0
    return tokens(json.dumps(specs, ensure_ascii=False, default=str))


def content_tokens(content: str | list) -> int:
    """Text-token cost of a user turn's content — a plain string, or the text
    parts of a multimodal list (image cost is counted separately via
    IMAGE_TOKENS)."""
    if isinstance(content, str):
        return tokens(content)
    text = " ".join(
        p.get("text", "")
        for p in content
        if isinstance(p, dict) and p.get("type") == "text"
    )
    return tokens(text)


@dataclass(frozen=True, slots=True)
class ContextBudget:
    """Per-turn window accounting. Built once from the model + the REAL context
    window (passed from Convex) + the reserved output. All allocations flow from
    `input_ceiling` so no component is left uncounted."""

    model: str
    context_window: int  # real catalogue value from Convex; 0 -> table fallback
    max_output: int
    safety_factor: float
    base_history_budget: int  # ai_context_budget_tokens — the cost ceiling

    @property
    def window(self) -> int:
        return self.context_window or CONTEXT_WINDOW.get(self.model, 200_000)

    @property
    def effective_output(self) -> int:
        """The output the provider ACTUALLY reserves — mirrors llm._clamp_output
        (min(requested, window//4), floored) so a 4k-window model does not
        over-reserve 8192 and leave negative input room."""
        w = self.window
        return max(256, min(self.max_output, w // 4)) if w > 0 else self.max_output

    @property
    def input_ceiling(self) -> int:
        """Hard cap on TOTAL input tokens = window - reserved output - headroom."""
        return max(_HISTORY_FLOOR, self.window - self.effective_output - _HEADROOM)

    def image_tokens(self, n_images: int) -> int:
        return n_images * IMAGE_TOKENS.get(self.model, 1_600)

    def history_budget(
        self,
        *,
        system_tokens: int,
        schema_tokens: int,
        latest_tokens: int,
        n_images: int,
    ) -> int:
        """Tokens left for PRIOR history after the measured fixed costs — capped
        by the cost budget, safety-padded, floored. This replaces the old flat
        `min(32k, window - output - 4k)`."""
        fixed = (
            system_tokens + schema_tokens + latest_tokens + self.image_tokens(n_images)
        )
        remainder = int((self.input_ceiling - fixed) / max(1.0, self.safety_factor))
        return max(_HISTORY_FLOOR, min(self.base_history_budget, remainder))

    def latest_char_budget(self) -> int:
        """Char budget for the WHOLE latest turn (message text + document text),
        so on a small window it SHRINKS rather than overrunning. The latest turn
        (the user's actual question) gets priority over history/schemas, so this
        reserves only a minimal system block — history then trims to its floor and
        the schema working-set drops if the window is still too small. On a large
        window this is far above `ai_max_turn_chars`, so the flat 48k cap wins and
        behavior is unchanged."""
        avail = self.input_ceiling - _MIN_SYSTEM_RESERVE
        padded = int(max(0, avail) / max(1.0, self.safety_factor))
        return padded * _CHARS_PER_TOKEN

    def message_fit_budget(self, *, system_tokens: int, schema_tokens: int) -> int:
        """Token budget for the in-graph message list (everything the model sees
        EXCEPT the system block + bound schemas, which are added around it). Used
        to re-fit accumulated / resumed tool results per step."""
        avail = self.input_ceiling - system_tokens - schema_tokens
        return max(_HISTORY_FLOOR, int(avail / max(1.0, self.safety_factor)))


def _is_compacted(m: ToolMessage) -> bool:
    return isinstance(m.content, str) and '"compacted": true' in m.content


def _compact(m: ToolMessage) -> ToolMessage:
    """Shrink a tool result to a short reference, PRESERVING the tool_call_id +
    status so the assistant/tool pairing the provider requires stays valid. Keeps
    a small head for continuity — the durable checkpoint is untouched, only the
    in-context copy shrinks."""
    content = (
        m.content
        if isinstance(m.content, str)
        else json.dumps(m.content, default=str)
    )
    ref = json.dumps(
        {
            "compacted": True,
            "chars": len(content),
            "head": content[:_COMPACT_KEEP_CHARS],
            "note": "earlier tool result elided to fit the context budget",
        }
    )
    return ToolMessage(
        content=ref,
        tool_call_id=m.tool_call_id,
        status=getattr(m, "status", "success"),
    )


def fit_messages(messages: list[AnyMessage], budget_tokens: int) -> list[AnyMessage]:
    """Compaction primitive: if the message list exceeds `budget_tokens`, replace
    the OLDEST raw tool results with references until under budget — NEWEST results
    and the human/assistant turns are preserved. Never DROPS a message (that would
    orphan a tool_call/result pair the provider rejects); it preserves references
    instead of unlimited raw payloads. Idempotent (won't re-compact)."""
    if not messages:
        return messages
    per = [count_tokens_approximately([m]) for m in messages]
    total = sum(per)
    if total <= budget_tokens:
        return list(messages)
    out = list(messages)
    # Oldest-first: keep the most recent (most relevant) results full.
    for i, m in enumerate(out):
        if total <= budget_tokens:
            break
        if isinstance(m, ToolMessage) and not _is_compacted(m):
            new = _compact(m)
            total -= per[i] - count_tokens_approximately([new])
            out[i] = new
    return out


def cumulative_tokens(messages: list[AnyMessage]) -> int:
    """Sum of the provider-reported usage across the model turns in a message
    list (each AIMessage carries its own usage_metadata). Observability only —
    per-turn COST is bounded by `base_history_budget × max_steps`, not a separate
    ceiling (see the plan)."""
    total = 0
    for m in messages:
        if isinstance(m, AIMessage):
            u = getattr(m, "usage_metadata", None) or {}
            total += (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
    return total


# The central, referenceable table of EVERY budget/limit — Python + a mirror of
# the Convex-side caps — so the whole budget set is discoverable from one place.
# Values are the setting names / constants; enforcement points in parentheses.
LIMITS: dict[str, str] = {
    # --- context / tokens (Python, enforced via ContextBudget) ---
    "context_window": "req.contextWindow (Convex catalogue) / CONTEXT_WINDOW table",
    "output_tokens": "ai_max_output_tokens=8192 (reserved + clamped request)",
    "history_budget_tokens": "ai_context_budget_tokens=32000 (cost cap)",
    "latest_turn_chars": "ai_max_turn_chars=48000 (window-aware latest_char_budget)",
    "images_per_turn": "ai_max_images_per_turn=4 (IMAGE_TOKENS per image)",
    "tool_result_chars": "ai_agent_tool_result_max_chars=8000 (executor _bounded)",
    "accumulated/resumed_results": "fit_messages -> references (per step + resume)",
    "tool_schema_tokens": "working-set drops lowest-ranked specs if over (runner B2)",
    # --- work / concurrency / duration ---
    "workflow_steps": "ai_agent_max_steps=4 (graph tool_budget)",
    "tool_calls_per_step": "ai_agent_max_tool_calls_per_step=8 (executor fan-out)",
    "concurrent_tools": "ai_agent_max_concurrent_tools=4 (executor semaphore, P7)",
    "total_tools_per_turn": "max_steps x fan-out = 32 (resume-aware via tool_budget)",
    "tool_retries": "ai_agent_tool_max_retries=2 (executor retry loop)",
    "turn_deadline_s": "ai_agent_total_deadline_s=300 (runner + Convex deadlineAt)",
    "concurrent_streams": "ai_max_concurrent_per_user=2 / _global=32 (registry)",
    "generations_per_hour": "Convex MAX_GENERATIONS_PER_HOUR (rate limiter)",
    "per_turn_cost": "bounded by history_budget x max_steps (the 32k cap IS cost)",
    # --- Convex-side (documented; enforced in convex/chat/*) ---
    "convex_event_batch": "MAX_EVENTS_PER_BATCH=64 / _PAYLOAD_CHARS=100000 (ingest)",
    "convex_delta_batch": "MAX_DELTAS_PER_BATCH=64 / MAX_DELTA_CHARS=16000 (ingest)",
    "convex_message_chars": "MAX_MESSAGE_CHARS=400000 (ingest.ts)",
    "convex_resume_caps": "completed/attempted/approved<=64; resultContent<=16000",
    "convex_history_msgs": "buildHistory <=60 msgs + rolling summary (messages.ts)",
}
