"""Data Analysis — the reserved-tool dispatch (run_tool), the executor routing +
events, and skill routing/coexistence. Hermetic: a fake Convex returns the CSV bytes;
no network."""

from __future__ import annotations

import json

from langchain_core.messages import ToolMessage

from app.agent.executor import DataContext, ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE
from app.data.loader import DatasetRef
from app.data.tool import run_tool
from app.runtime.roster import PRODUCTION_SKILLS, effective_skills
from app.runtime.writer import DeltaWriter
from app.skills.registry import SkillRegistry
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex

SALES_CSV = (
    b"date,region,product,units,revenue\n"
    b"2026-01-05,North,Widget,10,100.0\n"
    b"2026-01-06,South,Gadget,5,250.0\n"
    b"2026-02-05,North,Widget,20,200.0\n"
    b"2026-03-07,South,Gadget,900,45000.0\n"
)


class FakeConvex:
    """Serves the dataset bytes for a thread-scoped fetch (called by the loader)."""

    def __init__(self, raw: bytes, mime: str = "text/csv"):
        self.raw, self.mime = raw, mime
        self.calls: list[tuple[str, str]] = []

    async def fetch_file(self, storage_id: str, stream_id: str):
        self.calls.append((storage_id, stream_id))
        return self.raw, self.mime


def _data_ctx(settings=None, name="sales.csv", raw=SALES_CSV):
    s = settings or make_settings("http://x", ai_data_analysis_enabled=True)
    convex = FakeConvex(raw)
    ds = {name: DatasetRef(name=name, storage_id="sid1", mime="text/csv")}
    return DataContext(settings=s, convex=convex, stream_id="s1", datasets=ds), convex


# --- run_tool dispatch ----------------------------------------------------
async def test_run_tool_profile_resolves_and_computes():
    ctx, convex = _data_ctx()
    out = await run_tool(ctx, "profile_dataset", {"dataset": "sales.csv"})
    assert out["rows"] == 4 and out["table_name"] == "sales"
    assert "revenue" in out["metrics"]
    assert convex.calls == [("sid1", "s1")]  # thread-scoped fetch happened


async def test_run_tool_sql_over_registered_tables():
    ctx, _ = _data_ctx()
    out = await run_tool(
        ctx,
        "sql_query",
        {"sql": "SELECT region, SUM(revenue) r FROM sales GROUP BY region "
                "ORDER BY r DESC"},
    )
    assert out["rows"][0]["region"] == "South"


async def test_run_tool_outliers_and_timeseries_and_stats():
    ctx, _ = _data_ctx()
    o = await run_tool(
        ctx, "detect_outliers", {"dataset": "sales.csv", "column": "revenue"}
    )
    assert o["n_outliers"] >= 1
    t = await run_tool(
        ctx,
        "time_series",
        {"dataset": "sales.csv", "date_col": "date", "value_col": "revenue"},
    )
    assert t["n_periods"] >= 1
    s = await run_tool(
        ctx, "statistics", {"dataset": "sales.csv", "kind": "correlation"}
    )
    assert "top_pairs" in s


async def test_run_tool_errors_are_structured_not_raised():
    ctx, _ = _data_ctx()
    bad_ds = await run_tool(ctx, "profile_dataset", {"dataset": "nope.csv"})
    assert "error" in bad_ds and "not found" in bad_ds["error"]
    bad_col = await run_tool(
        ctx, "detect_outliers", {"dataset": "sales.csv", "column": "ghost"}
    )
    assert "error" in bad_col
    bad_sql = await run_tool(ctx, "sql_query", {"sql": "DROP TABLE sales"})
    assert "error" in bad_sql


async def test_run_tool_caches_dataframe_across_calls():
    from app.data import loader

    loader._CACHE._store.clear()  # isolate from other tests sharing the module cache
    s = make_settings("http://x", ai_data_analysis_enabled=True)
    convex = FakeConvex(SALES_CSV)
    ctx = DataContext(
        settings=s,
        convex=convex,
        stream_id="s1",
        datasets={"c.csv": DatasetRef("c.csv", "sid_cache", "text/csv")},
    )
    await run_tool(ctx, "profile_dataset", {"dataset": "c.csv"})
    await run_tool(ctx, "detect_outliers", {"dataset": "c.csv", "column": "revenue"})
    # second call reuses the cached df — exactly one fetch for the same storageId
    assert convex.calls.count(("sid_cache", "s1")) == 1


# --- executor routing + events -------------------------------------------
async def test_executor_routes_data_tool_and_emits_events():
    s = make_settings("http://x", ai_data_analysis_enabled=True)
    rec = RecordingConvex({"ok": True})
    writer = DeltaWriter(rec, "s1", s)
    data_ctx = DataContext(
        settings=s,
        convex=FakeConvex(SALES_CSV),
        stream_id="s1",
        datasets={"sales.csv": DatasetRef("sales.csv", "sid1", "text/csv")},
    )
    ctx = ToolExecContext(
        registry=None,
        adapter=None,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
        data=data_ctx,
    )
    msgs = await execute_tool_calls(
        [{"name": "profile_dataset", "args": {"dataset": "sales.csv"}, "id": "c1"}], ctx
    )
    assert len(msgs) == 1 and isinstance(msgs[0], ToolMessage)
    assert msgs[0].status == "success"
    body = json.loads(msgs[0].content)
    assert body["rows"] == 4
    ev = [c for c in rec.calls if c.get("op") == "event"]
    types = {e["type"] for c in ev for e in c["events"]}
    assert "TOOL_CALL" in types and "TOOL_RESULT" in types


# --- skill routing + coexistence -----------------------------------------
def _on():
    return make_settings("http://x", ai_data_analysis_enabled=True)


def test_flag_off_keeps_the_generic_data_skill():
    off = make_settings("http://x", ai_data_analysis_enabled=False)
    skills = effective_skills(off)
    assert skills == list(PRODUCTION_SKILLS)  # byte-identical, generic skill stays
    da = next(s for s in skills if s.skill_id == "data-analysis")
    # the tiny generic one — NOT the full compute-backed methodology
    assert "reason over computed results" not in da.methodology.lower()


def test_flag_on_swaps_in_the_full_data_skill_no_duplicate():
    skills = effective_skills(_on())
    das = [s for s in skills if s.skill_id == "data-analysis"]
    assert len(das) == 1  # replaced, not duplicated
    assert "reason over computed results" in das[0].methodology.lower()


def test_data_skill_is_top_for_data_requests():
    reg = SkillRegistry(effective_skills(_on()))
    for q in (
        "analyze this sales dataset and find the trend by region",
        "why did revenue fall — segment the csv",
        "find anomalies and outliers in the metrics",
        "profile my excel spreadsheet and show the top products",
    ):
        top = reg.discover(q)
        assert top and top[0].manifest.skill_id == "data-analysis", q


def test_data_coexists_with_seo_blog_research():
    s = make_settings(
        "http://x",
        ai_data_analysis_enabled=True,
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
    )
    reg = SkillRegistry(effective_skills(s))
    seo = reg.discover("audit the technical seo of example.com robots canonical")
    blog = reg.discover("write a blog post about kubernetes")
    data = reg.discover("analyze the revenue dataset by segment")
    assert seo[0].manifest.skill_id == "seo-audit"
    assert blog[0].manifest.skill_id == "blog-assist"
    assert data[0].manifest.skill_id == "data-analysis"
