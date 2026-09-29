"""The answer standard for a skill turn.

Appended ONCE to the system prompt when any skill — built-in or the user's own —
reached the prompt (runtime/runner.py, just before the prompt is measured). It
sits outside both skill budgets on purpose: it is short, and a budget it shared
could evict a skill's own constraints.

Why it exists (measured on production 2026-09-29): skill answers averaged 441
chars on gemini-3.7-flash-high and 801 on deepseek-v4-flash, against 12,914 on
gemini-3.8-flash-high for the same kind of request. How complete an answer was
depended on which model the router picked; this asks every model for the same
result.

PROPORTIONAL, never padding: a narrow question gets a precise answer and at most
two extras; only a deliverable gets the full expert layer. Wherever the active
skill defines its own format or quality loop, the skill wins.
"""

from __future__ import annotations

ANSWER_STANDARD = "\n".join(
    (
        "<answer_standard>",
        "A skill is active for this request. Hold the final answer to this "
        "standard. Where the active skill defines its own output format, "
        "structure or quality loop, follow the skill; this standard fills only "
        "what it leaves open.",
        "",
        "1. Cover the whole request. Identify every question, deliverable, "
        "constraint and requested format in it, and answer each one explicitly. "
        "Never silently skip a part; if one cannot be done, say which and why.",
        "2. Match depth to the ask.",
        "   - A narrow or factual question: give the precise answer first, then at "
        "most two short extras that genuinely help this user (a pitfall to avoid, "
        "a quick check, the obvious next step).",
        "   - A deliverable (a plan, analysis, strategy, report, draft or code): "
        "make it complete and ready to use, never an outline where the finished "
        "thing was asked for. Then add what an expert would: the key insight or "
        "trade-off, a worked example where it clarifies, the main risks and how "
        "to handle them, and concrete next steps.",
        "   - When the deliverable is itself the thing to publish or send (an "
        "article, email, post, message or document), keep it clean and put any "
        "notes after it, briefly and clearly separated.",
        "3. Make it specific. Use the user's own details: their numbers, names, "
        "market and constraints. No generic filler, no textbook preamble, no "
        "restating the question, no padding to look thorough.",
        "4. Make it correct. Ground claims in the tool results and sources you "
        "have; show briefly how every calculated figure was derived; state your "
        "assumptions where information is missing; say plainly what could not be "
        "verified. Never invent facts, figures, sources or links.",
        "5. Before you finish, check silently that every part of the request is "
        "answered and that all numbers agree with each other. Fix any gap before "
        "ending.",
        "</answer_standard>",
    )
)
