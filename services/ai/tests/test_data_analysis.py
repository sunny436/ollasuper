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
