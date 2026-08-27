"""Phase 5 (real crawl backend) — the deterministic Ollagraph meta-audit -> findings
mapper and the sitemap-driven discoverer, tested hermetically with a fake adapter."""

from __future__ import annotations

import pytest

from app.clients.ollagraph import ToolError, ToolErrorKind
from app.config import Settings
from app.models.tools import ToolDefinition
from app.runtime.seo_run import SeoRunStep
from app.seo.crawl_backend import (
    META_AUDIT_TOOL,
    SITEMAP_TOOL,
    OllagraphSeoBackend,
    meta_audit_to_findings,
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
    def __init__(self, *, sitemap=None, audit=None, raise_on=None) -> None:
        self._sitemap = sitemap or {}
        self._audit = audit or CLEAN
        self._raise_on = raise_on

    async def call_tool(self, tool, payload, *, input_schema=None, user_id="",
                        workspace_id="", idempotency_key=None):
        if self._raise_on and tool.tool_id == self._raise_on:
            raise ToolError(ToolErrorKind.UNAVAILABLE, "boom", tool_id=tool.tool_id)
        data = self._sitemap if tool.tool_id == SITEMAP_TOOL else self._audit
        return {"ok": True, "tool_id": tool.tool_id, "data": data}


def _backend(adapter) -> OllagraphSeoBackend:
    return OllagraphSeoBackend(adapter, _FakeRegistry(), Settings(), user_id="u1")


def _step() -> SeoRunStep:
    return SeoRunStep(runId="r", leaseToken="l", userId="u1", target="https://x/",
                      scope="site", maxUrls=100, costBudget=10.0, costSpent=0.0,
                      deadlineAt=0, workflowVersion=1, createdAt=0)


async def test_discover_uses_sitemap_bounded():
    urls = [f"https://x/{i}" for i in range(10)]
    b = _backend(_FakeAdapter(sitemap={"status": "success", "urls": urls}))
    got = await b.discover("https://x/", "site", 4)
    assert got == urls[:4]


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
    b = _backend(_FakeAdapter(raise_on=META_AUDIT_TOOL))
    res = await b.crawl(["https://x/a"], _step())
    assert res.rows == []
    assert len(res.findings) == 1
    assert res.findings[0]["status"] == "NOT_TESTED"


@pytest.mark.parametrize("h1,expected", [(0, "WARN"), (1, "PASS"), (3, "WARN")])
def test_h1_count_classification(h1, expected):
    fs = _by_id(meta_audit_to_findings("https://x/", {**CLEAN, "h1_count": h1}))
    assert fs["onpage.h1"]["status"] == expected
