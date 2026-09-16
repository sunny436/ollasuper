"""The humanize stage's decisions, pure: what gets rewritten, what is protected,
and when a rewrite is refused in favour of the draft."""

from __future__ import annotations

from app.humanizer import stage
from app.humanizer.patterns import DEFAULT_THRESHOLD, human_voice_score
from tests.humanizer_fixtures import BLOG_TAIL, CLEAN, DRAFT, REWRITE


# ------------------------------------------------------------------ gating
def test_only_writing_skills_turn_the_stage_on():
    assert stage.register_for(["marketing", "sales"]) == "prose"
    assert stage.register_for(["blog-assist"]) == "prose"
    assert stage.register_for(["report-writing"]) == "technical"
    assert stage.register_for(["report-writing", "marketing"]) == "prose"
    assert stage.register_for(["sales", "hr"]) == "prose"
    assert stage.register_for(["seo-audit", "finance"]) is None
    assert stage.register_for([]) is None


def test_a_machine_shaped_draft_is_revised_a_human_one_ships_and_short_text_is_left():
    assert stage.assess(DRAFT, register="prose").decision == "revise"
    clean = stage.assess(CLEAN, register="prose")
    assert clean.decision == "clean" and clean.score >= DEFAULT_THRESHOLD
    assert stage.assess("Thanks! Sent.", register="prose").decision == "short"


def _tokens(text: str) -> list[str]:
    import re

    return re.findall("⟦P\\d+⟧", text)


def test_post_draft_blocks_are_protected_and_never_scored_or_rewritten():
    a = stage.assess(DRAFT + BLOG_TAIL, register="prose")
    assert "Quality Score" not in a.masked and "beta-report" not in a.masked
    assert "".join(a.slots.values()).count("OllaSuper Blog Quality Score") == 1
    prompt = "".join(str(m.content) for m in stage.rewrite_messages(a))
    assert "Quality Score" not in prompt and "beta-report" not in prompt
    assert a.decision == "revise"


def test_a_score_block_written_before_the_article_does_not_hide_the_article():
    """Prod: the Blog skill emitted its score block FIRST; a head/tail split put the
    whole article in the untouched tail and judged a 9-word sentence."""
    a = stage.assess(BLOG_TAIL.lstrip() + "\n\n" + DRAFT, register="prose")
    assert a.decision == "revise" and a.words > 120
    assert "fast-paced" in a.masked


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
    rewrite = "".join(_tokens(a.masked)[:1]) + REWRITE + " " + _tokens(a.masked)[-1]
    assert stage.accept(a, rewrite).ok
    assert stage.restore(rewrite, a.slots).startswith("Here's a launch email")


def test_a_lost_or_duplicated_token_is_refused():
    a = stage.assess(DRAFT + BLOG_TAIL, register="prose")
    tokens = _tokens(a.masked)
    assert stage.accept(a, REWRITE).reason == "protected_span_changed"
    doubled = REWRITE + "".join(tokens) + tokens[0]
    assert stage.accept(a, doubled).reason == "protected_span_changed"
    assert stage.accept(a, REWRITE + "\n" + "\n".join(tokens)).ok


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
    a = stage.assess(DRAFT, register="prose")
    system, user = stage.rewrite_messages(a)
    assert "Never add a fact" in system.content
    assert "Preserve EXACTLY" in system.content
    assert "Output ONLY the rewritten text" in system.content
    assert "fast-paced" in user.content  # a named passage
    assert DRAFT.strip() in user.content
    technical = stage.assess(DRAFT, register="technical")
    assert "neutral" in stage.rewrite_messages(technical)[1].content


# ------------------------------------------------------------------ acceptance
def _a():
    return stage.assess(DRAFT, register="prose")


def test_a_faithful_rewrite_is_accepted_and_reads_better():
    result = stage.accept(_a(), REWRITE)
    assert result.ok and result.score_after > _a().score


def test_a_lost_figure_is_refused():
    r = stage.accept(_a(), REWRITE.replace("42 metrics", "dozens of metrics"))
    assert not r.ok and r.reason == "not_preserved" and r.lost == {"numbers": ["42"]}


def test_an_invented_figure_is_refused():
    r = stage.accept(_a(), REWRITE.replace("hours back", "12 hours back"))
    assert not r.ok and r.added == ["12"]


def test_a_lost_link_or_heading_is_refused():
    no_url = stage.accept(_a(), REWRITE.replace(" at https://example.com/pulse", ""))
    assert not no_url.ok and "urls" in no_url.lost
    no_head = stage.accept(
        _a(),
        REWRITE.replace("# Introducing Pulse Analytics: Your New Dashboard\n\n", ""),
    )
    assert not no_head.ok


def test_a_lost_required_keyword_is_refused():
    kw = ["Pulse Analytics"]
    a = stage.assess(DRAFT, register="prose")
    assert stage.accept(a, REWRITE, keywords=kw).ok
    assert not stage.accept(
        a, REWRITE.replace("Pulse Analytics", "our dashboard"), keywords=kw
    ).ok


def test_an_upgraded_evidence_tag_is_refused():
    draft = DRAFT.replace(
        "cut reporting time", "\U0001f534 ASSUMPTION: cut reporting time"
    )
    rewrite = REWRITE.replace(
        "Our beta teams cut", "\U0001f7e2 ASSUMPTION: Our beta teams cut"
    )
    r = stage.accept(stage.assess(draft, register="prose"), rewrite)
    assert not r.ok


def test_chat_wrappers_truncation_and_wild_lengths_are_refused():
    a = _a()
    assert stage.accept(a, "Here is the rewritten email:\n\n" + REWRITE).reason == (
        "chat_wrapper"
    )
    assert stage.accept(a, REWRITE, truncated=True).reason == "truncated"
    assert stage.accept(a, REWRITE[:200]).reason.startswith("length_ratio")
    assert stage.accept(a, "   ").reason == "empty"


def test_a_rewrite_that_is_not_better_is_refused():
    a = _a()
    worse = DRAFT.replace(
        "Let that sink in.", "Let that sink in. Additionally, a testament."
    )
    assert stage.accept(a, worse).reason == "score_not_improved"
    assert stage.accept(a, DRAFT).reason == "score_not_improved"


# ------------------------------------------------------------------ prod-found cases
def test_the_gate_holds_writing_and_never_code_or_analysis():
    assert stage.gate([], "Create landing page copy for a meditation app") == "prose"
    assert stage.gate([], "Write a cover letter for a data analyst role") == "prose"
    assert stage.gate(["sales", "documents"], "Draft a customer newsletter") == "prose"
    assert (
        stage.gate(["hr"], "Write a job description for a backend engineer") == "prose"
    )
    assert (
        stage.gate(["operations"], "Write an SOP for invoice approval") == "technical"
    )
    # Code, whatever skill discovery matched (prod: React -> documents).
    assert stage.gate([], "Write a Python function to parse a CSV file") is None
    assert (
        stage.gate(["documents"], "Create a React component for a login form") is None
    )
    assert stage.gate(["finance"], "Write unit tests for this function") is None
    # Analysis with no writing skill beside it.
    assert stage.gate(["finance"], "Build a DCF model for Tesla") is None


def test_a_preface_the_draft_already_had_is_not_a_chat_wrapper():
    opener = "Here's a launch email for your existing customers.\n\n"
    a = stage.assess(opener + DRAFT, register="prose")
    # The draft's own preface is protected: the rewriter only ever sees a token.
    assert opener.strip() in "".join(a.slots.values())
    assert stage.accept(a, _tokens(a.masked)[0] + REWRITE).ok
    # ...but a preface the rewrite INTRODUCED is still refused.
    assert stage.accept(_a(), opener + REWRITE).reason == "chat_wrapper"
