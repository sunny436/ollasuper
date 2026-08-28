"""The reserved Data-Analysis compute tools + per-turn dataset context.

Five model-decided tools (clones of the `record_research`/`remember` reserved
pattern) that resolve a dataset by NAME (storageId stays server-side), load it into a
bounded pandas df (thread-scoped fetch, cached), run a DETERMINISTIC computation, and
return a SMALL result the model reasons over. `run_tool` holds all the dispatch so the
executor keeps one routing branch. A bounded semaphore + per-op timeout keep the
single-worker plane responsive; a `DataError` becomes an error result (the turn lives).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

import pandas as pd

from app.data import analysis as A
from app.data.loader import DatasetRef, load_dataset, sanitize_table_name

PROFILE_TOOL = "profile_dataset"
SQL_TOOL = "sql_query"
STATS_TOOL = "statistics"
OUTLIERS_TOOL = "detect_outliers"
TIMESERIES_TOOL = "time_series"

DATA_TOOL_NAMES = frozenset(
    {PROFILE_TOOL, SQL_TOOL, STATS_TOOL, OUTLIERS_TOOL, TIMESERIES_TOOL}
)

_DATASET_PROP = {
    "type": "string",
    "description": "The dataset name exactly as listed in <datasets>.",
}
_SHEET_PROP = {
    "type": "string",
    "description": "Sheet name for a multi-sheet workbook (optional; default first).",
}

DATA_TOOL_SPECS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": PROFILE_TOOL,
            "description": (
                "Profile a dataset BEFORE analysing it: shape, per-column dtype, null "
                "rate, cardinality, role (dimension/metric/temporal/…), numeric stats, "
                "top values, grain, and data-quality flags. Also returns the SQL table "
                "name to use with sql_query. Always profile a dataset first."
            ),
            "parameters": {
                "type": "object",
                "properties": {"dataset": _DATASET_PROP, "sheet": _SHEET_PROP},
                "required": ["dataset"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": SQL_TOOL,
            "description": (
                "Run a READ-ONLY SQL SELECT over the uploaded datasets to aggregate, "
                "group, filter, rank, compare, segment, or JOIN across files (DuckDB "
                "dialect). Each dataset is a table under its sanitized name (see "
                "profile_dataset). Use this for the bulk of analysis. Only SELECT/WITH "
                "is allowed. Returns computed rows — reason over them, never guess."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "A DuckDB SELECT query."}
                },
                "required": ["sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": STATS_TOOL,
            "description": (
                "Statistical analysis: kind='describe' (summary stats), 'correlation' "
                "(numeric correlation pairs), or 'ttest' (compare a value across 2 "
                "groups — needs columns=[value] + group_by). Reason over the result."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset": _DATASET_PROP,
                    "kind": {
                        "type": "string",
                        "enum": ["describe", "correlation", "ttest"],
                    },
                    "columns": {"type": "array", "items": {"type": "string"}},
                    "group_by": {"type": "string"},
                    "sheet": _SHEET_PROP,
                },
                "required": ["dataset", "kind"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": OUTLIERS_TOOL,
            "description": (
                "Detect outliers/anomalies in a numeric column by IQR (default) or "
                "z-score. Returns the count, bounds, and example values."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset": _DATASET_PROP,
                    "column": {"type": "string"},
                    "method": {"type": "string", "enum": ["iqr", "zscore"]},
                    "sheet": _SHEET_PROP,
                },
                "required": ["dataset", "column"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": TIMESERIES_TOOL,
            "description": (
                "Trend / time-series: resample a value over a date column and report "
                "the direction, period-over-period % change, and the largest move. "
                "freq is a pandas offset (D/W/MS/QS/YS); agg is sum|mean|count|min|max."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset": _DATASET_PROP,
                    "date_col": {"type": "string"},
                    "value_col": {"type": "string"},
                    "freq": {"type": "string"},
                    "agg": {"type": "string"},
                    "sheet": _SHEET_PROP,
                },
                "required": ["dataset", "date_col", "value_col"],
            },
        },
    },
]


@dataclass(slots=True)
class DataContext:
    """Per-turn data-analysis state. `datasets` maps the model-facing NAME to its
    ref (storageId never reaches the model). The semaphore bounds concurrent compute."""

    settings: object
    convex: object
    stream_id: str
    datasets: dict[str, DatasetRef]
    _sema: asyncio.Semaphore | None = field(default=None)

    def table_name(self, name: str) -> str:
        return sanitize_table_name(name)

    @property
    def semaphore(self) -> asyncio.Semaphore:
        if self._sema is None:
            n = int(getattr(self.settings, "ai_data_max_concurrent", 4))
            self._sema = asyncio.Semaphore(max(1, n))
        return self._sema


def _resolve(ctx: DataContext, name: object) -> DatasetRef:
    if not isinstance(name, str) or not name.strip():
        raise A.DataError("provide a `dataset` name from the <datasets> list.")
    ref = ctx.datasets.get(name.strip())
    if ref is None:
        # tolerant match on the sanitized/base name
        want = sanitize_table_name(name)
        for n, r in ctx.datasets.items():
            if sanitize_table_name(n) == want:
                return r
        raise A.DataError(
            f"dataset '{name}' not found. Available: {list(ctx.datasets)}"
        )
    return ref


def _cap_result(settings: object, result: dict) -> dict:
    """Hard byte-cap so a tool result never blows context."""
    max_chars = int(getattr(settings, "ai_data_result_max_chars", 12_000))
    blob = json.dumps(result, default=str)
    if len(blob) <= max_chars:
        return result
    result["_note"] = "result truncated to fit the context budget"
    for k in ("series", "rows", "column_detail", "top_pairs"):
        v = result.get(k)
        if isinstance(v, list) and len(v) > 10:
            result[k] = v[: max(5, len(v) // 2)]
            if len(json.dumps(result, default=str)) <= max_chars:
                break
    return result


async def run_tool(ctx: DataContext, tool_name: str, args: dict) -> dict:
    """Resolve → load → compute for one data tool. Returns a small result dict, or
    `{"error": ...}` on a DataError. Compute runs in a thread under a semaphore +
    timeout so it never blocks or piles up on the single-worker plane."""
    settings = ctx.settings
    timeout = float(getattr(settings, "ai_data_timeout_s", 20.0))
    result_rows = int(getattr(settings, "ai_data_result_max_rows", 200))
    try:
        async with ctx.semaphore:
            if tool_name == SQL_TOOL:
                sql = args.get("sql")
                if not isinstance(sql, str) or not sql.strip():
                    raise A.DataError("provide a `sql` SELECT query.")
                max_ds = int(getattr(settings, "ai_data_max_datasets", 12))
                tables: dict[str, pd.DataFrame] = {}
                for name, ref in list(ctx.datasets.items())[:max_ds]:
                    df = await load_dataset(ctx.convex, settings, ref, ctx.stream_id)
                    tables[sanitize_table_name(name)] = df
                if not tables:
                    raise A.DataError("no datasets are available to query.")
                out = await asyncio.wait_for(
                    asyncio.to_thread(A.run_sql, tables, sql, max_rows=result_rows),
                    timeout,
                )
                return _cap_result(settings, out)

            ref = _resolve(ctx, args.get("dataset"))
            sheet = args.get("sheet") if isinstance(args.get("sheet"), str) else None
            df = await load_dataset(
                ctx.convex, settings, ref, ctx.stream_id, sheet=sheet
            )

            if tool_name == PROFILE_TOOL:
                out = await asyncio.wait_for(
                    asyncio.to_thread(A.profile, df), timeout
                )
                out["dataset"] = ref.name
                out["table_name"] = sanitize_table_name(ref.name)
                return _cap_result(settings, out)
            if tool_name == STATS_TOOL:
                out = await asyncio.wait_for(
                    asyncio.to_thread(
                        A.statistics,
                        df,
                        kind=str(args.get("kind", "describe")),
                        columns=args.get("columns")
                        if isinstance(args.get("columns"), list)
                        else None,
                        group_by=args.get("group_by")
                        if isinstance(args.get("group_by"), str)
                        else None,
                    ),
                    timeout,
                )
                return _cap_result(settings, out)
            if tool_name == OUTLIERS_TOOL:
                col = args.get("column")
                if not isinstance(col, str):
                    raise A.DataError("provide a numeric `column`.")
                out = await asyncio.wait_for(
                    asyncio.to_thread(
                        A.detect_outliers,
                        df,
                        column=col,
                        method=str(args.get("method", "iqr")),
                    ),
                    timeout,
                )
                return _cap_result(settings, out)
            if tool_name == TIMESERIES_TOOL:
                out = await asyncio.wait_for(
                    asyncio.to_thread(
                        A.time_series,
                        df,
                        date_col=str(args.get("date_col", "")),
                        value_col=str(args.get("value_col", "")),
                        freq=str(args.get("freq", "MS")),
                        agg=str(args.get("agg", "sum")),
                    ),
                    timeout,
                )
                return _cap_result(settings, out)
            raise A.DataError(f"unknown data tool: {tool_name}")
    except A.DataError as e:
        return {"error": str(e)}
    except TimeoutError:
        return {
            "error": (
                "the computation exceeded the time limit — narrow the query, pick "
                "fewer columns, or aggregate more."
            )
        }
    except Exception as e:  # noqa: BLE001 — a tool failure must never kill the turn
        return {"error": f"analysis failed: {str(e).splitlines()[0][:200]}"}
