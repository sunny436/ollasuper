"""Deterministic data-analysis compute over a pandas DataFrame.

These are PURE functions (a df in, a small JSON-able dict out) — no Convex, no
network, no LLM — so the model reasons over COMPUTED results instead of inlined
data. Every function validates its inputs and raises `DataError` (a user-facing
message the tool layer turns into a structured error) rather than letting an
exception kill the turn. Results are capped (rows + serialized bytes) so tool
output never blows the context window.
"""

from __future__ import annotations

import math
import re
from typing import Any

import numpy as np
import pandas as pd


class DataError(Exception):
    """A user-facing analysis error (bad column, empty data, malformed SQL, …).
    The tool layer reports it as an error result; the turn continues."""


# --- JSON-safety ----------------------------------------------------------
def _jsonable(obj: Any) -> Any:
    """Convert numpy/pandas scalars + NaN/Inf into JSON-safe Python values."""
    if obj is None:
        return None
    if isinstance(obj, (str, bool, int)):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, (pd.Timestamp,)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, np.ndarray)):
        return [_jsonable(v) for v in list(obj)]
    if obj is pd.NaT or (isinstance(obj, float) and pd.isna(obj)):
        return None
    try:
        if pd.isna(obj):
            return None
    except (ValueError, TypeError):
        pass
    return str(obj)


def _records(df: pd.DataFrame, max_rows: int) -> tuple[list[dict], bool]:
    """Rows as JSON-safe records, truncated to `max_rows` (+ a truncated flag)."""
    truncated = len(df) > max_rows
    head = df.head(max_rows)
    out = [
        {str(c): _jsonable(v) for c, v in row.items()}
        for row in head.to_dict(orient="records")
    ]
    return out, truncated


# --- column classification (Anthropic explore-data taxonomy) --------------
_ID_RE = re.compile(r"(^|_)(id|uuid|guid|key|code|sku|ref)s?($|_)", re.I)
_DATE_RE = re.compile(r"(date|time|_at$|_on$|timestamp|dt$|year|month|day)", re.I)
_BOOL_VALUES = {"true", "false", "yes", "no", "y", "n", "0", "1", "t", "f"}


def _classify_column(name: str, s: pd.Series, n_rows: int) -> str:
    non_null = s.dropna()
    distinct = int(non_null.nunique())
    ratio = distinct / n_rows if n_rows else 0.0
    if pd.api.types.is_bool_dtype(s) or (
        distinct <= 2
        and set(str(v).strip().lower() for v in non_null.unique()) <= _BOOL_VALUES
    ):
        return "boolean"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "temporal"
    if _DATE_RE.search(name) and _looks_datelike(non_null):
        return "temporal"
    if pd.api.types.is_numeric_dtype(s):
        if _ID_RE.search(name) and ratio > 0.9:
            return "identifier"
        return "metric"
    # object / string
    if _ID_RE.search(name) and ratio > 0.9:
        return "identifier"
    if ratio > 0.9 and non_null.map(lambda v: len(str(v))).mean() > 30:
        return "text"
    sample = str(non_null.iloc[0]) if len(non_null) else ""
    if sample[:1] in "{[" and sample[-1:] in "}]":
        return "structural"
    return "dimension"


def _looks_datelike(s: pd.Series) -> bool:
    try:
        parsed = pd.to_datetime(s.head(50), errors="coerce")
        return parsed.notna().mean() > 0.7
    except (ValueError, TypeError):
        return False


def _require_nonempty(df: pd.DataFrame) -> None:
    if df is None or df.shape[0] == 0 or df.shape[1] == 0:
        raise DataError("the dataset is empty (no rows or no columns).")


def _require_columns(df: pd.DataFrame, cols: list[str]) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise DataError(
            f"column(s) not found: {missing}. Available: {list(df.columns)[:40]}"
        )


# --- 1) profile -----------------------------------------------------------
def profile(df: pd.DataFrame, *, top_k: int = 10) -> dict:
    """Shape, per-column dtype/null/cardinality/classification, numeric stats,
    top values, and data-quality flags (explore-data methodology)."""
    _require_nonempty(df)
    n_rows, n_cols = int(df.shape[0]), int(df.shape[1])
    dup_rows = int(df.duplicated().sum())
    columns: list[dict] = []
    dims, metrics, temporals = [], [], []
    for name in df.columns:
        s = df[name]
        non_null = s.dropna()
        distinct = int(non_null.nunique())
        null_rate = round(float(s.isna().mean()), 4)
        klass = _classify_column(str(name), s, n_rows)
        col: dict[str, Any] = {
            "name": str(name),
            "dtype": str(s.dtype),
            "role": klass,
            "null_rate": null_rate,
            "distinct": distinct,
            "cardinality": round(distinct / n_rows, 4) if n_rows else 0.0,
        }
        if klass == "metric" and len(non_null):
            desc = non_null.astype(float)
            col["stats"] = {
                "min": _jsonable(desc.min()),
                "p25": _jsonable(desc.quantile(0.25)),
                "median": _jsonable(desc.median()),
                "mean": _jsonable(desc.mean()),
                "p75": _jsonable(desc.quantile(0.75)),
                "p95": _jsonable(desc.quantile(0.95)),
                "max": _jsonable(desc.max()),
                "std": _jsonable(desc.std()),
                "zeros": int((desc == 0).sum()),
                "negatives": int((desc < 0).sum()),
            }
            metrics.append(str(name))
        else:
            if len(non_null):
                vc = non_null.value_counts().head(top_k)
                col["top_values"] = [
                    {"value": _jsonable(v), "count": int(c)} for v, c in vc.items()
                ]
            if klass == "dimension":
                dims.append(str(name))
            elif klass == "temporal":
                temporals.append(str(name))
                try:
                    parsed = pd.to_datetime(non_null, errors="coerce").dropna()
                    if len(parsed):
                        col["range"] = {
                            "min": parsed.min().isoformat(),
                            "max": parsed.max().isoformat(),
                        }
                except (ValueError, TypeError):
                    pass
        columns.append(col)

    # grain / candidate keys + quality flags
    unique_cols = [
        str(c) for c in df.columns if int(df[c].nunique(dropna=False)) == n_rows
    ]
    quality: list[str] = []
    if dup_rows:
        quality.append(f"{dup_rows} fully-duplicate row(s)")
    const_cols = [str(c) for c in df.columns if df[c].nunique(dropna=False) <= 1]
    if const_cols:
        quality.append(f"constant column(s): {const_cols[:10]}")
    high_null = [str(c) for c in df.columns if df[c].isna().mean() > 0.5]
    if high_null:
        quality.append(f">50% null: {high_null[:10]}")

    return {
        "rows": n_rows,
        "columns": n_cols,
        "duplicate_rows": dup_rows,
        "candidate_keys": unique_cols[:5],
        "grain": (
            f"one row per {unique_cols[0]}" if unique_cols else "no unique key found"
        ),
        "dimensions": dims[:40],
        "metrics": metrics[:40],
        "temporal_columns": temporals[:40],
        "quality_flags": quality or ["no obvious quality issues detected"],
        "column_detail": columns,
    }


# --- 2) run_sql (DuckDB, read-only over the registered dataframes) --------
_SQL_ALLOWED = re.compile(r"^\s*(with|select)\b", re.I)
_SQL_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|create|alter|attach|copy|install|load|pragma|"
    r"export|import|call)\b",
    re.I,
)


def run_sql(
    tables: dict[str, pd.DataFrame],
    sql: str,
    *,
    max_rows: int,
) -> dict:
    """Execute a read-only SQL SELECT over the registered dataframes (each keyed by
    its sanitized table name). Multi-table JOINs are supported. Read-only: only
    SELECT/WITH are allowed; DML/DDL/ATTACH/COPY/etc. are rejected."""
    import duckdb

    if not sql or not sql.strip():
        raise DataError("no SQL provided.")
    if not _SQL_ALLOWED.match(sql):
        raise DataError("only read-only SELECT / WITH queries are allowed.")
    if _SQL_FORBIDDEN.search(sql):
        raise DataError("only read-only SELECT queries are allowed (no writes/DDL).")
    con = duckdb.connect(database=":memory:")
    try:
        for tname, tdf in tables.items():
            con.register(tname, tdf)
        try:
            cur = con.execute(sql)
            rows = cur.fetchmany(max_rows + 1)
            cols = [d[0] for d in cur.description] if cur.description else []
        except Exception as e:  # noqa: BLE001 — surface DuckDB errors to the model
            raise DataError(f"SQL error: {str(e).splitlines()[0][:300]}") from e
        truncated = len(rows) > max_rows
        recs = [
            {cols[i]: _jsonable(v) for i, v in enumerate(r)} for r in rows[:max_rows]
        ]
        return {
            "columns": cols,
            "row_count": len(recs),
            "truncated": truncated,
            "rows": recs,
        }
    finally:
        con.close()


# --- 3) statistics --------------------------------------------------------
def statistics(
    df: pd.DataFrame,
    *,
    kind: str,
    columns: list[str] | None = None,
    group_by: str | None = None,
) -> dict:
    """describe | correlation | ttest | chi2 over the dataset."""
    _require_nonempty(df)
    cols = columns or []
    if cols:
        _require_columns(df, cols)

    if kind == "describe":
        target = df[cols] if cols else df
        num = target.select_dtypes(include="number")
        if num.shape[1] == 0:
            raise DataError("no numeric columns to describe.")
        desc = num.describe().T
        return {
            "kind": "describe",
            "columns": {
                str(idx): {k: _jsonable(v) for k, v in row.items()}
                for idx, row in desc.iterrows()
            },
        }

    if kind == "correlation":
        num = (df[cols] if cols else df).select_dtypes(include="number")
        if num.shape[1] < 2:
            raise DataError("correlation needs at least 2 numeric columns.")
        corr = num.corr(numeric_only=True).round(4)
        pairs = []
        names = list(corr.columns)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                pairs.append(
                    {
                        "a": str(names[i]),
                        "b": str(names[j]),
                        "r": _jsonable(corr.iloc[i, j]),
                    }
                )
        pairs.sort(key=lambda p: abs(p["r"] or 0), reverse=True)
        return {"kind": "correlation", "top_pairs": pairs[:40]}

    if kind == "ttest":
        from scipy import stats as _st

        if not cols or not group_by:
            raise DataError("ttest needs `columns=[value_col]` and `group_by`.")
        _require_columns(df, [group_by])
        value = cols[0]
        groups = df[[value, group_by]].dropna()
        levels = list(groups[group_by].unique())
        if len(levels) != 2:
            raise DataError(
                f"ttest needs exactly 2 groups in {group_by}; found {len(levels)}."
            )
        a = groups[groups[group_by] == levels[0]][value].astype(float)
        b = groups[groups[group_by] == levels[1]][value].astype(float)
        if len(a) < 2 or len(b) < 2:
            raise DataError("each group needs at least 2 observations for a t-test.")
        t, p = _st.ttest_ind(a, b, equal_var=False, nan_policy="omit")
        return {
            "kind": "ttest",
            "value": value,
            "group_by": group_by,
            "groups": {
                str(levels[0]): {"n": int(len(a)), "mean": _jsonable(a.mean())},
                str(levels[1]): {"n": int(len(b)), "mean": _jsonable(b.mean())},
            },
            "t_statistic": _jsonable(t),
            "p_value": _jsonable(p),
            "significant_at_0_05": bool(_jsonable(p) is not None and p < 0.05),
        }

    raise DataError(f"unknown statistics kind: {kind!r} (describe|correlation|ttest).")


# --- 4) detect_outliers ---------------------------------------------------
def detect_outliers(
    df: pd.DataFrame, *, column: str, method: str = "iqr", max_examples: int = 20
) -> dict:
    """Flag outliers in a numeric column by IQR (default) or z-score."""
    _require_nonempty(df)
    _require_columns(df, [column])
    s = pd.to_numeric(df[column], errors="coerce").dropna()
    if len(s) < 4:
        raise DataError(f"'{column}' needs ≥4 numeric values for outlier detection.")
    if method == "zscore":
        mu, sigma = s.mean(), s.std()
        if not sigma or not math.isfinite(sigma):
            raise DataError(f"'{column}' has zero variance; no outliers by z-score.")
        z = (s - mu) / sigma
        mask = z.abs() > 3
        bounds = {"mean": _jsonable(mu), "std": _jsonable(sigma), "z_threshold": 3}
    else:  # iqr
        q1, q3 = s.quantile(0.25), s.quantile(0.75)
        iqr = q3 - q1
        lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        mask = (s < lo) | (s > hi)
        bounds = {"lower": _jsonable(lo), "upper": _jsonable(hi), "iqr": _jsonable(iqr)}
    outliers = s[mask]
    examples = sorted(
        (_jsonable(v) for v in outliers.head(max_examples)),
        key=lambda x: (x is None, x),
    )
    return {
        "column": column,
        "method": "zscore" if method == "zscore" else "iqr",
        "n_values": int(len(s)),
        "n_outliers": int(mask.sum()),
        "outlier_rate": round(float(mask.mean()), 4),
        "bounds": bounds,
        "examples": examples,
    }


# --- 5) time_series -------------------------------------------------------
def time_series(
    df: pd.DataFrame,
    *,
    date_col: str,
    value_col: str,
    freq: str = "M",
    agg: str = "sum",
    max_points: int = 200,
) -> dict:
    """Resample a value over time and report the trend + period-over-period change."""
    _require_nonempty(df)
    _require_columns(df, [date_col, value_col])
    if agg not in {"sum", "mean", "count", "min", "max", "median"}:
        raise DataError(f"unsupported agg {agg!r} (sum|mean|count|min|max|median).")
    work = df[[date_col, value_col]].copy()
    work[date_col] = pd.to_datetime(work[date_col], errors="coerce")
    work[value_col] = pd.to_numeric(work[value_col], errors="coerce")
    work = work.dropna(subset=[date_col])
    if work.empty:
        raise DataError(f"'{date_col}' has no parseable dates.")
    series = work.set_index(date_col)[value_col].resample(freq)
    resampled = getattr(series, agg)()
    if len(resampled) > max_points:
        resampled = resampled.tail(max_points)
    pct = resampled.pct_change().replace([np.inf, -np.inf], np.nan)
    points = [
        {
            "period": idx.isoformat(),
            "value": _jsonable(val),
            "pct_change": _jsonable(round(p * 100, 2) if pd.notna(p) else None),
        }
        for (idx, val), p in zip(resampled.items(), pct, strict=False)
    ]
    first, last = resampled.dropna(), resampled.dropna()
    direction = "flat"
    overall = None
    if len(first) >= 2:
        a, b = float(first.iloc[0]), float(last.iloc[-1])
        if a != 0:
            overall = round((b - a) / abs(a) * 100, 2)
        direction = "up" if b > a else "down" if b < a else "flat"
    biggest = max(
        (p for p in points if p["pct_change"] is not None),
        key=lambda p: abs(p["pct_change"]),
        default=None,
    )
    return {
        "date_col": date_col,
        "value_col": value_col,
        "freq": freq,
        "agg": agg,
        "n_periods": len(points),
        "overall_direction": direction,
        "overall_pct_change": overall,
        "largest_move": biggest,
        "series": points,
    }
