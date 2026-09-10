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
import threading
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


# DuckDB is a full analytics engine, not a calculator. `read_csv`,
# `read_parquet`, `read_json_auto` and `glob` are TABLE FUNCTIONS, so they are
# valid inside an ordinary SELECT and no keyword regex ever sees them — the old
# guard let a model read any file this process could reach. The real boundary is
# therefore the CONNECTION's configuration, not the query text:
#
#   enable_external_access=False   kills every file/http reader outright
#   lock_configuration=True        stops a query SET-ing that back on
#   *_extensions=False             no new capability may be loaded at runtime
#
# The regexes below are kept, but they are defence in depth now rather than the
# only control. Registered DataFrames are unaffected: register() and multi-table
# JOINs work exactly as before, which is what run_sql exists to do.
_SQL_CONFIG = {
    "enable_external_access": False,
    "autoinstall_known_extensions": False,
    "autoload_known_extensions": False,
    "allow_community_extensions": False,
    "lock_configuration": True,
    "threads": 1,
    "memory_limit": "256MB",
}
_SQL_DEADLINE_S = 20.0


def run_sql(
    tables: dict[str, pd.DataFrame],
    sql: str,
    *,
    max_rows: int,
) -> dict:
    """Execute a read-only SQL SELECT over the registered dataframes (each keyed by
    its sanitized table name). Multi-table JOINs are supported. Read-only: only
    SELECT/WITH are allowed; DML/DDL/ATTACH/COPY/etc. are rejected, external file
    and network access is disabled at the connection, and exactly one statement
    may be submitted."""
    import duckdb

    if not sql or not sql.strip():
        raise DataError("no SQL provided.")
    if not _SQL_ALLOWED.match(sql):
        raise DataError("only read-only SELECT / WITH queries are allowed.")
    if _SQL_FORBIDDEN.search(sql):
        raise DataError("only read-only SELECT queries are allowed (no writes/DDL).")

    con = duckdb.connect(database=":memory:", config=_SQL_CONFIG)
    try:
        # EXACTLY ONE statement, decided by the PARSER rather than by looking at
        # the first keyword. `SELECT 1; <anything>` passed the old regex, and
        # DuckDB returns the LAST statement's result — so the check that mattered
        # was never applied to the statement that ran.
        try:
            statements = con.extract_statements(sql)
        except Exception as e:  # noqa: BLE001 — surface parser errors to the model
            raise DataError(f"SQL error: {str(e).splitlines()[0][:300]}") from e
        if len(statements) != 1:
            raise DataError("submit exactly one SELECT statement.")
        if statements[0].type != duckdb.StatementType.SELECT:
            raise DataError("only read-only SELECT queries are allowed.")

        for tname, tdf in tables.items():
            con.register(tname, tdf)

        # A runaway query otherwise holds its worker until the turn dies;
        # interrupt() is the only way back in from another thread.
        deadline = threading.Timer(_SQL_DEADLINE_S, con.interrupt)
        deadline.daemon = True
        deadline.start()
        try:
            cur = con.execute(sql)
            rows = cur.fetchmany(max_rows + 1)
            cols = [d[0] for d in cur.description] if cur.description else []
        except Exception as e:  # noqa: BLE001 — surface DuckDB errors to the model
            raise DataError(f"SQL error: {str(e).splitlines()[0][:300]}") from e
        finally:
            deadline.cancel()
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
def _resample(
    df: pd.DataFrame, date_col: str, value_col: str, freq: str, agg: str
) -> pd.Series:
    """Parse dates, coerce values, and aggregate onto a regular frequency.

    Shared by `time_series` and `forecast` so a forecast is fitted on EXACTLY the
    series the user was shown — two copies of this would eventually disagree about
    which periods exist, and the forecast would silently describe a different series.
    """
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
    return getattr(work.set_index(date_col)[value_col].resample(freq), agg)()


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
    resampled = _resample(df, date_col, value_col, freq, agg)
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


# --------------------------------------------------------------------------- #
# forecasting
# --------------------------------------------------------------------------- #
# Below this many periods a trend line is fitting noise, not signal: with 4 points
# an OLS slope has 2 residual degrees of freedom and an interval so wide it carries
# no information. Refusing is the honest answer, and it is the judgement the QA pass
# had to make by hand ("worked technically but was not decision-grade").
_FORECAST_MIN_PERIODS = 6
_FORECAST_MAX_HORIZON = 24
# Fitted, but say so: a trend explaining under this much variance is not something
# to plan against.
_FORECAST_WEAK_R2 = 0.30


def forecast(
    df: pd.DataFrame,
    *,
    date_col: str,
    value_col: str,
    periods: int = 3,
    # "MS" (month START), not "M": pandas deprecated "M" and will remove it, and the
    # tool layer already passes "MS" — matching it here keeps a direct call and a
    # tool call on the same periods.
    freq: str = "MS",
    agg: str = "sum",
    confidence: float = 0.95,
) -> dict:
    """Least-squares trend forecast with a PREDICTION interval, or an explicit refusal.

    Deliberately a narrow tool: an ordinary-least-squares line through the resampled
    series, its interval, and an honest verdict on whether the result is worth acting
    on. It does NOT model seasonality — with a linear trend a seasonal series will
    forecast its average path, so seasonality is reported as a caveat rather than
    silently absorbed.

    The point is not that this beats the model at arithmetic; it is that the model
    cannot produce a prediction interval or a refusal by reasoning over rows, and
    without those a forecast reads far more certain than it is.
    """
    from scipy import stats as _st

    if periods < 1 or periods > _FORECAST_MAX_HORIZON:
        raise DataError(
            f"`periods` must be 1..{_FORECAST_MAX_HORIZON} (got {periods})."
        )

    resampled = _resample(df, date_col, value_col, freq, agg).dropna()
    n = len(resampled)
    if n < _FORECAST_MIN_PERIODS:
        raise DataError(
            f"not enough history to forecast: {n} complete {freq}-periods, "
            f"{_FORECAST_MIN_PERIODS} needed. Widen the date range, or use a coarser "
            f"`freq`. A trend fitted to {n} points would be fitting noise."
        )

    y = resampled.to_numpy(dtype=float)
    x = np.arange(n, dtype=float)
    slope, intercept = np.polyfit(x, y, 1)
    fitted = slope * x + intercept
    resid = y - fitted
    sse = float(np.sum(resid**2))
    sst = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - sse / sst if sst > 0 else 0.0
    # Residual standard error; n-2 because the line spent two degrees of freedom.
    s = math.sqrt(sse / (n - 2)) if n > 2 else 0.0
    sxx = float(np.sum((x - x.mean()) ** 2))
    tcrit = float(_st.t.ppf(1 - (1 - confidence) / 2, n - 2)) if n > 2 else 0.0

    step = resampled.index.freq or (resampled.index[-1] - resampled.index[-2])
    points: list[dict] = []
    for h in range(1, periods + 1):
        xf = float(n - 1 + h)
        yhat = slope * xf + intercept
        # PREDICTION interval (not a confidence interval on the mean): it must cover
        # a single future observation, hence the leading 1 under the root.
        se = s * math.sqrt(1 + 1 / n + ((xf - x.mean()) ** 2) / sxx) if sxx > 0 else 0.0
        points.append(
            {
                "period": (resampled.index[-1] + step * h).isoformat(),
                # float() explicitly: numpy scalars are float SUBCLASSES, so
                # `_jsonable` passes them straight through and they surface as
                # np.float64 in the tool result rather than plain numbers.
                "forecast": _jsonable(round(float(yhat), 4)),
                "lower": _jsonable(round(float(yhat - tcrit * se), 4)),
                "upper": _jsonable(round(float(yhat + tcrit * se), 4)),
            }
        )

    # BLOCKERS disqualify the forecast; NOTES are context that does not.
    #
    # Keeping these apart matters: a first version folded the seasonality note into
    # the verdict, which marked a perfect r²=1.0 trend "not decision grade" and would
    # have flagged almost every real series — a warning that fires always is a
    # warning nobody reads.
    blockers: list[str] = []
    notes: list[str] = []
    if r2 < _FORECAST_WEAK_R2:
        blockers.append(
            f"the trend explains only {r2:.0%} of the variation — the history is "
            f"dominated by noise, so treat this as a direction, not a number"
        )
    last = points[-1]
    if last["forecast"] and abs(last["upper"] - last["lower"]) > abs(last["forecast"]):
        blockers.append(
            "the interval is wider than the forecast itself — the data does not "
            "support a point estimate at this horizon"
        )
    if n < 24 and freq.upper().startswith("M"):
        notes.append(
            "under two years of monthly history, so seasonality cannot be separated "
            "from trend; this is a trend-only projection"
        )

    return {
        "method": "ordinary least squares trend",
        "date_col": date_col,
        "value_col": value_col,
        "freq": freq,
        "agg": agg,
        "n_periods_used": n,
        "confidence": confidence,
        "slope_per_period": _jsonable(round(float(slope), 6)),
        "r_squared": _jsonable(round(float(r2), 4)),
        # The verdict the model must REPEAT rather than re-decide. The QA pass had to
        # reach this judgement by hand; a forecast that cannot state its own
        # reliability will always be reported as more certain than it is.
        "decision_grade": not blockers,
        "blockers": blockers,
        "caveats": notes,
        "forecast": points,
    }
