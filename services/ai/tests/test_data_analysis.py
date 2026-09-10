"""Data Analysis compute core — the deterministic pandas/scipy/DuckDB functions +
the loader guards. Hermetic: no Convex, no network, no LLM."""

from __future__ import annotations

import io

import pandas as pd
import pytest

from app.data import analysis as A
from app.data import loader as L

# --- fixtures -------------------------------------------------------------
SALES_CSV = (
    b"date,region,product,units,revenue\n"
    b"2026-01-05,North,Widget,10,100.0\n"
    b"2026-01-06,South,Gadget,5,250.0\n"
    b"2026-02-05,North,Widget,20,200.0\n"
    b"2026-02-06,South,Gadget,3,150.0\n"
    b"2026-03-05,North,Widget,2,20.0\n"
    b"2026-03-06,South,Gadget,8,400.0\n"
    b"2026-03-07,South,Gadget,900,45000.0\n"  # revenue outlier
)


def _df() -> pd.DataFrame:
    return pd.read_csv(io.BytesIO(SALES_CSV))


# --- loader ---------------------------------------------------------------
def test_parse_csv_ok_and_row_cap():
    df, trunc = L.parse_dataframe(SALES_CSV, "sales.csv", "text/csv", max_rows=100)
    assert list(df.columns) == ["date", "region", "product", "units", "revenue"]
    assert df.shape[0] == 7 and not trunc
    capped, trunc2 = L.parse_dataframe(SALES_CSV, "sales.csv", "text/csv", max_rows=3)
    assert capped.shape[0] == 3 and trunc2 is True


def test_parse_tsv_and_semicolon_delimiter():
    tsv = SALES_CSV.replace(b",", b"\t")
    df, _ = L.parse_dataframe(
        tsv, "sales.tsv", "text/tab-separated-values", max_rows=99
    )
    assert df.shape == (7, 5)


def test_empty_and_malformed_raise_dataerror():
    with pytest.raises(A.DataError):
        L.parse_dataframe(b"", "x.csv", "text/csv", max_rows=10)
    bad_xlsx = b"\x00\x01\x02"
    with pytest.raises(A.DataError):
        L.parse_dataframe(bad_xlsx, "x.xlsx", L._XLSX_MIME, max_rows=10)


def test_sanitize_table_name():
    assert L.sanitize_table_name("sales.csv") == "sales"
    assert L.sanitize_table_name("2024 Q1 report.xlsx") == "t_2024_q1_report"
    assert L.sanitize_table_name("...") == "dataset"


def test_is_tabular():
    assert L.is_tabular("sales.csv", "text/csv")
    assert L.is_tabular("book.xlsx", L._XLSX_MIME)
    assert not L.is_tabular("notes.pdf", "application/pdf")


# --- profile --------------------------------------------------------------
def test_profile_shape_roles_and_quality():
    p = A.profile(_df())
    assert p["rows"] == 7 and p["columns"] == 5
    assert "revenue" in p["metrics"] and "units" in p["metrics"]
    assert "region" in p["dimensions"] and "product" in p["dimensions"]
    assert "date" in p["temporal_columns"]
    rev = next(c for c in p["column_detail"] if c["name"] == "revenue")
    assert rev["role"] == "metric" and rev["stats"]["max"] == 45000.0


def test_profile_empty_raises():
    with pytest.raises(A.DataError):
        A.profile(pd.DataFrame())


# --- run_sql (DuckDB) -----------------------------------------------------
def test_sql_aggregate_group_rank():
    r = A.run_sql(
        {"sales": _df()},
        "SELECT region, SUM(revenue) AS rev FROM sales "
        "GROUP BY region ORDER BY rev DESC",
        max_rows=50,
    )
    assert r["columns"] == ["region", "rev"]
    assert r["rows"][0]["region"] == "South"  # South has the 45000 outlier


def test_sql_rejects_writes_and_bad_sql():
    with pytest.raises(A.DataError):
        A.run_sql({"sales": _df()}, "DELETE FROM sales", max_rows=10)
    with pytest.raises(A.DataError):
        A.run_sql({"sales": _df()}, "SELECT nope FROM sales", max_rows=10)


def test_sql_result_truncation_flag():
    r = A.run_sql({"sales": _df()}, "SELECT * FROM sales", max_rows=3)
    assert r["truncated"] is True and r["row_count"] == 3


# --- statistics -----------------------------------------------------------
def test_statistics_describe_and_correlation():
    d = A.statistics(_df(), kind="describe", columns=["units", "revenue"])
    assert "revenue" in d["columns"]
    c = A.statistics(_df(), kind="correlation")
    assert c["top_pairs"] and "r" in c["top_pairs"][0]


def test_statistics_ttest():
    t = A.statistics(_df(), kind="ttest", columns=["revenue"], group_by="region")
    assert t["kind"] == "ttest" and "p_value" in t


def test_statistics_bad_kind_raises():
    with pytest.raises(A.DataError):
        A.statistics(_df(), kind="bogus")


# --- outliers -------------------------------------------------------------
def test_detect_outliers_iqr_finds_the_spike():
    o = A.detect_outliers(_df(), column="revenue", method="iqr")
    assert o["n_outliers"] >= 1 and 45000.0 in o["examples"]


def test_detect_outliers_missing_column_raises():
    with pytest.raises(A.DataError):
        A.detect_outliers(_df(), column="nope")


# --- time_series ----------------------------------------------------------
def test_time_series_trend_and_change():
    ts = A.time_series(
        _df(), date_col="date", value_col="revenue", freq="MS", agg="sum"
    )
    assert ts["n_periods"] == 3
    assert ts["overall_direction"] in {"up", "down", "flat"}
    assert ts["series"][0]["period"].startswith("2026-01")


def test_time_series_unparseable_dates_raise():
    df = pd.DataFrame({"d": ["x", "y"], "v": [1, 2]})
    with pytest.raises(A.DataError):
        A.time_series(df, date_col="d", value_col="v")


# --- run_sql containment (security regressions) ---------------------------
#
# The guard used to be two regexes: "starts with SELECT/WITH" plus a forbidden
# keyword list. Neither sees a DuckDB *table function*, so `read_csv` and its
# siblings are valid inside a perfectly ordinary SELECT and read any file the
# service process can reach. Both escapes below were reproduced against the
# shipping code before the fix landed.
@pytest.mark.parametrize(
    "reader",
    [
        "SELECT * FROM read_csv('pyproject.toml')",
        "SELECT * FROM read_parquet('pyproject.toml')",
        "SELECT * FROM read_json_auto('pyproject.toml')",
        "SELECT * FROM glob('*')",
        "WITH x AS (SELECT * FROM read_csv('pyproject.toml')) SELECT * FROM x",
    ],
)
def test_sql_cannot_read_the_filesystem(reader):
    with pytest.raises(A.DataError):
        A.run_sql({"sales": _df()}, reader, max_rows=10)


def test_sql_rejects_multiple_statements():
    # Only the leading keyword was ever checked, so a second statement rode in
    # behind a innocuous first one — and DuckDB returns the LAST result.
    with pytest.raises(A.DataError):
        A.run_sql({"sales": _df()}, "SELECT 1 AS x; SELECT 2 AS y", max_rows=10)


def test_sql_cannot_unlock_its_own_configuration():
    # lock_configuration must hold: no SET may re-enable external access.
    with pytest.raises(A.DataError):
        A.run_sql(
            {"sales": _df()},
            "SET enable_external_access=true",
            max_rows=10,
        )


def test_sql_still_joins_registered_tables():
    # The containment must not cost the feature: multi-table JOINs over the
    # registered DataFrames are the whole point of run_sql.
    orders = pd.DataFrame({"k": [1, 2, 3], "a": ["x", "y", "z"]})
    payments = pd.DataFrame({"k": [2, 3, 4], "b": [20, 30, 40]})
    r = A.run_sql(
        {"orders": orders, "payments": payments},
        "SELECT orders.k, orders.a, payments.b FROM orders "
        "JOIN payments USING (k) ORDER BY orders.k",
        max_rows=10,
    )
    assert r["row_count"] == 2
    assert r["rows"][0] == {"k": 2, "a": "y", "b": 20}


# --------------------------------------------------------------------------- #
# forecast — the QA pass could get a forecast out, but had to judge for itself
# that it was not decision-grade. That judgement belongs in the tool.
# --------------------------------------------------------------------------- #
def _months(values: list[float]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": pd.date_range("2024-01-01", periods=len(values), freq="MS"),
            "sales": values,
        }
    )


def test_forecast_refuses_when_history_is_too_short():
    """A trend through 4 points is fitting noise. Refusing is the honest answer."""
    with pytest.raises(A.DataError, match="not enough history"):
        A.forecast(_months([1, 2, 3, 4]), date_col="date", value_col="sales")


def test_forecast_projects_a_clean_trend_and_calls_it_decision_grade():
    r = A.forecast(
        _months([100 + 8 * i for i in range(18)]),
        date_col="date",
        value_col="sales",
        periods=3,
    )
    assert r["decision_grade"] is True
    assert r["blockers"] == []
    assert r["r_squared"] == 1.0
    assert len(r["forecast"]) == 3
    # 18 points 0..17 rising by 8 from 100 -> next period is 100 + 8*18.
    assert r["forecast"][0]["forecast"] == 244.0


def test_forecast_flags_noise_instead_of_pretending():
    rng = __import__("numpy").random.default_rng(0)
    r = A.forecast(
        _months(list(rng.normal(100, 30, 12))),
        date_col="date",
        value_col="sales",
        periods=3,
    )
    assert r["decision_grade"] is False
    assert any("noise" in b for b in r["blockers"])


def test_forecast_returns_a_prediction_interval_that_widens_with_horizon():
    r = A.forecast(
        _months([100 + 8 * i + (3 if i % 2 else -3) for i in range(18)]),
        date_col="date",
        value_col="sales",
        periods=4,
    )
    widths = [p["upper"] - p["lower"] for p in r["forecast"]]
    assert all(w > 0 for w in widths)
    # Uncertainty must GROW with distance — a flat band would be the giveaway that
    # this is a confidence interval on the fitted line rather than a prediction
    # interval for a future observation.
    assert widths == sorted(widths) and widths[-1] > widths[0]


def test_forecast_output_is_plain_json():
    """numpy scalars are float subclasses, so they slip past _jsonable untouched."""
    import json

    r = A.forecast(
        _months([100 + 8 * i for i in range(18)]), date_col="date", value_col="sales"
    )
    round_tripped = json.loads(json.dumps(r))
    assert type(round_tripped["forecast"][0]["forecast"]) is float


def test_forecast_rejects_an_absurd_horizon():
    with pytest.raises(A.DataError, match="periods"):
        A.forecast(
            _months([100 + i for i in range(18)]),
            date_col="date",
            value_col="sales",
            periods=99,
        )


def test_seasonality_is_a_note_not_a_blocker():
    """A perfect trend must stay decision-grade; a warning that always fires is
    a warning nobody reads."""
    r = A.forecast(
        _months([100 + 8 * i for i in range(18)]), date_col="date", value_col="sales"
    )
    assert r["decision_grade"] is True
    assert any("seasonality" in c for c in r["caveats"])


def test_time_series_still_works_after_the_resample_extraction():
    r = A.time_series(
        _months([10, 20, 30, 40, 50, 60]), date_col="date", value_col="sales"
    )
    assert r["n_periods"] == 6 and r["overall_direction"] == "up"
