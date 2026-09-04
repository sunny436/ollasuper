"""Next-suggestion chips — up to 3 follow-up ACTIONS offered beside the composer.

WHY THIS SHAPE. It is the compaction pattern (`runtime/compaction.py`) reused
verbatim: a cheap model, called AFTER `writer.finalize`, as a fire-and-forget task
whose every failure is swallowed. The reply is already on the user's screen before
this module runs, so a missing suggestion degrades a nicety while a raised
exception here would fail a turn that has already succeeded.

It runs on `ai_title_model` through OpenRouter (no `base_url` override), NOT on the
chat gateway — so it costs none of the chat provider's quota and keeps working
while that quota is exhausted.

THREE THINGS HERE WERE MEASURED, NOT GUESSED.

1. NO LENGTH PRE-GATE. An obvious-looking "skip short answers" guard is wrong:
   "Deployed to production. Build 4f2a is live." is 43 characters and is one of the
   most actionable turns there is (roll back / check logs / tag the release). Length
   does not predict actionability, so the model decides and nothing else does.

2. `temperature=0` IS LOAD-BEARING. At the default the trivial gate is not stable:
   the same "is python typed" turn returned [] on one run and
   ["Learn about type hints", "Try static typing", ...] on the next. Pinned to 0,
   plus the few-shot block below, the battery in tests/test_suggestions.py is
   stable across repeated runs.

3. THE MODEL DOES NOT RELIABLY EMIT STRICT JSON. Observed replies include a
   markdown dash-list and `[Analyze content gaps, Add schema markup]` — a
   JSON-shaped array with unquoted strings. `_parse` therefore recovers those
   rather than trusting `json.loads`, and yields nothing at all on anything else.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re

from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.llm import build_llm
from app.clients.convex import ConvexClient
from app.config import Settings
from app.models.chat import HistoryMessage

log = logging.getLogger(__name__)

MAX_SUGGESTIONS = 3
MAX_WORDS = 6
MAX_CHARS = 60
# The turn handed to the classifier: the user's ask plus what was answered. The
# whole history is deliberately NOT sent — relevance here is a property of the
# latest turn, and a long transcript would cost more and dilute it.
MAX_ASK_CHARS = 2_000
MAX_ANSWER_CHARS = 6_000
MAX_OUTPUT_TOKENS = 120

SUGGESTIONS_SYSTEM = (
    "You propose follow-up ACTIONS the user may want next.\n\n"
    "OUTPUT: a JSON array, nothing else. First character [ and last ]. No prose, "
    "no markdown, no code fence. At most 3 items. Each an imperative action of at "
    "most 6 words, phrased as the USER would command it.\n\n"
    "Emit [] unless the assistant produced substantial WORK the user could now "
    "extend, refine, apply or act on — an analysis, a draft, a plan, code, a "
    "comparison, a completed operation.\n\n"
    "Emit [] for: greetings, thanks, chit-chat; a refusal; a question already "
    "answered completely (a fact, a definition, a yes/no); anything where a "
    "suggestion would invent a new topic rather than continue the user's task.\n\n"
    "RULES. Each item is a DIFFERENT action, not a rewording. Never restate what "
    "the assistant said. Never emit curiosity or reading suggestions - no 'learn', "
    "'explore', 'discover', 'understand', 'read about', 'tell me more', 'would you "
    "like'. An item must be work the ASSISTANT can perform, not something the user "
    "goes off and studies. Never pad to reach three. Prefer [] over weak items.\n\n"
    "EXAMPLES\n"
    "user: is python typed / assistant: Python is dynamically typed, with optional "
    "hints. -> []\n"
    "user: what is the capital of France / assistant: Paris. -> []\n"
    "user: thanks / assistant: You are welcome! -> []\n"
    "user: deploy it / assistant: Deployed to production. Build 4f2a is live. -> "
    '["Roll back build 4f2a","Check production error logs","Tag this release"]\n'
)

# Output phrasing only. This is NOT the relevance decision — that stays with the
# model above. It exists because "Learn about type hints" is the one failure the
# prompt alone did not reliably suppress, and a curiosity prompt is worse than no
# prompt at all.
_CURIOSITY = re.compile(
    r"\b(learn|explore|discover|understand|read about|tell me more|"
    r"would you like|find out|study)\b",
    re.I,
)

# A task with no strong reference can be garbage-collected mid-flight; the event
# loop holds only a weak one. compaction gets away with discarding its handle
# because it fires rarely, but this runs on every completed turn.
_pending: set[asyncio.Task] = set()


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + " […]"


def _latest_ask(history: list[HistoryMessage]) -> str:
    """The newest user message — what the suggestions must stay relevant to."""
    for h in reversed(history):
        if h.role == "user" and h.content.strip():
            return _clip(h.content, MAX_ASK_CHARS)
    return ""


def _parse(raw: str) -> list[str] | None:
    """Lenient. Returns None only when nothing list-shaped can be recovered."""
    raw = raw.strip()
    items: list[str] | None = None
    try:
        value = json.loads(raw)
        if isinstance(value, list):
            items = [str(x) for x in value]
    except Exception:  # noqa: BLE001 - a non-JSON reply is expected, not an error
        items = None
    if items is None:
        # `[a, b, c]` with unquoted members, and dash-lists wrapped in brackets.
        match = re.search(r"\[(.*)]", raw, re.S)
        if not match:
            return None
        items = list(match.group(1).split(","))
    cleaned: list[str] = []
    for item in items:
        text = str(item).strip().strip("\"'").lstrip("-*• ").strip()
        if not text or len(text.split()) > MAX_WORDS or len(text) > MAX_CHARS:
            continue
        if _CURIOSITY.search(text):
            continue
        if any(text.lower() == seen.lower() for seen in cleaned):
            continue
        cleaned.append(text[0].upper() + text[1:])
    return cleaned[:MAX_SUGGESTIONS]


async def write_suggestions(
    *,
    settings: Settings,
    convex: ConvexClient,
    stream_id: str,
    history: list[HistoryMessage],
    final_text: str | None,
) -> None:
    """Produce and persist the chips for a finished turn. Never raises."""
    try:
        answer = _clip(final_text or "", MAX_ANSWER_CHARS)
        if not answer:
            return
        ask = _latest_ask(history)

        llm = build_llm(
            settings,
            model=settings.ai_title_model,
            streaming=False,
            max_tokens=MAX_OUTPUT_TOKENS,
            temperature=0,
        )
        msg = await llm.ainvoke(
            [
                SystemMessage(content=SUGGESTIONS_SYSTEM),
                HumanMessage(content=f"user: {ask}\nassistant: {answer}"),
            ]
        )
        content = msg.content if isinstance(msg.content, str) else str(msg.content)
        parsed = _parse(content)
        if parsed is None:
            log.warning("suggestions_unparseable", extra={"stream_id": stream_id})
            return

        # Written even when EMPTY, and that is load-bearing. The turn stamps its
        # own seq either way, so a trivial turn actively CLEARS the previous
        # turn's chips instead of silently leaving them on screen.
        await convex.ingress(
            {
                "op": "suggestions",
                "streamId": stream_id,
                "suggestions": parsed,
            }
        )
        log.info(
            "suggestions_written",
            extra={"stream_id": stream_id, "count": len(parsed)},
        )
    except Exception:  # noqa: BLE001 - never worth failing a finished turn
        log.warning("suggestions_skipped", extra={"stream_id": stream_id})


def schedule(
    *,
    settings: Settings,
    convex: ConvexClient,
    stream_id: str,
    history: list[HistoryMessage],
    final_text: str | None,
) -> asyncio.Task | None:
    """Fire-and-forget. Returns the task so a test can await it."""
    if not settings.ai_suggestions_enabled:
        return None
    if not (final_text or "").strip():
        return None
    task = asyncio.create_task(
        write_suggestions(
            settings=settings,
            convex=convex,
            stream_id=stream_id,
            history=history,
            final_text=final_text,
        )
    )
    _pending.add(task)
    task.add_done_callback(_pending.discard)
    return task
