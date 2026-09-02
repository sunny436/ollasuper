"""Rolling conversation summary — the compaction half of context management.

WHY THIS FILE EXISTS. Both planes already documented a rolling summary as the
thing that "covers what falls out" of the history window:

  packages/backend/convex/chat/messages.ts:5-7
  services/ai/app/agent/context.py:5-7

and the entire consumption path was built for it — `/ai/ingress` routes
`op: "summary"` (http.ts), `ingest.setSummary` persists it monotonically,
`dispatchPayload` sends it back, and `build_system_prompt` renders it into
`<conversation_summary>`. Everything except the producer. Nothing in this
service ever sent that op, so `thread.summary` was null for every conversation
that has ever run, and nothing preserved what the window dropped.

WHAT A SUMMARY IS FOR HERE. Not a topic gist. A gist — "the user discussed
WireGuard" — is what makes a model answer a follow-up by asking what the user is
referring to. The summary has to preserve conversational IDENTITY: the subject,
the artifact that exists and what form it is in, the operation that was last
performed on it, the constraints the user set, and what is still open. That is
what lets "expand the above blog" keep working after the blog itself has aged
out of the window.

It runs AFTER finalize, as a background task, on a cheap model. It can never
delay a reply, and every failure is swallowed: a missing summary degrades
context, while a raised exception here would fail a turn that has already
succeeded.
"""

from __future__ import annotations

import asyncio
import logging

from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.llm import build_llm
from app.clients.convex import ConvexClient
from app.config import Settings
from app.models.chat import HistoryMessage

log = logging.getLogger(__name__)

# Only summarise once a thread is long enough that the window is a real
# constraint. Below this the raw history is strictly better than any summary of
# it, and a summary would only add a lossy copy of what the model already sees.
MIN_MESSAGES_TO_SUMMARISE = 8
# Re-summarise every N new messages rather than every turn: the summary is a
# safety net for what ages out, and the window holds far more than this.
RESUMMARISE_STRIDE = 6
# The transcript slice handed to the summariser. Generous — a cheap model with a
# large window — but bounded so a pathological thread cannot cost real money.
MAX_TRANSCRIPT_CHARS = 60_000
MAX_SUMMARY_TOKENS = 700

SUMMARY_SYSTEM = (
    "You maintain the running state of an assistant conversation so it can be "
    "continued after the earlier messages have scrolled out of the model's "
    "context window.\n\n"
    "Write a compact STATE RECORD, not a description of what was discussed. A "
    "reader who sees only your output must be able to answer a follow-up like "
    '"expand the above article", "apply those changes" or "go back to the '
    'previous version" without asking the user what they mean.\n\n'
    "Use exactly these headings, omitting any that genuinely do not apply:\n"
    "Active subject:\n"
    "Other subjects in play:\n"
    "Artifacts: (for each — what it is, its topic, its current version, and "
    "whether it is the one currently being worked on)\n"
    "Last operation:\n"
    "User constraints: (requirements the user set that still apply — tone, "
    "audience, length, technical depth, format, things to avoid)\n"
    "User decisions:\n"
    "Open loops: (anything asked for and not yet delivered)\n\n"
    "Name things concretely. Prefer 'Technical blog on Cloud WireGuard VPN, v2, "
    "currently active' over 'an article was written'. Never invent detail that "
    "is not in the transcript. Output only the record."
)


def _transcript(history: list[HistoryMessage], final_text: str | None) -> str:
    """Newest-last transcript slice, trimmed from the FRONT.

    Front-trimmed because the recent turns decide what "it" and "above" refer to;
    the opening of a long conversation matters least to a state record and is
    also the part a previous summary already covered.
    """
    parts: list[str] = []
    for h in history:
        if not h.content.strip():
            continue
        parts.append(f"[{h.seq}] {h.role}: {h.content}")
    if final_text and final_text.strip():
        parts.append(f"[latest] assistant: {final_text}")
    joined = "\n\n".join(parts)
    if len(joined) > MAX_TRANSCRIPT_CHARS:
        joined = "[... earlier turns omitted ...]\n\n" + joined[-MAX_TRANSCRIPT_CHARS:]
    return joined


def should_summarise(
    history: list[HistoryMessage], summary_through_seq: int
) -> bool:
    """Enough conversation, and enough NEW conversation, to be worth a call."""
    if len(history) < MIN_MESSAGES_TO_SUMMARISE:
        return False
    newest = max((h.seq for h in history), default=0)
    return newest - summary_through_seq >= RESUMMARISE_STRIDE


async def write_summary(
    *,
    settings: Settings,
    convex: ConvexClient,
    stream_id: str,
    history: list[HistoryMessage],
    final_text: str | None,
    summary_through_seq: int,
) -> None:
    """Produce and persist the rolling summary. Never raises."""
    try:
        if not should_summarise(history, summary_through_seq):
            return
        through = max((h.seq for h in history), default=0)
        transcript = _transcript(history, final_text)
        if not transcript.strip():
            return

        llm = build_llm(
            settings,
            model=settings.ai_title_model,
            streaming=False,
            max_tokens=MAX_SUMMARY_TOKENS,
        )
        msg = await llm.ainvoke(
            [
                SystemMessage(content=SUMMARY_SYSTEM),
                HumanMessage(content=transcript),
            ]
        )
        text = msg.content if isinstance(msg.content, str) else str(msg.content)
        text = text.strip()
        if not text:
            return

        # setSummary is monotonic on throughSeq, so a slow summary for older
        # messages cannot clobber a newer one that landed first.
        await convex.ingress(
            {
                "op": "summary",
                "streamId": stream_id,
                "summary": text,
                "throughSeq": through,
            }
        )
        log.info(
            "summary_written",
            extra={
                "stream_id": stream_id,
                "through_seq": through,
                "chars": len(text),
            },
        )
    except Exception:  # noqa: BLE001 - compaction is never worth failing a turn
        log.warning("summary_skipped", extra={"stream_id": stream_id})


def schedule(
    *,
    settings: Settings,
    convex: ConvexClient,
    stream_id: str,
    history: list[HistoryMessage],
    final_text: str | None,
    summary_through_seq: int,
) -> asyncio.Task | None:
    """Fire-and-forget. Returns the task so a test can await it."""
    if not should_summarise(history, summary_through_seq):
        return None
    return asyncio.create_task(
        write_summary(
            settings=settings,
            convex=convex,
            stream_id=stream_id,
            history=history,
            final_text=final_text,
            summary_through_seq=summary_through_seq,
        )
    )
