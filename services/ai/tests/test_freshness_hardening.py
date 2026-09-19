"""Hardening pass (19-09-2026) on the freshness / evidence layer.

1. more phrasings recognised, "today's agenda" still not a requirement;
2. a primary-source exemption needs a VERIFIED primary domain, not a claim;
3. a `live` request is checked against real source dates (90-day window);
4. the prefetch runs TWO queries — a dated one and a wider one;
5. a stale page's body is WITHHELD under a strict window; a URL the model
   produced from memory is marked as not-from-search;
6. a strict failure is a prominent statement the streamed answer cannot soften;
8. readiness names the LibreOffice components and refuses a misconfiguration.
"""

from __future__ import annotations

from datetime import date, timedelta

import httpx
import pytest

from app.agent.executor import execute_tool_calls
from app.agent.freshness import (
    LIVE_WINDOW_DAYS,
    FreshnessLedger,
    SourceDate,
    annotate_read,
    annotate_search,
    detect_requirement,
    prefetch_queries,
    render_freshness,
)
from app.research.tool import Finding, has_primary, is_primary_domain, primary_status
from tests.test_freshness_executor import SCRAPE_ID, _ctx, _iso, _tool

T = date(2026, 9, 19)


def req(text):
    return detect_requirement(text, T)


# ------------------------------------------------------------- 1. phrasings


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("What's the latest on the Hormuz shipping situation?", "live"),
        ("Any updates on the EU AI Act enforcement?", "live"),
        ("What's happening with the rupee lately?", "live"),
        ("Is the 2024 UPI fee waiver still in effect?", "live"),
        ("Give me the most recent figures for EV sales in India", "live"),
        ("Show me what changed over the past couple of weeks in fintech", "strict"),
        ("What happened in the last 24 hours in crypto markets?", "strict"),
        ("What did the RBI announce this morning?", "strict"),
        ("What's the latest from NPCI regarding UPI Lite?", "live"),
    ],
)
def test_more_phrasings_are_recognised(text, kind):
    r = req(text)
    assert r is not None and r.kind == kind, text


def test_windows_for_the_new_strict_phrasings():
    assert req("What changed in the last 24 hours in crypto?").cutoff == T - timedelta(
        1
    )
    assert req(
        "What changed over the past couple of weeks in fintech?"
    ).cutoff == T - timedelta(14)
    assert req("What changed in the past few days in fintech?").cutoff == T - timedelta(
        3
    )
    assert req("What did the RBI announce this morning?").cutoff == T - timedelta(1)


@pytest.mark.parametrize(
    "text",
    [
        "What's on today's agenda?",
        "Summarise today's meeting notes",
        "Help me plan tonight's dinner",
        "What are this week's priorities for my team?",
        "Draft today's standup update",
        "I want the newest laptop; help me write a purchase justification",
    ],
)
def test_the_users_own_day_is_not_a_requirement(text):
    assert req(text) is None, text


def test_todays_news_still_is():
    assert req("What's in today's news on the rupee?").kind == "strict"


# ------------------------------------------------ 2. verified primary sources


def test_primary_status_is_decided_by_the_domain_not_the_claim():
    gov = Finding("rbi.org.in", "Press release", "official", True)
    claimed = Finding("vendor.com", "Pricing", "official", True)
    blog = Finding("blog.com", "A take", "news", True)
    assert primary_status(gov) == "verified"
    assert primary_status(claimed) == "claimed"
    assert primary_status(blog) == "none"
    assert has_primary([gov]) and not has_primary([claimed]) and not has_primary([blog])
    assert is_primary_domain("sebi.gov.in") and is_primary_domain("mit.edu")
    assert is_primary_domain("eur-lex.europa.eu") and is_primary_domain("who.int")
    assert not is_primary_domain("medium.com") and not is_primary_domain("")


def test_a_claimed_primary_no_longer_exempts_a_single_source():
    from app.research.tool import ResearchContext

    rc = ResearchContext(settings=object(), run_id="r1")
    rc.subquestions = ["pricing"]
    rc.time_sensitive = True
    n, status = rc.add_finding(
        {
            "subquestion": "pricing",
            "sourceUrl": "https://vendor.com/p",
            "sourceTitle": "Pricing",
            "sourceType": "official",
        }
    )
    assert (n, status) == (1, "claimed")
    assert rc.coverage() == {"uncovered": [], "single_sourced": ["pricing"]}
    n, status = rc.add_finding(
        {
            "subquestion": "pricing",
            "sourceUrl": "https://www.rbi.org.in/x",
            "sourceTitle": "Circular",
            "sourceType": "official",
        }
    )
    assert status == "verified"
    assert rc.coverage() == {"uncovered": [], "single_sourced": []}


# ------------------------------------------------- 3. live recency check


def _live_ledger(**kw):
    fl = FreshnessLedger(
        requirement=req("What's the latest on the RBI repo rate?"),
        web_available=True,
        search_calls=1,
        search_ok=1,
    )
    for k, v in kw.items():
        setattr(fl, k, v)
    return fl


def test_live_results_older_than_the_window_are_marked_not_removed():
    r = req("Current price of gold in India")
    out, facts = annotate_search(
        {
            "results": [
                {"url": "https://old.com/a", "snippet": f"{_iso(400)}old"},
                {"url": "https://new.com/b", "snippet": f"{_iso(3)}new"},
            ]
        },
        r,
        T,
    )
    by = {x["url"]: x for x in out["results"]}
    assert by["https://old.com/a"].get("old_for_live") is True
    assert "old_for_live" not in by["https://new.com/b"]
    assert (
        out["freshness"]["recent"] == 1
        and str(LIVE_WINDOW_DAYS) in out["freshness"]["note"]
    )


def test_live_answer_citing_only_old_sources_is_told_so():
    fl = _live_ledger()
    fl.note_url("https://old.com/a", SourceDate(T - timedelta(days=400), "snippet"))
    out = render_freshness("The rate is 6.5% [1](https://old.com/a).", fl, T)
    assert "Recency check" in out and "older than 90 days" in out and "old.com" in out


def test_live_answer_with_one_recent_source_is_silent():
    fl = _live_ledger()
    fl.note_url("https://old.com/a", SourceDate(T - timedelta(days=400), "snippet"))
    fl.note_url("https://new.com/b", SourceDate(T - timedelta(days=5), "published"))
    assert (
        render_freshness("[1](https://old.com/a) and [2](https://new.com/b)", fl, T)
        == ""
    )


def test_live_answer_with_undated_citations_is_told_so():
    fl = _live_ledger()
    fl.note_url("https://nodate.com/c")
    assert "no cited source carries a verifiable date" in render_freshness(
        "See https://nodate.com/c", fl, T
    )


# ------------------------------------------------------- 4. two queries


def test_prefetch_runs_a_dated_and_a_wider_query():
    r = req("Give me the past 30 days of UPI news.")  # crosses into August
    assert prefetch_queries(r, T) == [
        "Give me the past 30 days of UPI news September 2026",
        "Give me the past 30 days of UPI news August 2026",
    ]
    w = req("What changed this week in fintech?")  # inside September
    assert prefetch_queries(w, T) == [
        "What changed this week in fintech September 2026",
        "What changed this week in fintech",
    ]
    y = req("What happened this year in the EV market?")
    assert prefetch_queries(y, T) == [
        "What happened this year in the EV market 2026",
        "What happened this year in the EV market",
    ]
    live = req("Current price of gold in India")
    assert prefetch_queries(live, T) == [
        "Current price of gold in India",
        "Current price of gold in India 2026",
    ]


# ---------------------------------------- 5. execution-level enforcement


def test_a_stale_page_body_is_withheld_under_a_strict_window():
    r = req("Give me the past 30 days of UPI news.")
    body = "Published: 2 Jan 2025\n\n" + "Detailed figures. " * 200
    out, _ = annotate_read(
        {"status": "success", "url": "https://a.com/p", "content": body}, r, T
    )
    assert out["content_withheld"] is True and out["stale_for_request"] is True
    assert len(out["content"]) < 420 and out["content"].endswith("[…]")
    assert "withheld" in out["freshness_note"]
    fresh, _ = annotate_read(
        {
            "status": "success",
            "url": "https://b.com/p",
            "content": f"Updated: {_iso(2)}\n" + "x" * 1000,
        },
        r,
        T,
    )
    assert "content_withheld" not in fresh and len(fresh["content"]) > 900


async def test_a_memory_url_read_without_a_search_is_marked(monkeypatch):
    import ipaddress

    monkeypatch.setattr(
        "app.ssrf._resolved_ips",
        lambda host, port: [ipaddress.ip_address("93.184.216.34")],
    )
    page = {
        "status": "success",
        "url": "https://memory.example/p",
        "content": "no dateline at all\n" + "x" * 300,
    }
    ctx, client, writer = _ctx(
        lambda req_: httpx.Response(200, json=page),
        _tool(SCRAPE_ID, "/v1/scrape"),
        requirement=req("What changed this week in fintech?"),
    )
    try:
        msgs = await execute_tool_calls(
            [
                {
                    "name": SCRAPE_ID,
                    "args": {"url": "https://memory.example/p"},
                    "id": "c1",
                }
            ],
            ctx,
        )
    finally:
        await client.aclose()
    assert "not from a search result this turn" in msgs[0].content
    assert "verify its date before citing" in msgs[0].content


# ------------------------------------------------- 6. prominent statement


def test_a_strict_failure_is_a_warning_the_answer_cannot_soften():
    fl = FreshnessLedger(
        requirement=req("Give me the past 30 days of UPI news."),
        web_available=True,
        search_calls=1,
        search_ok=1,
    )
    fl.note_url("https://old.com/a", SourceDate(date(2024, 9, 12), "snippet"))
    out = render_freshness(
        "Everything is current and verified [1](https://old.com/a).", fl, T
    )
    assert out.startswith("**⚠ Recency check")
    assert "Do not rely on any current-state claim" in out


# --------------------------------------------------------- 8. readiness


def test_soffice_components_are_reported_from_disk(monkeypatch, tmp_path):
    from app.documents import soffice

    prog = tmp_path / "program"
    prog.mkdir()
    (prog / "libsdlo.so").write_bytes(b"")
    fake_bin = prog / "soffice"
    fake_bin.write_bytes(b"")
    monkeypatch.setattr(
        "app.documents.soffice.shutil.which",
        lambda name: str(fake_bin) if name == "soffice" else None,
    )
    c = soffice.soffice_components()
    assert c == {"binary": True, "writer": False, "impress": True}


async def test_readyz_refuses_documents_enabled_with_writer_missing(monkeypatch):
    from tests.test_mcp_hardening import _get, _ready_app

    monkeypatch.setattr(
        "app.documents.soffice.soffice_components",
        lambda: {"binary": True, "writer": False, "impress": True},
    )
    app = _ready_app(ai_documents_soffice_enabled=True)
    res = await _get(app, "/readyz")
    body = res.json()
    assert body["documents"] == {
        "soffice_enabled": True,
        "ok": False,
        "binary": True,
        "writer": False,
        "impress": True,
    }
    assert res.status_code == 503 and body["ready"] is False


async def test_readyz_ignores_documents_when_disabled(monkeypatch):
    from tests.test_mcp_hardening import _get, _ready_app

    app = _ready_app(ai_documents_soffice_enabled=False)
    res = await _get(app, "/readyz")
    assert res.json()["documents"] == {"soffice_enabled": False, "ok": True}
