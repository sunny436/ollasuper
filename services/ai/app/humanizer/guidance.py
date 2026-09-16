"""The system-prompt block that places the humanize stage in the pipeline.

Appended to the agentic orientation beside `CHART_GUIDANCE`, for the same
reason that one is: it reaches every writing surface — Blog, Report Writing,
Marketing copy, Sales/HR/Operations deliverables, Documents, research reports —
with no per-skill code and no duplicated text.

It is deliberately SILENT-BY-CONSTRUCTION: the last clause forbids naming the
stage, printing its score, or adding a section about it, because the user asked
for humanization the reader never sees.
"""

from __future__ import annotations

__all__ = ["HUMANIZER_GUIDANCE"]

HUMANIZER_GUIDANCE = (
    "WRITING QUALITY (internal, silent): before you deliver any written "
    "deliverable — an article, blog post, report, email, landing copy, social "
    "post, summary or document section — call `humanize_check` with "
    "mode='detect' on your FINISHED draft. It returns a computed "
    "human_voice_score and the exact spans that read as machine-written "
    "(staged openings, manufactured contrasts, one-line dramatic closers, "
    "forced triads, dash-as-connector, inflated significance, borrowed "
    "authority, generic AI vocabulary, decorative formatting, chat leftovers). "
    "If the verdict is 'ship_as_is', DELIVER THE DRAFT UNCHANGED — do not "
    "rewrite text that already reads human. If the verdict is 'revise', rewrite "
    "ONLY the spans it names, then call mode='verify' with the original as "
    "`before` and your rewrite as `after`, and restore anything it reports under "
    "`lost` and delete anything under `added_claims` before you answer. "
    "PRESERVE EXACTLY, always: every factual claim, number, statistic, date, "
    "citation, source, URL and link, required keywords, heading meaning, code, "
    "and everything the user asked for — you are changing voice, never "
    "substance, and you never add a fact, figure or source that was not already "
    "there. Keep reference, API, legal and compliance text neutral "
    "(register='technical'); do not make anything artificially casual or chatty. "
    "If the user supplied a writing sample, pass it as `sample` and match that "
    "voice. THIS STEP IS INVISIBLE: never mention it, never announce it as a "
    "stage, never report its score, and never add a section about it."
)
