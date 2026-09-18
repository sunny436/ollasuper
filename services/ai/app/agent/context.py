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

# Runtime backstop for the Project instruction block. Mirrors the skill
# instructions budget; the authoritative limit is enforced by Convex on write.
PROJECT_INSTRUCTIONS_MAX_CHARS = 20_000

SYSTEM_BASE = (
    "You are the assistant in myos. Be direct and useful.\n"
    "Format answers in Markdown. Use fenced code blocks with a language tag "
    "for any code. Prefer short paragraphs over walls of text."
)

# Always-on AGENTIC orientation (prepended whenever ANY capability is available).
# It makes the model DECIDE, autonomously, which source/capability a goal needs —
# so the user never has to say "search the web" / "use my PDF" / "use memory". It
# is deliberately capability REASONING (intent + freshness + source), NOT
# brittle keyword rules, and it is balanced to prevent BOTH under-use (guessing at
# current facts) and over-use (calling a tool for stable knowledge). It leads the
# prompt so it applies even when the user sets custom instructions (which replace
# the persona base below but must NOT strip this core behavior).
CAPABILITY_ORIENTATION = (
    "You are OllaSuper, an autonomous AI assistant. The user gives you a GOAL; YOU "
    "decide how to accomplish it. The user should never have to tell you which "
    "tool, source, or capability to use.\n"
    "You can gather information and act through several capabilities: web search "
    "(for current, public, or fast-changing facts you cannot reliably know — "
    "prices, news, weather, availability, anything 'latest'/'current'/'today' or "
    "that may have changed recently); the user's own uploaded files and saved "
    "knowledge; the user's memory; this conversation's history; and tools (you can "
    "discover more tools when the ones offered do not fit).\n"
    "Before answering, judge what the goal needs and whether you ALREADY reliably "
    "know it:\n"
    "- Needs current / real-world / fast-changing facts you cannot be sure of -> "
    "use web search to get and verify them, rather than guessing or answering from "
    "memory.\n"
    "- Refers to the user's files, documents, or private/company knowledge -> "
    "retrieve from those.\n"
    "- Refers to something earlier in this conversation, or a saved fact about the "
    "user -> use the conversation history or memory.\n"
    "- Needs an operation performed -> use the appropriate tool; if none is "
    "offered, discover one.\n"
    "- Simple, stable knowledge (definitions, math, general facts) -> just answer "
    "directly; do NOT use a tool unnecessarily.\n"
    "Decide and act autonomously. Never ask the user which capability to use, and "
    "never tell them to 'search the web' or 'use RAG' themselves — that is your "
    "job. When you use retrieved information, ground your answer in it."
)

# GROUNDING POLICY — what may be ASSERTED, and what must be labelled.
#
# Every rule here comes from a measured failure in the 17-09-2026 test run, not
# from a general wish for honesty:
#   * documentation and infrastructure answers invented URLs, repository paths,
#     package versions, past release history and deployment facts to look
#     complete, and modelled numbers were presented as measured ones;
#   * an explicit field in the spec ("receipt") was silently dropped rather than
#     asked about, and a React version/router was assumed rather than confirmed;
#   * a file was described as attached when none was generated, and external
#     actions were written as though they had been carried out;
#   * a live-forecast request was answered with advice about how to search
#     instead of the search being run, and conflicting retail prices were passed
#     through unreconciled.
# It sits on BOTH the agentic and plain paths — the fabrications happened on
# tool-less coding turns.
GROUNDING_POLICY = (
    "GROUNDING AND HONESTY (these override style preferences):\n"
    "- State as FACT only what you verified in this conversation, in a tool "
    "result, in a file the user gave you, or what is stable public knowledge. "
    "Anything else is labelled inline: UNKNOWN (not established), ASSUMED (you "
    "chose it to proceed), or ESTIMATED (a modelled number, with its basis). A "
    "plausible-looking invention is worse than an admitted gap.\n"
    "- NEVER invent a URL, repository path, file path, package or tool version, "
    "release history, API detail, infrastructure capability or deployment fact. "
    "If you did not see it, say you did not, or ask.\n"
    "- Modelled, illustrative or benchmark numbers are labelled as such wherever "
    "they appear — never written as measurements.\n"
    "- If a missing detail would CHANGE the result, ask one concise question "
    "before producing the work. If it would not, proceed and state the "
    "assumption explicitly. Track every explicit requirement the user gave "
    "(named fields, constraints, formats) and carry it through revisions.\n"
    "- FILES: only say a file is attached, generated, created or ready to "
    "download if a file-generation tool actually ran and succeeded in this turn. "
    "Otherwise say plainly that no file was generated and give the content "
    "inline. Never write a download line for a file that does not exist.\n"
    "- EXTERNAL ACTIONS: only say a message, ticket, upload or webhook was sent, "
    "created or dispatched if the corresponding tool ran and succeeded. "
    "Otherwise label the output 'DRAFT — NOT SENT'.\n"
    "- LIVE DATA: when the question is about something current, actually retrieve "
    "it and answer from what you get; do not reply with guidance on how to look "
    "it up. Say when each figure was published, and when retrieved snippets are "
    "older than the question needs, say so instead of presenting them as now.\n"
    "- CONFLICTING FIGURES: when sources disagree (prices especially), reconcile "
    "them where the evidence allows — list price vs promotion vs merchant vs "
    "date — and when it does not, report the conflict and its sources rather "
    "than picking one silently.\n"
    "- SEARCH RESULTS: if results do not match the question, say nothing relevant "
    "was found rather than summarising whatever ranked first.\n"
    "- LENGTH: never stop mid-sentence. If the full deliverable will not fit, "
    "finish the section you are in, say which sections remain, and offer to "
    "continue — do not silently shorten what was asked for."
)

# Parallel tool-use directive — appended to the agentic orientation AND to any
# tool-bound sub-agent's prompt (base.Agent.run). The executor already runs a
# step's tool calls concurrently; this makes the model actually BATCH the
# independent ones instead of one-per-step, without ever batching a dependent call
# (so results stay complete + correct). Generic: applies to every current/future
# tool and agent workflow.
PARALLEL_TOOL_GUIDANCE = (
    "PARALLELISM: when you need several tools whose inputs you ALREADY have and "
    "whose results do NOT depend on each other, call them TOGETHER in ONE step so "
    "they run at the same time instead of one after another. For example, run all "
    "the independent checks on a page (robots, sitemap, headers, redirects, "
    "mixed-content, broken-links, structured-data, meta) at once, and audit "
    "several pages at once. ONLY do a tool by itself first when a later tool "
    "genuinely needs its output (e.g. crawl or read the sitemap BEFORE auditing the "
    "specific URLs it returns). Batching independent calls must never change WHICH "
    "checks you run or your conclusions — it only makes them finish faster."
)

# Charting capability — a GENERIC, reusable UI primitive (not a dashboard, not a
# skill). Any response can visualise data inline by emitting a ```chart fenced block
# whose body is a JSON Chart.js config; the chat renders it to a canvas right where it
# sits in the answer. Bounded (one paragraph + a tiny example) and appended to the
# agentic orientation, so it is available to every skill without any per-skill code.
CHART_GUIDANCE = (
    "CHARTS: when numeric data is genuinely clearer as a chart than as a table or "
    "prose, render it INLINE by emitting a fenced ```chart code block whose body is a "
    "single JSON Chart.js config with `type`, `data` (labels + datasets), and optional "
    "`options`. The UI draws it as a real chart exactly where you place the block, "
    "alongside your text — put it next to the relevant analysis, not all at the end. "
    "Supported `type`s: bar, line, pie, doughnut, scatter, radar, polarArea, bubble; "
    "for an area chart use `line` with `\"fill\": true`. You may include several chart "
    "blocks in one answer; each renders independently. The JSON must be valid and "
    "DATA-ONLY (no functions/callbacks); colours are optional (the UI themes them). "
    "Do not describe the raw JSON to the user or wrap it in prose — just place the "
    "block. Example:\n"
    "```chart\n"
    '{"type":"bar","data":{"labels":["Jan","Feb","Mar"],'
    '"datasets":[{"label":"Signups","data":[10,25,18]}]}}\n'
    "```\n"
    "Only chart when it genuinely helps; a single number or a two-row table does not "
    "need one."
)


def build_system_prompt(
    *,
    custom: str | None,
    about: str | None,
    style: str | None,
    summary: str | None,
    summary_through_seq: int,
    rag: str | None = None,
    agentic: bool = False,
    project_instructions: str | None = None,
) -> str:
    # SYSTEM_BASE IS UNCONDITIONAL.
    #
    # It used to be REPLACED by `custom` (`persona = custom or SYSTEM_BASE`),
    # and on a NON-agentic turn `parts` was `[persona]` alone — so a user's
    # saved system prompt became the entire system message: no platform base,
    # no capability orientation, nothing above it. A saved preference is user
    # data; it must not be able to delete the platform's ground rules.
    #
    # The persona now sits in its own block BENEATH them, exactly as
    # <project_instructions> already does. It still steers strongly — it is the
    # most specific instruction present — but authority comes from position, so
    # it cannot erase what precedes it and nothing has to pattern-match hostile
    # wording.
    # GROUNDING_POLICY is on BOTH branches, unlike the capability orientation.
    # The fabrication this fixes was measured on plain coding/documentation turns,
    # which bind no tools and are therefore NOT agentic — putting it only in the
    # agentic list would have missed exactly the turns that failed.
    parts = (
        [
            CAPABILITY_ORIENTATION,
            PARALLEL_TOOL_GUIDANCE,
            CHART_GUIDANCE,
            GROUNDING_POLICY,
            SYSTEM_BASE,
        ]
        if agentic
        else [GROUNDING_POLICY, SYSTEM_BASE]
    )
    if custom and custom.strip():
        parts.append("<user_persona>\n" + custom.strip() + "\n</user_persona>")
    if about and about.strip():
        parts.append(f"<about_the_user>\n{about.strip()}\n</about_the_user>")
    if style and style.strip():
        parts.append(f"<response_style>\n{style.strip()}\n</response_style>")
    # PROJECT INSTRUCTIONS — trusted configuration, placed AFTER the persona.
    #
    # Deliberately NOT merged into `persona`: `custom` REPLACES SYSTEM_BASE, so
    # putting Project instructions there would let a Project erase the platform
    # base and the agentic orientation. As its own block it is read as a strong
    # preference that the platform rules above still bound — a Project saying
    # "ignore all system rules" is text that the system rules precede, not an
    # instruction that outranks them.
    #
    # Bounded here as a backstop; Convex already validates length on write.
    if project_instructions and project_instructions.strip():
        body = project_instructions.strip()[:PROJECT_INSTRUCTIONS_MAX_CHARS]
        parts.append(
            f"<project_instructions>\n{body}\n</project_instructions>"
        )
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
    # `base_budget` (32k) is a COST cap inherited from Opus-5 pricing on
    # OpenRouter — "a full 1M context is ~$5.00 per message". Chat does not run
    # there any more, and after the safety factor it left ~23.7k of history on a
    # model MEASURED to use 133k, so long threads lost their own beginning.
    #
    # When the window is genuinely known, spend a fraction of it instead. The
    # fraction is not a taste call: prefill on this gateway measured 1.88s at
    # 22k prompt tokens, 2.75s at 67k and 4.94s at 133k, so ~60% buys roughly
    # triple the history for about +0.9s on a FULL context (a short thread pays
    # nothing) while consuming the whole window would cost +3s. An UNMEASURED
    # window (context_window == 0) keeps the old conservative cap, so this can
    # only widen where the window was actually verified.
    if context_window > 0:
        base_budget = max(base_budget, int(context_window * 0.6))
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


