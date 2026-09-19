"""R4 + R6 — independence and coverage in the `record_research` checkpoint, and
R5 — traceability of what the answer cites to what the turn retrieved; plus the
ONE notices block that composes every end-of-turn statement in a fixed order.

The rules pinned here are HEURISTICS and are reported as such: independence is
judged by registrable domain with syndicated copies and aggregators collapsed;
one primary source is enough; nothing is ever blocked, only said.
"""

from __future__ import annotations

from datetime import date

from app.agent.executor import execute_tool_calls
from app.agent.freshness import FreshnessLedger, SourceDate, detect_requirement, url_key
from app.research.tool import (
    Finding,
    ResearchContext,
    has_primary,
    independent_count,
    registrable_domain,
)
from app.runtime.ledger import build_ledger
from app.runtime.notices import render_turn_notices
from app.runtime.traceability import render_traceability, uncited_tables
from tests.test_research_tool import _call, _ctx

T = date(2026, 9, 18)


# ------------------------------------------------------------- independence


def test_registrable_domain_handles_two_level_tlds_and_www():
    assert registrable_domain("https://www.rbi.org.in/x") == "rbi.org.in"
    assert registrable_domain("https://news.bbc.co.uk/a") == "bbc.co.uk"
    assert registrable_domain("https://blog.example.com/a") == "example.com"
    assert registrable_domain("nonsense") == ""


def _f(url, title="", stype="news", supports=True):
    return Finding(registrable_domain(url), title, stype, supports)


def test_two_domains_are_two_sources_and_one_domain_is_one():
    assert independent_count([_f("https://a.com/1"), _f("https://a.com/2")]) == 1
    assert independent_count([_f("https://a.com/1"), _f("https://b.com/2")]) == 2


def test_syndicated_copies_collapse_by_headline():
    head = "RBI keeps repo rate unchanged at 6.5% in September policy"
    fs = [
        _f("https://a.com/1", head),
        _f("https://b.com/1", head),
        _f("https://c.com/1", head),
    ]
    assert independent_count(fs) == 1
    # short generic titles do not collapse distinct reporting
    assert (
        independent_count(
            [_f("https://a.com/1", "Home"), _f("https://b.com/1", "Home")]
        )
        == 2
    )


def test_aggregators_never_add_independence():
    fs = [_f("https://reuters.com/1", "x"), _f("https://www.msn.com/en-in/news/1", "y")]
    assert independent_count(fs) == 1
    assert (
        independent_count([_f("https://news.google.com/1", "y")]) == 1
    )  # alone it counts


def test_a_non_supporting_finding_is_not_evidence():
    assert independent_count([_f("https://a.com/1", supports=False)]) == 0


def test_a_single_primary_source_is_sufficient():
    assert has_primary([_f("https://rbi.org.in/press", "PR", stype="official")])
    assert not has_primary([_f("https://blog.com/x", stype="news")])


# ----------------------------------------------------------------- coverage


def _rc(subs, *, time_sensitive=True):
    rc = ResearchContext(settings=object(), run_id="r1")
    rc.subquestions = list(subs)
    rc.time_sensitive = time_sensitive
    return rc


def test_uncovered_and_single_sourced_are_reported_and_primary_is_exempt():
    rc = _rc(["pricing", "reviews", "regulation", "history"])
    rc.add_finding(
        {
            "subquestion": "pricing",
            "sourceUrl": "https://www.rbi.org.in/p",  # a VERIFIED primary domain
            "sourceTitle": "Pricing",
            "sourceType": "official",
        }
    )
    rc.add_finding(
        {
            "subquestion": "reviews",
            "sourceUrl": "https://blog.com/r",
            "sourceTitle": "A review",
            "sourceType": "news",
        }
    )
    rc.add_finding(
        {
            "subquestion": "regulation",
            "sourceUrl": "https://a.com/1",
            "sourceTitle": "Reg A",
            "sourceType": "news",
        }
    )
    rc.add_finding(
        {
            "subquestion": "regulation",
            "sourceUrl": "https://b.com/1",
            "sourceTitle": "Reg B",
            "sourceType": "news",
        }
    )
    cov = rc.coverage()
    assert cov["uncovered"] == ["history"]
    assert cov["single_sourced"] == ["reviews"]  # pricing: one PRIMARY source → fine


def test_low_risk_runs_do_not_flag_single_sources():
    rc = _rc(["reviews"], time_sensitive=False)
    rc.add_finding(
        {
            "subquestion": "reviews",
            "sourceUrl": "https://blog.com/r",
            "sourceTitle": "A review",
            "sourceType": "news",
        }
    )
    assert rc.coverage() == {"uncovered": [], "single_sourced": []}
    assert rc.coverage(strict_window=True) == {
        "uncovered": [],
        "single_sourced": ["reviews"],
    }


def test_conflicting_sources_both_count_and_are_not_merged():
    rc = _rc(["price"])
    rc.add_finding(
        {
            "subquestion": "price",
            "sourceUrl": "https://a.com/1",
            "sourceTitle": "Price is 10",
            "sourceType": "news",
        }
    )
    rc.add_finding(
        {
            "subquestion": "price",
            "sourceUrl": "https://b.com/1",
            "sourceTitle": "Price is 12",
            "sourceType": "news",
        }
    )
    assert rc.coverage() == {"uncovered": [], "single_sourced": []}
    assert len(rc.findings["price"]) == 2


async def test_complete_reports_gaps_but_still_records():
    ctx, convex, rc = _ctx()
    await execute_tool_calls(
        [
            _call(
                kind="plan",
                objective="compare",
                subquestions=["a", "b"],
                time_sensitive=True,
            )
        ],
        ctx,
    )
    await execute_tool_calls(
        [
            _call(
                "c2",
                kind="finding",
                subquestion="a",
                claim="x",
                source_url="https://blog.com/x",
                source_title="X",
                source_type="news",
            )
        ],
        ctx,
    )
    msgs = await execute_tool_calls([_call("c3", kind="complete")], ctx)
    body = msgs[0].content
    assert '"recorded_with_gaps"' in body and '"uncovered": ["b"]' in body
    assert '"single_sourced": ["a"]' in body and "GAP" in body
    assert any(
        c.get("kind") == "complete"
        for c in convex.calls
        if c.get("op") == "research-checkpoint"
    )
    assert ctx.writer.research_coverage == {"uncovered": ["b"], "single_sourced": ["a"]}


async def test_finding_result_carries_the_independent_count():
    ctx, convex, rc = _ctx()
    await execute_tool_calls(
        [_call(kind="plan", objective="o", subquestions=["a"])], ctx
    )
    m1 = await execute_tool_calls(
        [
            _call(
                "c2",
                kind="finding",
                subquestion="a",
                claim="x",
                source_url="https://a.com/1",
                source_title="Title A one",
            )
        ],
        ctx,
    )
    m2 = await execute_tool_calls(
        [
            _call(
                "c3",
                kind="finding",
                subquestion="a",
                claim="y",
                source_url="https://b.com/1",
                source_title="Title B two",
            )
        ],
        ctx,
    )
    assert '"independent_sources_for_subquestion": 1' in m1[0].content
    assert '"independent_sources_for_subquestion": 2' in m2[0].content


# ------------------------------------------------------------- traceability


def _ledger(*retrieved, read=()):
    fl = FreshnessLedger(
        requirement=None, web_available=True, search_calls=1, search_ok=1
    )
    for u in retrieved:
        fl.note_url(u)
    for u in read:
        fl.note_read(u)
    return fl


def test_no_retrieval_means_no_traceability_note():
    assert render_traceability("A plain answer.", FreshnessLedger()) == ""
    assert render_traceability("A plain answer.", None) == ""


def test_sourced_answer_is_silent():
    fl = _ledger("https://a.com/x", read=("https://a.com/x",))
    text = "Rates fell [1].\n\n## Sources\n[1] A — https://a.com/x (news, 2026-09-10)"
    assert render_traceability(text, fl) == ""


def test_zero_links_after_retrieval_lists_what_was_read():
    fl = _ledger("https://a.com/x", "https://b.com/y", read=("https://a.com/x",))
    out = render_traceability("Rates fell 20%.", fl)
    assert "Sources consulted but not cited" in out and "https://a.com/x" in out


def test_a_cited_url_that_was_never_retrieved_is_named():
    fl = _ledger("https://a.com/x")
    out = render_traceability("Per https://made-up.example/report rates fell.", fl)
    assert "not retrieved in this turn" in out and "made-up.example" in out


def test_the_bare_domain_of_a_consulted_site_is_accepted():
    fl = _ledger("https://rbi.org.in/press/123")
    assert (
        render_traceability("See https://rbi.org.in for details [1].\n[1] x", fl) == ""
    )


def test_dangling_markers_are_named():
    fl = _ledger("https://a.com/x")
    out = render_traceability(
        "Rates fell [1][2].\n\n## Sources\n[1] A — https://a.com/x", fl
    )
    assert "[2]" in out and "does not list" in out


def test_numeric_tables_need_a_source_nearby():
    table = "| Month | Rate |\n|---|---|\n| Jan | 6.5% |\n| Feb | 6.25% |\n"
    assert uncited_tables("Here:\n" + table) == 1
    assert uncited_tables("Per [1]:\n" + table) == 0
    assert uncited_tables(table + "\nSource: https://rbi.org.in/x") == 0
    assert uncited_tables("| A | B |\n|---|---|\n| x | y |\n") == 0  # no figures
    fl = _ledger("https://a.com/x")
    out = render_traceability("Rates [1](https://a.com/x).\n" + "\n\n\n\n" + table, fl)
    assert "table(s) of figures carry no source reference" in out


# ------------------------------------------------------------------ notices


def test_one_block_in_a_fixed_order_with_no_duplicate_fact():
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    ledger.note_tool(ok=False)
    ledger.assess("Metadata audited.")
    fl = FreshnessLedger(
        requirement=detect_requirement("What changed this week in fintech?", T),
        web_available=True,
    )
    out = render_turn_notices(
        "Metadata audited. Download: report.pdf",
        ledger=ledger,
        freshness=fl,
        research_coverage={"uncovered": ["sitemap policy"], "single_sourced": []},
        artifacts=[],
        external_tool_succeeded=False,
        search_returned_nothing=True,  # superseded by the freshness statement
        finish_reason="length",
    )
    assert out.count("\n\n---\n\n") == 1
    order = [
        out.index("Not covered in this answer"),
        out.index("no search was run"),
        out.index("No evidence was recorded"),
        out.index("report.pdf"),
        out.index("length limit"),
    ]
    assert order == sorted(order)
    assert "returned no usable results" not in out  # not said twice
    assert out.count("length limit") == 1


def test_a_clean_turn_renders_nothing():
    out = render_turn_notices(
        "Fine.",
        ledger=None,
        freshness=FreshnessLedger(),
        research_coverage=None,
        artifacts=[],
        external_tool_succeeded=False,
        search_returned_nothing=False,
        finish_reason="stop",
    )
    assert out == ""


def test_the_plain_no_evidence_notice_survives_without_a_requirement():
    out = render_turn_notices(
        "Nothing found.",
        ledger=None,
        freshness=FreshnessLedger(),
        research_coverage=None,
        artifacts=[],
        external_tool_succeeded=False,
        search_returned_nothing=True,
        finish_reason="stop",
    )
    assert "returned no usable results" in out


def test_url_key_used_by_both_sides_agrees():
    fl = FreshnessLedger()
    fl.note_url(
        "https://A.com/x/?utm_campaign=z", SourceDate(date(2026, 9, 1), "snippet")
    )
    assert url_key("https://a.com/x") in fl.dates
