"""Freshness — the temporal requirement in a request and the age of what was read.

The 18.09.2026 skill audit: a "last 30 days" question answered from a two-year-old
source, a "this week" question with no date anchor, live search skipped, failures
silent. These tests pin the deterministic half of the fix: what counts as a
requirement (and what does NOT), how a source is dated and ranked, that an
unknown date never satisfies a strict window, that a stale-but-relevant result is
moved out of the results the model reads, and what the user is told at the end of
the turn in every retrieval outcome.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.agent.context import build_system_prompt, date_line
from app.agent.freshness import (
    FreshnessLedger,
    SourceDate,
    annotate_read,
    annotate_search,
    cited_urls,
    content_date,
    detect_requirement,
    parse_date,
    prefetch_query,
    render_directive,
    render_freshness,
    satisfies_window,
    snippet_date,
    url_key,
)

T = date(2026, 9, 18)


def req(text: str):
    return detect_requirement(text, T)


# --------------------------------------------------------------- requirements


@pytest.mark.parametrize(
    ("text", "kind", "cutoff"),
    [
        (
            "Summarise the last 7 days of AI announcements",
            "strict",
            T - timedelta(days=7),
        ),
        ("Give me the past 30 days of UPI news.", "strict", T - timedelta(days=30)),
        ("What changed this week in Indian fintech?", "strict", T - timedelta(days=7)),
        ("What's the weather today in Delhi?", "strict", T - timedelta(days=1)),
        ("What's the latest on the RBI repo rate?", "live", None),
        ("Current price of gold in India", "live", None),
        ("What did the Fed do since 1 Sep 2026?", "strict", date(2026, 9, 1)),
        (
            "Show me news after September 10, 2026 about Hormuz",
            "strict",
            date(2026, 9, 11),
        ),
        (
            "As of today, what is the Brent crude price?",
            "strict",
            T - timedelta(days=1),
        ),
        ("What happened recently in the EV market?", "live", None),
        ("Has anything changed this month for GST?", "strict", date(2026, 9, 1)),
        ("did the RBI change rates this week", "strict", T - timedelta(days=7)),
        (
            "What are the latest updates on the Data Act, this year?",
            "strict",
            date(2026, 1, 1),
        ),
    ],
)
def test_requirements_are_detected_with_their_cutoffs(text, kind, cutoff):
    r = req(text)
    assert r is not None, text
    assert r.kind == kind
    assert r.cutoff == cutoff
    assert r.sentence  # the retrieval query is the user's own sentence


@pytest.mark.parametrize(
    "text",
    [
        "When was UPI launched?",
        "History of the Reserve Bank of India",
        "What was the current price of gold in 2019?",
        "Explain how TCP congestion control works",
        "I've been sick for the last 3 days, draft an email to my boss",
        "I have a meeting today, help me write an agenda",
        "Write a news article about dogs",
        "Summarise the last 7 days of this conversation",
        "Sales in the last 30 days from the attached CSV — any trend?",
        "Currently I'm building a React app; help me structure it",
        "```\nlast 30 days\n```\nformat this code block",
        "> last week we agreed on X\nRewrite the quoted line more formally",
    ],
)
def test_no_requirement_for_history_own_data_or_conversation(text):
    assert req(text) is None, text


def test_strict_window_is_inclusive_with_one_day_of_grace():
    r = req("Give me the past 30 days of UPI news.")
    assert satisfies_window(r.cutoff, r, T) is True
    assert satisfies_window(r.cutoff - timedelta(days=1), r, T) is True  # grace
    assert satisfies_window(r.cutoff - timedelta(days=2), r, T) is False
    assert satisfies_window(T, r, T) is True
    assert satisfies_window(T + timedelta(days=9), r, T) is None  # future = untrusted
    assert satisfies_window(None, r, T) is None


def test_live_requirement_has_no_cutoff_to_enforce():
    r = req("What's the latest on the RBI repo rate?")
    assert satisfies_window(date(2020, 1, 1), r, T) is None


# --------------------------------------------------------------------- dates


def test_only_unambiguous_date_forms_parse():
    assert parse_date("2026-09-12", T) == date(2026, 9, 12)
    assert parse_date("12 Sep 2026", T) == date(2026, 9, 12)
    assert parse_date("Sep 12, 2026", T) == date(2026, 9, 12)
    assert parse_date("September 2026", T) == date(2026, 9, 1)
    assert parse_date("3 days ago", T) == T - timedelta(days=3)
    assert parse_date("12/09/2026", T) is None  # day-first or month-first? not guessed
    assert parse_date("31 Feb 2026", T) is None


def test_snippet_date_is_the_engine_annotation_at_the_start_only():
    # the live provider glues the date to the text: "Jul 15, 2026Postmortem as…"
    sd = snippet_date("Jul 15, 2026Postmortem as compliance exercise", T)
    assert sd == SourceDate(date(2026, 7, 15), "snippet")
    assert snippet_date("3 days ago · Something happened", T).value == T - timedelta(3)
    # a date INSIDE the snippet is content, not a publication date
    assert snippet_date("The launch on Jul 15, 2026 was delayed", T) is None
    assert snippet_date("", T) is None


def test_content_date_ranks_published_over_updated_over_inferred():
    assert content_date("Published: 2026-09-01 · Updated: 2026-09-12\nbody", T) == (
        SourceDate(date(2026, 9, 1), "published")
    )
    assert content_date("Last updated 12 Sep 2026\nbody", T).kind == "updated"
    assert content_date("# Title\n\nApril 16, 2026 — 22 min read\n\nBody", T) == (
        SourceDate(date(2026, 4, 16), "published")  # a byline dateline
    )
    assert (
        content_date("# Title\n\nsome text mentioning 2026-03-03 in prose", T).kind
        == "inferred"
    )
    assert content_date("no dates here at all", T) is None
    # a date deep in the page is not a dateline
    assert content_date("x" * 3000 + " 2026-01-01", T) is None


def test_url_key_canonicalises_tracking_params_and_case():
    a = url_key("HTTPS://Example.com/Path/?utm_source=x&id=1#frag")
    b = url_key("https://example.com/Path?id=1")
    assert a == b


# ---------------------------------------------------------------- annotation


def _payload(*results):
    return {"status": "success", "count": len(results), "results": list(results)}


def _hit(url, snippet, title="t"):
    return {"title": title, "url": url, "snippet": snippet, "rank": 1}


def test_strict_window_moves_stale_results_out_and_keeps_undated_ones_flagged():
    r = req("Give me the past 30 days of UPI news.")
    out, facts = annotate_search(
        _payload(
            _hit("https://old.com/a", "Sep 12, 2024Highly relevant but two years old"),
            _hit("https://new.com/b", "Sep 10, 2026Fresh"),
            _hit("https://nodate.com/c", "no date at all"),
        ),
        r,
        T,
    )
    urls = [x["url"] for x in out["results"]]
    assert "https://old.com/a" not in urls  # relevance does not rescue a stale source
    assert out["excluded_stale"] == [
        {"url": "https://old.com/a", "title": "t", "date": "2024-09-12"}
    ]
    assert out["count"] == 2
    fresh = next(x for x in out["results"] if x["url"] == "https://new.com/b")
    assert fresh["date"] == "2026-09-10" and fresh["date_kind"] == "snippet"
    undated = next(x for x in out["results"] if x["url"] == "https://nodate.com/c")
    assert undated["date"] is None and "does not satisfy" in undated["date_note"]
    assert out["freshness"]["cutoff"] == "2026-08-19"
    assert out["freshness"]["compliant"] == 1 and out["freshness"]["undated"] == 1
    assert facts["compliant"] == 1 and facts["excluded"] == 1


def test_nothing_compliant_tells_the_model_to_search_again_or_say_so():
    r = req("What changed this week in fintech?")
    out, facts = annotate_search(
        _payload(
            _hit("https://old.com/a", "Jan 5, 2026old"),
            _hit("https://x.com", "undated"),
        ),
        r,
        T,
    )
    assert facts["compliant"] == 0
    assert "Search again" in out["freshness"]["note"]
    assert "September 2026" in out["freshness"]["note"]


def test_live_requirement_dates_results_but_excludes_nothing():
    r = req("What's the latest on the RBI repo rate?")
    out, _ = annotate_search(
        _payload(_hit("https://old.com/a", "Sep 12, 2024old")), r, T
    )
    assert len(out["results"]) == 1 and out["results"][0]["date"] == "2024-09-12"
    assert "excluded_stale" not in out


def test_results_are_never_reordered():
    r = req("What changed this week in fintech?")
    hits = [_hit(f"https://s{i}.com", "Sep 15, 2026x") for i in range(5)]
    out, _ = annotate_search(_payload(*hits), r, T)
    assert [x["url"] for x in out["results"]] == [h["url"] for h in hits]


def test_read_page_is_dated_from_its_dateline_and_flagged_when_stale():
    r = req("Give me the past 30 days of UPI news.")
    page = {
        "status": "success",
        "url": "https://a.com/p",
        "content": "Published: 2 Jan 2025\n\nBody",
    }
    out, facts = annotate_read(page, r, T)
    assert (
        out["stale_for_request"] is True
        and "do not cite as current" in out["freshness_note"]
    )
    assert out["content"] == page["content"]  # content is kept, only flagged
    assert facts["dates"]["https://a.com/p"].kind == "published"
    fresh = {
        "status": "success",
        "url": "https://b.com/p",
        "content": "Updated: 2026-09-15\nBody",
    }
    out2, _ = annotate_read(fresh, r, T)
    assert "stale_for_request" not in out2 and out2["date_kind"] == "updated"
    batch = {"results": [page, fresh]}
    out3, facts3 = annotate_read(batch, r, T)
    assert out3["results"][0]["stale_for_request"] is True
    assert set(facts3["dates"]) == {"https://a.com/p", "https://b.com/p"}


# ------------------------------------------------------------------- ledger


def test_ledger_keeps_the_best_ranked_date_per_url():
    fl = FreshnessLedger()
    fl.note_url("https://a.com/x", SourceDate(date(2026, 1, 1), "inferred"))
    fl.note_url("https://a.com/x/", SourceDate(date(2026, 2, 2), "published"))
    fl.note_url("https://a.com/x", SourceDate(date(2026, 3, 3), "reported"))
    assert fl.dates[url_key("https://a.com/x")] == SourceDate(
        date(2026, 2, 2), "published"
    )
    assert url_key("https://a.com/x") in fl.retrieved_urls


# ------------------------------------------------------------------ notices


def _ledger(text, **kw):
    fl = FreshnessLedger(requirement=req(text), web_available=True)
    for k, v in kw.items():
        setattr(fl, k, v)
    return fl


def test_compliant_turn_renders_nothing():
    fl = _ledger(
        "Give me the past 30 days of UPI news.",
        search_calls=1,
        search_ok=1,
        search_compliant=1,
    )
    fl.note_url("https://new.com/b", SourceDate(date(2026, 9, 10), "snippet"))
    assert render_freshness("Per [1](https://new.com/b), rates fell.", fl, T) == ""


def test_ordinary_historical_turn_renders_nothing():
    fl = FreshnessLedger(requirement=None, web_available=True)
    assert render_freshness("UPI launched in April 2016.", fl, T) == ""


def test_no_search_run_is_said_unless_the_answer_already_admits_it():
    fl = _ledger("What changed this week in fintech?")
    out = render_freshness("Rates went up.", fl, T)
    assert "no search was run" in out and "this week" in out
    honest = "I could not verify current figures; this may be out of date."
    assert render_freshness(honest, fl, T) == ""


def test_web_unavailable_is_said():
    fl = _ledger("What changed this week in fintech?")
    fl.web_available = False
    assert "not available" in render_freshness("Rates went up.", fl, T)


def test_provider_failure_is_said_not_hidden():
    fl = _ledger("Current price of gold in India", search_calls=2, search_failed=2)
    out = render_freshness("Gold is at ₹74,000.", fl, T)
    assert "search failed" in out and "provider error" in out


def test_zero_results_under_a_requirement_is_reported_as_unverified():
    fl = _ledger("Give me the past 30 days of UPI news.", search_calls=1, search_ok=0)
    out = render_freshness("Nothing much happened.", fl, T)
    assert "No cited source could be verified" in out


def test_stale_cited_source_is_named_with_its_date_even_when_relevant():
    fl = _ledger("Give me the past 30 days of UPI news.", search_calls=1, search_ok=1)
    fl.note_url("https://old.com/a", SourceDate(date(2024, 9, 12), "snippet"))
    out = render_freshness("UPI volumes rose [1](https://old.com/a).", fl, T)
    assert "2024-09-12" in out and "older than that" in out
    assert "on or after 2026-08-19" in out


def test_unknown_dates_never_satisfy_a_strict_window():
    fl = _ledger("Give me the past 30 days of UPI news.", search_calls=1, search_ok=1)
    fl.note_url("https://nodate.com/c")  # retrieved, no date
    out = render_freshness("See https://nodate.com/c.", fl, T)
    assert "no verifiable date" in out


def test_cited_urls_are_extracted_from_links_and_bare_urls():
    text = "A [1](https://a.com/x?utm_source=z) and https://b.com/y. ```https://code.com```"
    assert cited_urls(text) == [url_key("https://a.com/x"), url_key("https://b.com/y")]


# ---------------------------------------------------- directive + prefetch


def test_directive_names_the_cutoff_and_prefetch_query_adds_the_month():
    r = req("What changed this week in Indian fintech?")
    assert "2026-09-11" in render_directive(r)
    assert (
        prefetch_query(r, T)
        == "What changed this week in Indian fintech September 2026"
    )
    y = req("What happened this year in the EV market?")
    assert prefetch_query(y, T).endswith(" 2026")
    live = req("Current price of gold in India")
    assert prefetch_query(live, T) == "Current price of gold in India"


def test_the_system_prompt_carries_the_date_anchor_on_both_branches():
    assert date_line(T) == "Today's date: 2026-09-18 (UTC)."
    for agentic in (False, True):
        p = build_system_prompt(
            custom=None,
            about=None,
            style=None,
            summary=None,
            summary_through_seq=0,
            agentic=agentic,
            today=T,
        )
        assert "Today's date: 2026-09-18 (UTC)." in p
