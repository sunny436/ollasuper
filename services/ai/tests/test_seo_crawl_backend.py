"""Phase 5 (real crawl backend) — the deterministic Ollagraph meta-audit -> findings
mapper and the sitemap-driven discoverer, tested hermetically with a fake adapter."""

from __future__ import annotations

import asyncio

import pytest

from app.clients.ollagraph import ToolError, ToolErrorKind
from app.config import Settings
from app.models.tools import ToolDefinition
from app.runtime.seo_run import SeoRunStep
from app.seo.crawl_backend import (
    BROKEN_LINKS_TOOL,
    HEADERS_TOOL,
    META_AUDIT_TOOL,
    ROBOTS_TOOL,
    SITEMAP_TOOL,
    SSL_TOOL,
    STRUCTURED_TOOL,
    OllagraphSeoBackend,
    meta_audit_to_findings,
    structured_to_findings,
)

CLEAN = {
    "status": "success", "title": "A perfectly reasonable page title here",
    "title_length": 38, "meta_description": "x" * 120, "meta_description_length": 120,
    "canonical": "https://x/", "robots_directive": None, "is_indexable": True,
    "h1_count": 1, "is_likely_404": False, "bot_blocked_at_origin": False,
    "og_image": "https://x/og.png", "issues": [],
}


def _by_id(findings: list[dict]) -> dict[str, dict]:
    return {f["check_id"]: f for f in findings}


def test_clean_page_is_all_pass():
    fs = _by_id(meta_audit_to_findings("https://x/", CLEAN))
    assert fs["onpage.title_unique_descriptive"]["status"] == "PASS"
    assert fs["onpage.meta_description"]["status"] == "PASS"
    assert fs["crawl_index.canonical_consistency"]["status"] == "PASS"
    assert fs["crawl_index.noindex_mechanism"]["status"] == "PASS"
    assert fs["onpage.h1"]["status"] == "PASS"
    assert all(f["affected"] == ["https://x/"] for f in fs.values())


def test_issues_are_classified_with_severity():
    bad = {
        "status": "success", "title": None, "title_length": 0,
        "meta_description": None, "meta_description_length": 0, "canonical": None,
        "robots_directive": "noindex", "is_indexable": False, "h1_count": 0,
        "is_likely_404": True, "bot_blocked_at_origin": True, "og_image": None,
    }
    fs = _by_id(meta_audit_to_findings("https://x/", bad))
    assert fs["onpage.title_unique_descriptive"]["status"] == "FAIL"
    assert fs["onpage.meta_description"]["status"] == "FAIL"
    # noindex is the most severe — critical FAIL.
    assert fs["crawl_index.noindex_mechanism"]["status"] == "FAIL"
    assert fs["crawl_index.noindex_mechanism"]["severity"] == "critical"
    assert fs["crawl_index.soft_404"]["status"] == "FAIL"
    assert fs["crawl_index.bot_access"]["status"] == "WARN"
    assert fs["onpage.h1"]["status"] == "WARN"


def test_short_title_and_long_meta_warn():
    r = {**CLEAN, "title": "short", "title_length": 5,
         "meta_description": "y" * 200, "meta_description_length": 200}
    fs = _by_id(meta_audit_to_findings("https://x/", r))
    assert fs["onpage.title_unique_descriptive"]["status"] == "WARN"
    assert fs["onpage.meta_description"]["status"] == "WARN"


def test_failed_response_is_not_tested():
    fs = meta_audit_to_findings("https://x/", {"status": "error"})
    assert len(fs) == 1 and fs[0]["status"] == "NOT_TESTED"
    assert fs[0]["check_id"] == "crawl_index.fetch"


# --- backend (fake adapter) ---------------------------------------------------


class _FakeRegistry:
    def get(self, tool_id: str) -> ToolDefinition | None:
        return ToolDefinition(tool_id=tool_id, name=tool_id)


class _FakeAdapter:
    def __init__(self, *, sitemap=None, audit=None, raise_on=None,
                 fail_kind=ToolErrorKind.UNAVAILABLE, fail_times=None) -> None:
        self._sitemap = sitemap or {}
        self._audit = audit or CLEAN
        self._raise_on = raise_on
        self._fail_kind = fail_kind
        # None ⇒ always raise on raise_on; int ⇒ raise that many times then succeed.
        self._fail_times = fail_times
        self.calls = 0

    async def call_tool(self, tool, payload, *, input_schema=None, user_id="",
                        workspace_id="", idempotency_key=None):
        self.calls += 1
        if self._raise_on and tool.tool_id == self._raise_on:
            if self._fail_times is None or self._fail_times > 0:
                if self._fail_times is not None:
                    self._fail_times -= 1
                raise ToolError(self._fail_kind, "boom", tool_id=tool.tool_id)
        data = self._sitemap if tool.tool_id == SITEMAP_TOOL else self._audit
        return {"ok": True, "tool_id": tool.tool_id, "data": data}


def _backend(adapter) -> OllagraphSeoBackend:
    return OllagraphSeoBackend(adapter, _FakeRegistry(), Settings(), user_id="u1")


def _step() -> SeoRunStep:
    return SeoRunStep(runId="r", leaseToken="l", userId="u1", target="https://x/",
                      scope="site", maxUrls=100, costBudget=10.0, costSpent=0.0,
                      deadlineAt=0, workflowVersion=1, createdAt=0)


async def test_discover_uses_sitemap_bounded_with_target_lead():
    # The target leads the frontier so the once-per-run site audit lands in batch 0;
    # the remaining slots are sitemap URLs, bounded to max_urls.
    urls = [f"https://x/{i}" for i in range(10)]
    b = _backend(_FakeAdapter(sitemap={"status": "success", "urls": urls}))
    got = await b.discover("https://x/", "site", 4)
    assert got == ["https://x/", *urls[:3]]


async def test_discover_does_not_duplicate_target_in_frontier():
    urls = ["https://x/", "https://x/a", "https://x/b"]
    b = _backend(_FakeAdapter(sitemap={"status": "success", "urls": urls}))
    got = await b.discover("https://x/", "site", 100)
    assert got == ["https://x/", "https://x/a", "https://x/b"]
    assert got.count("https://x/") == 1


async def test_discover_page_scope_is_target_only():
    b = _backend(_FakeAdapter(sitemap={"urls": ["https://x/a"]}))
    assert await b.discover("https://x/", "page", 100) == ["https://x/"]


async def test_discover_empty_sitemap_falls_back_to_target():
    b = _backend(_FakeAdapter(sitemap={"status": "success", "urls": []}))
    assert await b.discover("https://x/", "site", 100) == ["https://x/"]


async def test_discover_sitemap_error_falls_back():
    b = _backend(_FakeAdapter(raise_on=SITEMAP_TOOL))
    assert await b.discover("https://x/", "site", 100) == ["https://x/"]


async def test_crawl_maps_findings_and_rows():
    b = _backend(_FakeAdapter(audit=CLEAN))
    res = await b.crawl(["https://x/a", "https://x/b"], _step())
    assert len(res.rows) == 2
    assert res.findings  # PASS findings for both urls
    assert res.counts.get("PASS", 0) >= 8
    assert res.cost == 2.0


async def test_crawl_tool_error_is_not_tested_not_fatal():
    # A NON-retryable error (auth) → NOT_TESTED immediately, no retries.
    b = _backend(_FakeAdapter(
        raise_on=META_AUDIT_TOOL, fail_kind=ToolErrorKind.AUTH_FAILED
    ))
    res = await b.crawl(["https://x/a"], _step())
    assert res.rows == []
    assert len(res.findings) == 1
    assert res.findings[0]["status"] == "NOT_TESTED"


async def test_crawl_retries_on_rate_limit_then_succeeds(monkeypatch):
    # 429 (retryable) twice, then success → a REAL finding, not NOT_TESTED.
    monkeypatch.setattr("app.seo.crawl_backend._RETRY_BASE_S", 0.0)
    monkeypatch.setattr("app.seo.crawl_backend._THROTTLE_S", 0.0)
    adapter = _FakeAdapter(
        raise_on=META_AUDIT_TOOL, fail_kind=ToolErrorKind.RATE_LIMITED, fail_times=2
    )
    b = _backend(adapter)
    res = await b.crawl(["https://x/a"], _step())
    # 2 meta-audit failures + 1 meta-audit success, then 1 structured enrichment call.
    assert adapter.calls == 4
    assert len(res.rows) == 1
    assert not any(f["status"] == "NOT_TESTED" for f in res.findings)


async def test_crawl_gives_up_after_max_retries(monkeypatch):
    monkeypatch.setattr("app.seo.crawl_backend._RETRY_BASE_S", 0.0)
    adapter = _FakeAdapter(
        raise_on=META_AUDIT_TOOL, fail_kind=ToolErrorKind.RATE_LIMITED
    )
    res = await _backend(adapter).crawl(["https://x/a"], _step())
    assert adapter.calls == 3  # exhausted the bounded retries
    assert res.findings[0]["status"] == "NOT_TESTED"


@pytest.mark.parametrize("h1,expected", [(0, "WARN"), (1, "PASS"), (3, "WARN")])
def test_h1_count_classification(h1, expected):
    fs = _by_id(meta_audit_to_findings("https://x/", {**CLEAN, "h1_count": h1}))
    assert fs["onpage.h1"]["status"] == expected


# --- structured data (best-effort enrichment, never fabricated) ---------------


def test_structured_findings_pass_when_jsonld_present():
    fs = structured_to_findings(
        "https://x/",
        {"json_ld": [{"@type": "Organization"}, {"@type": ["Product", "Thing"]}]},
    )
    assert len(fs) == 1
    assert fs[0]["status"] == "PASS"
    assert fs[0]["check_id"] == "onpage.structured_data_valid"
    assert fs[0]["intent"] == "structured_data.extract"
    assert "Organization" in fs[0]["observation"]


def test_structured_findings_warn_when_present_but_empty():
    fs = structured_to_findings("https://x/", {"json_ld": [], "microdata": []})
    assert len(fs) == 1 and fs[0]["status"] == "WARN"


def test_structured_findings_no_probe_is_no_finding():
    # A tool error / missing `json_ld` key must NOT become a fabricated
    # "no structured data" claim — meta-audit already covered the page.
    assert structured_to_findings("https://x/", {"error": "boom"}) == []
    assert structured_to_findings("https://x/", {}) == []
    assert structured_to_findings("https://x/", None) == []


# --- site-level technical audit -----------------------------------------------


class _RecordingAdapter:
    """Dispatches canned per-tool responses and records (tool_id, payload), so a test
    can assert the exact input contract (e.g. SSL takes {"domain": host})."""

    def __init__(self, responses: dict[str, dict]) -> None:
        self._responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def call_tool(self, tool, payload, *, input_schema=None, user_id="",
                        workspace_id="", idempotency_key=None):
        self.calls.append((tool.tool_id, payload))
        return {"ok": True, "tool_id": tool.tool_id,
                "data": self._responses.get(tool.tool_id, {})}


def _site_responses(**over) -> dict[str, dict]:
    base = {
        SSL_TOOL: {"status": "success", "is_valid": True, "days_remaining": 200,
                   "issuer": "Let's Encrypt R3"},
        ROBOTS_TOOL: {"status": "success", "robots_url": "https://x/robots.txt",
                      "is_allowed": True},
        BROKEN_LINKS_TOOL: {"status": "success", "broken_count": 0,
                            "internal_broken": 0, "external_broken": 0},
        HEADERS_TOOL: {"status": "success",
                       "headers": [["Strict-Transport-Security", "max-age=63072000"]]},
        SITEMAP_TOOL: {"status": "success", "url_count": 12},
        META_AUDIT_TOOL: CLEAN,
        STRUCTURED_TOOL: {"json_ld": [{"@type": "WebSite"}]},
    }
    base.update(over)
    return base


async def test_site_audit_full_pass_and_ssl_domain_contract():
    a = _RecordingAdapter(_site_responses())
    res = await _backend(a).crawl(["https://x/"], _step())  # target IS in batch
    fs = _by_id(res.findings)
    for cid in ("technical.https_ssl", "crawl_index.robots_txt",
                "crawl_index.broken_links", "technical.hsts",
                "crawl_index.sitemap_quality", "onpage.structured_data_valid"):
        assert fs[cid]["status"] == "PASS", cid
    # The 422-fix contract: SSL is called with {"domain": host}, never {"url": ...}.
    assert [p for t, p in a.calls if t == SSL_TOOL] == [{"domain": "x"}]


async def test_site_audit_runs_once_across_batch():
    a = _RecordingAdapter(_site_responses())
    await _backend(a).crawl(["https://x/", "https://x/a", "https://x/b"], _step())
    assert sum(1 for t, _ in a.calls if t == SSL_TOOL) == 1


async def test_site_audit_skipped_when_target_absent():
    a = _RecordingAdapter(_site_responses())
    await _backend(a).crawl(["https://x/a"], _step())  # target https://x/ not present
    assert not any(t == SSL_TOOL for t, _ in a.calls)


async def test_site_audit_robots_disallow_is_cautious_low_warn():
    # A homepage-disallowed signal is a low WARN to VERIFY — never a fabricated
    # CRITICAL (some parsers false-positive on wildcard Disallow rules).
    a = _RecordingAdapter(_site_responses(**{
        ROBOTS_TOOL: {"status": "success", "robots_url": "https://x/robots.txt",
                      "is_allowed": False}}))
    res = await _backend(a).crawl(["https://x/"], _step())
    warn = _by_id(res.findings)["crawl_index.robots_home_allowed"]
    assert warn["status"] == "WARN" and warn["severity"] == "low"
    assert not any(f["severity"] == "critical"
                   and f["check_id"].startswith("crawl_index.robots")
                   for f in res.findings)


async def test_site_audit_internal_broken_links_and_header_noindex_fail():
    a = _RecordingAdapter(_site_responses(**{
        BROKEN_LINKS_TOOL: {"status": "success", "broken_count": 3,
                            "internal_broken": 2, "external_broken": 1},
        HEADERS_TOOL: {"status": "success",
                       "headers": [["X-Robots-Tag", "noindex, nofollow"]]}}))
    fs = _by_id((await _backend(a).crawl(["https://x/"], _step())).findings)
    assert fs["crawl_index.broken_links"]["status"] == "FAIL"
    assert fs["crawl_index.x_robots_tag"]["status"] == "FAIL"
    assert fs["crawl_index.x_robots_tag"]["severity"] == "critical"
    assert fs["technical.hsts"]["status"] == "WARN"  # HSTS header now absent


async def test_site_audit_missing_sitemap_warns():
    a = _RecordingAdapter(_site_responses(**{SITEMAP_TOOL: {"status": "error"}}))
    fs = _by_id((await _backend(a).crawl(["https://x/"], _step())).findings)
    assert fs["crawl_index.sitemap_quality"]["status"] == "WARN"


@pytest.mark.parametrize("ssl,expect", [
    ({"status": "success", "is_valid": True, "days_remaining": 200}, "PASS"),
    ({"status": "success", "is_valid": True, "days_remaining": 20}, "WARN"),
    ({"status": "success", "is_valid": True, "days_remaining": 5}, "FAIL"),
    ({"status": "success", "is_valid": False, "days_remaining": 200}, "FAIL"),
])
async def test_site_audit_ssl_severity(ssl, expect):
    a = _RecordingAdapter(_site_responses(**{SSL_TOOL: ssl}))
    fs = _by_id((await _backend(a).crawl(["https://x/"], _step())).findings)
    assert fs["technical.https_ssl"]["status"] == expect


async def test_site_audit_tool_failure_is_coverage_gap_not_fatal(monkeypatch):
    # A site check that keeps failing yields NO finding (honest gap), and never
    # aborts the rest of the site audit.
    monkeypatch.setattr("app.seo.crawl_backend._RETRY_BASE_S", 0.0)

    class _SslAlwaysFails(_RecordingAdapter):
        async def call_tool(self, tool, payload, **kw):
            if tool.tool_id == SSL_TOOL:
                raise ToolError(
                    ToolErrorKind.RATE_LIMITED, "boom", tool_id=tool.tool_id
                )
            return await super().call_tool(tool, payload, **kw)

    a = _SslAlwaysFails(_site_responses())
    fs = _by_id((await _backend(a).crawl(["https://x/"], _step())).findings)
    assert "technical.https_ssl" not in fs  # no fabrication on failure
    assert fs["crawl_index.robots_txt"]["status"] == "PASS"  # audit continued


# --- parallel crawl is identical to sequential (the core correctness proof) ----


class _ReorderAdapter:
    """url-distinct responses + a variable delay so completion order is the REVERSE
    of submission order — proving the crawl aggregates by INPUT order (gather), not
    the order results happen to land in."""

    def __init__(self) -> None:
        self._n = 0

    async def call_tool(self, tool, payload, *, input_schema=None, user_id="",
                        workspace_id="", idempotency_key=None):
        self._n += 1
        await asyncio.sleep(0.02 / self._n)  # earlier submissions finish LAST
        url = payload.get("url", "")
        data = {**CLEAN, "canonical": url} if tool.tool_id == META_AUDIT_TOOL else {}
        return {"ok": True, "tool_id": tool.tool_id, "data": data}


def _backend_conc(adapter, n: int) -> OllagraphSeoBackend:
    return OllagraphSeoBackend(
        adapter, _FakeRegistry(), Settings(ai_seo_crawl_concurrency=n), user_id="u1"
    )


async def test_parallel_crawl_output_identical_to_sequential():
    # THE HARD CONSTRAINT: concurrency must not change the result. The pool-sized
    # parallel run must yield rows/findings/counts IDENTICAL to a strictly sequential
    # (concurrency=1) run over the same responses, with findings in `urls` order even
    # though completion order is reversed.
    urls = [f"https://x/p{i}" for i in range(8)]
    step = _step()  # target https://x/ not in urls → per-URL audits only
    par = await _backend_conc(_ReorderAdapter(), 16).crawl(urls, step)
    seq = await _backend_conc(_ReorderAdapter(), 1).crawl(urls, step)
    assert par.rows == seq.rows
    assert par.findings == seq.findings
    assert par.counts == seq.counts
    assert par.cost == seq.cost == 8.0
    # Aggregation stayed in URL order despite reversed completion.
    canon = [
        f["observation"] for f in par.findings
        if f["check_id"] == "crawl_index.canonical_consistency"
    ]
    assert canon == [f"Canonical: https://x/p{i}." for i in range(8)]
