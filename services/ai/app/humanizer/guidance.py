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

__all__ = ["BLOG_STAGE", "HUMANIZER_GUIDANCE", "MARKETING_STAGE", "REPORT_STAGE"]

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
    "ONLY the spans it names, then call mode='verify' with the `draft_id` detect "
    "returned and your rewrite as `after`, and restore anything it reports under "
    "`lost` and delete anything under `added_claims` before you answer. "
    "PRESERVE EXACTLY, always: every factual claim, number, statistic, date, "
    "citation, source, URL and link, direct quotation, required keywords (and "
    "where they sit: title and opening paragraph), heading meaning, code, evidence "
    "labels and tags (FACT/INFERENCE/ASSUMPTION/RECOMMENDATION, 🟢🟡🔴 — never "
    "upgrade one), "
    "and everything the user asked for — you are changing voice, never "
    "substance, and you never add a fact, figure or source that was not already "
    "there. Keep reference, API, legal and compliance text neutral "
    "(register='technical'); do not make anything artificially casual or chatty. "
    "If the user supplied a writing sample, pass it as `sample` and match that "
    "voice. THIS STEP IS INVISIBLE: never mention it, never announce it as a "
    "stage, never report its score, and never add a section about it."
)


# --------------------------------------------------------------------------- #
# Per-skill stage clauses.
#
# These used to be written INTO the Blog, Marketing and Report Writing skills'
# static text, which meant that with the flag OFF every Blog prompt still told
# the model to call `humanize_check` — a tool that was not bound. Found while
# writing the flag-off control test. They now live here and are appended by
# `runtime.roster.effective_skills` ONLY when `ai_humanizer_enabled`, so OFF is
# byte-identical to the skills as they were before the humanizer existed.
# --------------------------------------------------------------------------- #

#: Appended to the Blog skill's instructions. Carries its own ordering and its
#: own no-announce rule, because the Blog skill narrates every stage it enters.
BLOG_STAGE = (
    "WRITING-QUALITY PASS (internal, silent): after the OllaSuper Blog Quality "
    "Score is in band and BEFORE the final structural/format QA pass, call "
    "`humanize_check` mode='detect' on the finished draft. verdict 'ship_as_is' "
    "-> deliver it UNCHANGED. verdict 'revise' -> rewrite ONLY the spans it names, "
    "then `humanize_check` mode='verify' (draft_id=the id detect returned, "
    "after=your rewrite, keywords=the target terms) and restore everything it "
    "lists under `lost` / delete everything under `added_claims`. It changes VOICE "
    "ONLY: every statistic, source, URL, direct quotation, internal-link marker, "
    "image placeholder, target keyword (and its place in the H1 and opening "
    "paragraph) and heading meaning survives, and the score block, its caption and "
    "the Sources section are NEVER touched. SCORE HONESTY: if the draft was "
    "revised, re-run blog.readability on the revised text and let the Content "
    "quality sub-score reflect THAT measurement, up or down; change no category "
    "without a re-measurement. INVISIBLE: this is the one stage you never announce "
    "or name while narrating your progress, never report its own score for, and "
    "never add a section about."
)

#: Appended to the Marketing skill's output expectations. Measured: launch
#: emails and newsletters route to Marketing, so this is where content lands.
MARKETING_STAGE = (
    "WRITING-QUALITY PASS (internal, silent, before you deliver any copy — email, "
    "post, landing copy, ad, newsletter, one-pager): call `humanize_check` "
    "mode='detect' on the finished copy. 'ship_as_is' -> deliver it UNCHANGED; "
    "'revise' -> rewrite ONLY the spans it names, then mode='verify' with the "
    "draft_id and your rewrite, and restore whatever it lists under `lost`. Voice "
    "only: every number, date, claim, source and quotation stays, and the FACT / "
    "INFERENCE / ASSUMPTION / RECOMMENDATION labels and 🟢 / 🟡 / 🔴 tags are "
    "never removed, merged or upgraded. Never mention the pass, its score, or a "
    "section about it."
)

#: Appended to Report Writing's methodology (it activates on its own vocabulary:
#: "summary report with recommendations" scored 0.75).
REPORT_STAGE = (
    "Before delivering, run the internal writing-quality pass on the finished text "
    "(`humanize_check` detect, then revise-and-verify by draft_id only if it says "
    "'revise'); it changes voice, never facts, and is never mentioned in the answer."
)
