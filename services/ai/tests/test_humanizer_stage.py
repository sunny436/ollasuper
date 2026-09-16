"""The humanize stage's decisions, pure: what gets rewritten, what is protected,
and when a rewrite is refused in favour of the draft.

Rewrites are written as a person would, then expressed in the draft's token
space (`in_token_space`) — exactly what the real rewriter receives and returns,
since every verifiable atom of the draft reaches it as a placeholder.
"""

from __future__ import annotations

import re

from app.humanizer import preserve, stage
from app.humanizer.patterns import DEFAULT_THRESHOLD, human_voice_score
from tests.humanizer_fixtures import BLOG_TAIL, CLEAN, DRAFT, REWRITE, in_token_space

_TOKEN = re.compile("⟦P" + r"\d+" + "⟧")


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text)


def _a():
    return stage.assess(DRAFT, register="prose")


def _rw(text: str, draft: str = DRAFT) -> str:
    return in_token_space(text, draft)


# ------------------------------------------------------------------ gating
def test_only_writing_skills_set_a_register():
    assert stage.register_for(["marketing", "sales"]) == "prose"
    assert stage.register_for(["blog-assist"]) == "prose"
    assert stage.register_for(["report-writing"]) == "technical"
    assert stage.register_for(["report-writing", "marketing"]) == "prose"
    assert stage.register_for(["sales", "hr"]) == "prose"
    assert stage.register_for(["seo-audit", "finance"]) is None
    assert stage.register_for([]) is None


def test_the_gate_holds_writing_and_never_code_or_analysis():
    assert stage.gate([], "Create landing page copy for a meditation app") == "prose"
    assert stage.gate([], "Write a cover letter for a data analyst role") == "prose"
    assert stage.gate(["sales", "documents"], "Draft a customer newsletter") == "prose"
    assert stage.gate(["hr"], "Write a job description for an engineer") == "prose"
    assert (
        stage.gate(["operations"], "Write an SOP for invoice approval") == "technical"
    )
    # Code, whatever skill discovery matched (prod: React -> documents).
    assert stage.gate([], "Write a Python function to parse a CSV file") is None
    assert stage.gate(["documents"], "Create a React component for a login") is None
    assert stage.gate(["finance"], "Write unit tests for this function") is None
    # Analysis with no writing skill beside it.
    assert stage.gate(["finance"], "Build a DCF model for Tesla") is None


def test_a_machine_shaped_draft_is_revised_a_human_one_ships_short_text_is_left():
    assert _a().decision == "revise"
    clean = stage.assess(CLEAN, register="prose")
    assert clean.decision == "clean" and clean.score >= DEFAULT_THRESHOLD
    assert stage.assess("Thanks! Sent.", register="prose").decision == "short"


# ------------------------------------------------------------------ protection
def test_every_verified_atom_reaches_the_rewriter_as_a_token():
    """Prod: a fast rewriter changed two figures in a report and dropped an inline
    code span from two emails; the verifier refused all three."""
    draft = DRAFT + "\nRun `pulse sync` [1] to refresh. FACT: \U0001f7e2 it works.\n"
    a = stage.assess(draft, register="prose")
    protected = set(a.slots.values())
    for atom in ("42", "38%", "https://example.com/pulse", "`pulse sync`", "[1]"):
        assert atom in protected, atom
        assert atom not in a.masked, atom
    assert any("March 3, 2026" in p for p in protected)
    assert "FACT" in protected and "\U0001f7e2" in protected
    # A voice edit that touches every unprotected word can no longer lose one.
    mangled = re.sub(r"\b([A-Z])([a-z]{3,})\b", lambda m: m[1].lower() + m[2], a.masked)
    report = preserve.verify(a.body, stage.restore(mangled, a.slots))
    assert report["lost"] == {} and report["added_claims"] == []


def test_blog_blocks_are_protected_wherever_they_sit():
    after = stage.assess(DRAFT + BLOG_TAIL, register="prose")
    assert "Quality Score" not in after.masked and "beta-report" not in after.masked
    prompt = "".join(str(m.content) for m in stage.rewrite_messages(after))
    assert "Quality Score" not in prompt and "beta-report" not in prompt
    # Prod: the Blog skill wrote its score block FIRST and the whole article was
    # put in an untouched tail.
    before = stage.assess(BLOG_TAIL.lstrip() + "\n\n" + DRAFT, register="prose")
    assert before.decision == "revise" and before.words > 120
    assert "fast-paced" in before.masked


def test_the_preface_and_quotations_are_protected_verbatim():
    """Prod: a rewrite dropped the draft's own "roughly 200 words" preface (a lost
    figure) and another reworded a quoted testimonial."""
    quote = '"Stillwater is the first app my head actually stayed quiet for."'
    draft = (
        "Here's a launch email at roughly 200 words.\n\n---\n\n"
        + DRAFT
        + f"\nOne beta user said {quote}\n"
    )
    a = stage.assess(draft, register="prose")
    protected = "".join(a.slots.values())
    assert "roughly 200 words" in protected and quote in protected
    assert "roughly 200 words" not in a.masked and quote not in a.masked
    rewrite = _rw(
        "Here's a launch email at roughly 200 words.\n\n---\n\n"
        + REWRITE
        + f"\nOne beta user said {quote}\n",
        draft,
    )
    assert stage.accept(a, rewrite).ok
    assert stage.restore(rewrite, a.slots).startswith("Here's a launch email")


def test_a_prose_fence_is_rewritable_and_a_code_fence_is_not():
    """Prod: a launch email arrived entirely inside ```text fences and every rewrite
    was refused as "lost code"."""
    prose = stage.assess("```text\n" + DRAFT + "```\n", register="prose")
    assert prose.decision == "revise" and "fast-paced" in prose.masked
    code = stage.assess("```python\n" + DRAFT + "```\n", register="prose")
    assert "fast-paced" not in code.masked


def test_a_lost_or_duplicated_token_is_refused():
    a = stage.assess(DRAFT + BLOG_TAIL, register="prose")
    faithful = _rw(REWRITE + BLOG_TAIL, DRAFT + BLOG_TAIL)
    assert stage.accept(a, faithful).ok
    assert stage.accept(a, REWRITE).reason == "protected_span_changed"
    doubled = faithful + _tokens(faithful)[0]
    assert stage.accept(a, doubled).reason == "protected_span_changed"


def test_tokens_split_across_stream_chunks_never_reach_the_screen():
    slots = {"⟦P1⟧": '"a quoted line that must stay"'}
    stream = stage.PlaceholderStream(slots)
    shown = stream.feed("Before ⟦") + stream.feed("P1") + stream.feed("⟧ after")
    shown += stream.flush()
    assert shown == 'Before "a quoted line that must stay" after'
    assert "⟦" not in shown


def test_density_habits_count_only_above_their_ceiling():
    """Real drafts used to saturate at 0: every dash counted once the ceiling was
    crossed. Now a few extra dashes cost a little and many cost a lot."""
    words = ("steady plain words make a calm and ordinary sentence here " * 30).split()
    base = " ".join(words)  # 300 words, no dashes
    light = base + " one — two — three — four —"
    heavy = base + " x —" * 25
    assert human_voice_score(base) == 100
    # 4 dashes in ~300 words: ~2 over the ceiling. Per-occurrence counting scored
    # this ~47; only the excess counts now.
    assert human_voice_score(light) > 60
    assert human_voice_score(heavy) < human_voice_score(light)


# ------------------------------------------------------------------ inputs
def test_required_keywords_come_only_from_a_request_that_names_keywords():
    assert stage.required_keywords(
        "Write a blog, target keyword 'best CRM for small business'"
    ) == ["best CRM for small business"]
    assert stage.required_keywords('Write about the "Pulse" launch') == []


def test_a_supplied_writing_sample_is_the_voice_reference():
    sample = "I write short. " * 40
    assert stage.writing_sample(f"Draft an email. Writing sample: {sample}")
    assert stage.writing_sample("Draft an email in a friendly voice") is None
    a = stage.assess(DRAFT, register="prose", sample=sample)
    prompt = "".join(
        str(m.content) for m in stage.rewrite_messages(a, sample=sample, keywords=["x"])
    )
    assert "I write short." in prompt and "Required keywords" in prompt


def test_the_rewrite_prompt_names_the_passages_and_the_non_negotiables():
    a = _a()
    system, user = stage.rewrite_messages(a)
    assert "Never add a fact" in system.content
    assert "Preserve EXACTLY" in system.content
    assert "Copy every token" in system.content
    assert "Output ONLY the rewritten text" in system.content
    assert "fast-paced" in user.content  # a named passage
    assert a.masked.strip() in user.content and "42" not in user.content
    technical = stage.assess(DRAFT, register="technical")
    assert "neutral" in stage.rewrite_messages(technical)[1].content


# ------------------------------------------------------------------ acceptance
def test_a_faithful_rewrite_is_accepted_and_reads_better():
    result = stage.accept(_a(), _rw(REWRITE))
    assert result.ok and result.score_after > _a().score


def test_a_dropped_figure_is_refused():
    r = stage.accept(_a(), _rw(REWRITE.replace("42 metrics", "dozens of metrics")))
    assert not r.ok and r.reason == "protected_span_changed"


def test_an_invented_figure_is_refused():
    r = stage.accept(_a(), _rw(REWRITE.replace("hours back", "12 hours back")))
    assert not r.ok and r.reason == "not_preserved" and r.added == ["12"]


def test_a_dropped_link_or_heading_is_refused():
    no_url = stage.accept(
        _a(), _rw(REWRITE.replace(" at https://example.com/pulse", ""))
    )
    assert not no_url.ok
    no_head = stage.accept(
        _a(),
        _rw(
            REWRITE.replace("# Introducing Pulse Analytics: Your New Dashboard\n\n", "")
        ),
    )
    assert not no_head.ok and "headings" in no_head.lost


def test_a_lost_required_keyword_is_refused():
    kw = ["Pulse Analytics"]
    assert stage.accept(_a(), _rw(REWRITE), keywords=kw).ok
    lost = _rw(REWRITE.replace("Pulse Analytics", "our dashboard"))
    assert not stage.accept(_a(), lost, keywords=kw).ok


def test_an_upgraded_evidence_tag_is_refused():
    draft = DRAFT.replace(
        "cut reporting time", "\U0001f534 ASSUMPTION: cut reporting time"
    )
    rewrite = REWRITE.replace(
        "Our beta teams cut", "\U0001f7e2 ASSUMPTION: Our beta teams cut"
    )
    r = stage.accept(stage.assess(draft, register="prose"), _rw(rewrite, draft))
    assert not r.ok


def test_chat_wrappers_truncation_and_wild_lengths_are_refused():
    a = _a()
    wrapped = _rw("Here is the rewritten email:\n\n" + REWRITE)
    assert stage.accept(a, wrapped).reason == "chat_wrapper"
    assert stage.accept(a, _rw(REWRITE), truncated=True).reason == "truncated"
    assert not stage.accept(a, _rw(REWRITE)[:200]).ok
    assert stage.accept(a, "   ").reason == "empty"


def test_a_preface_the_draft_already_had_is_not_a_chat_wrapper():
    opener = "Here's a launch email for your existing customers.\n\n"
    a = stage.assess(opener + DRAFT, register="prose")
    assert opener.strip() in "".join(a.slots.values())
    assert stage.accept(a, _rw(opener + REWRITE, opener + DRAFT)).ok
    # ...but a preface the rewrite INTRODUCED is still refused.
    assert stage.accept(_a(), _rw(opener + REWRITE)).reason == "chat_wrapper"


def test_a_rewrite_that_is_not_better_is_refused():
    a = _a()
    worse = a.masked.replace(
        "Let that sink in.", "Let that sink in. Additionally, a testament."
    )
    assert stage.accept(a, worse).reason == "score_not_improved"
    assert stage.accept(a, a.masked).reason == "score_not_improved"
