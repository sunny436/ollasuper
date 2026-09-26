"""Load an uploaded structured file into a bounded pandas DataFrame.

The pure parsers (`parse_dataframe`, `list_sheets`, `sanitize_table_name`) are
Convex/network-free and unit-tested directly. `load_dataset` adds the thread-scoped
byte fetch (`convex.fetch_file`) + a small per-process LRU keyed by the immutable
storageId, so repeat tool calls in a turn — and follow-up turns — don't re-fetch or
re-parse. Rows are capped at READ time so a huge file never fully materialises.
"""

from __future__ import annotations

import csv
import io
import re
from collections import OrderedDict
from dataclasses import dataclass

import pandas as pd

from app.data.analysis import DataError

_CSV_MIMES = {"text/csv", "application/csv", "text/tab-separated-values"}
_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@dataclass(frozen=True, slots=True)
class DatasetRef:
    """A thread's tabular attachment. `storage_id` never reaches the model — the
    model names a dataset and the tool layer resolves it here."""

    name: str
    storage_id: str
    mime: str


def is_tabular(name: str, mime: str) -> bool:
    m = (mime or "").split(";")[0].strip().lower()
    n = (name or "").lower()
    return (
        m in _CSV_MIMES
        or m == _XLSX_MIME
        or n.endswith((".csv", ".tsv", ".xlsx"))
    )


def _is_xlsx(name: str, mime: str) -> bool:
    return (mime or "").split(";")[0].strip().lower() == _XLSX_MIME or (
        name or ""
    ).lower().endswith(".xlsx")


def sanitize_table_name(name: str) -> str:
    """Filename → a valid, stable SQL identifier for DuckDB (`sales.csv` → `sales`)."""
    stem = re.sub(r"\.(csv|tsv|xlsx)$", "", (name or "").strip(), flags=re.I)
    ident = re.sub(r"[^0-9a-zA-Z_]", "_", stem).strip("_").lower()
    if not ident:
        ident = "dataset"
    if ident[0].isdigit():
        ident = f"t_{ident}"
    return ident[:60]


def _sniff_sep(head: str) -> str:
    try:
        return csv.Sniffer().sniff(head, delimiters=",\t;|").delimiter
    except csv.Error:
        return ","


def list_sheets(raw: bytes, name: str, mime: str) -> list[str]:
    """Sheet names for an XLSX (read-only, no full parse); [] for CSV."""
    if not _is_xlsx(name, mime):
        return []
    try:
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        try:
            return list(wb.sheetnames)
        finally:
            wb.close()
    except Exception:  # noqa: BLE001 — a broken workbook falls to the parse error below
        return []


def parse_dataframe(
    raw: bytes,
    name: str,
    mime: str,
    *,
    max_rows: int,
    sheet: str | None = None,
) -> tuple[pd.DataFrame, bool]:
    """Parse bytes into a bounded DataFrame. Returns (df, truncated). Raises
    `DataError` on empty/malformed input (never a bare exception)."""
    if not raw:
        raise DataError("the uploaded file is empty.")
    try:
        if _is_xlsx(name, mime):
            target = sheet if sheet else 0
            df = pd.read_excel(
                io.BytesIO(raw), sheet_name=target, nrows=max_rows + 1
            )
        else:
            head = raw[:8192].decode("utf-8", errors="replace")
            sep = "\t" if name.lower().endswith(".tsv") else _sniff_sep(head)
            df = pd.read_csv(
                io.BytesIO(raw),
                sep=sep,
                nrows=max_rows + 1,
                encoding="utf-8",
                encoding_errors="replace",
                on_bad_lines="skip",
                skip_blank_lines=True,
            )
    except DataError:
        raise
    except Exception as e:  # noqa: BLE001 — malformed file → a clean user message
        raise DataError(
            f"could not parse '{name}' as a table: {str(e).splitlines()[0][:200]}"
        ) from e
    if df.shape[1] == 0 or df.shape[0] == 0:
        raise DataError(f"'{name}' parsed to an empty table (no rows or columns).")
    truncated = len(df) > max_rows
    if truncated:
        df = df.head(max_rows)
    # normalise unnamed columns so they are addressable
    df.columns = [
        (str(c) if str(c).strip() and not str(c).startswith("Unnamed:") else f"col_{i}")
        for i, c in enumerate(df.columns)
    ]
    return df, truncated


# --- per-process df LRU (keyed by immutable storageId + sheet) ------------
class _DataframeCache:
    def __init__(self, maxsize: int) -> None:
        self._store: OrderedDict[tuple[str, str], pd.DataFrame] = OrderedDict()
        self._max = max(1, maxsize)

    def get(self, key: tuple[str, str]) -> pd.DataFrame | None:
        df = self._store.get(key)
        if df is not None:
            self._store.move_to_end(key)
        return df

    def put(self, key: tuple[str, str], df: pd.DataFrame) -> None:
        self._store[key] = df
        self._store.move_to_end(key)
        while len(self._store) > self._max:
            self._store.popitem(last=False)


_CACHE = _DataframeCache(6)


def render_preview(raw: bytes, name: str, mime: str, *, rows: int = 10) -> str:
    """A COMPACT dataset preview (schema + a few sample rows) inlined INSTEAD of the
    full file when data-analysis is on — so the model must use the compute tools
    rather than eyeball the raw data. Robust: a parse failure yields a short note,
    never an exception (the dataset is still registered + analysable via the tools)."""
    table = sanitize_table_name(name)
    try:
        df, truncated = parse_dataframe(raw, name, mime, max_rows=max(rows, 1))
    except DataError as e:
        return (
            f'<dataset name="{name}" table="{table}">\n'
            f"(preview unavailable: {e}). Use the data tools to analyse it.\n"
            f"</dataset>"
        )
    schema = ", ".join(f"{c}:{df[c].dtype}" for c in df.columns)[:1500]
    sample = df.head(rows).to_csv(index=False)
    more = " (+ more rows)" if truncated else ""
    return (
        f'<dataset name="{name}" table="{table}" columns="{df.shape[1]}">\n'
        f"Schema: {schema}\n"
        f"Sample (first {min(rows, len(df))} rows{more}):\n{sample}\n"
        f"NOTE: this is only a PREVIEW — the full dataset is loaded server-side. "
        f"Use the data tools (profile_dataset / sql_query / statistics / "
        f"detect_outliers / time_series) to compute over ALL rows; never calculate "
        f"from this sample.\n</dataset>"
    )


async def load_dataset(
    convex,
    settings,
    ref: DatasetRef,
    stream_id: str,
    *,
    sheet: str | None = None,
) -> pd.DataFrame:
    """Fetch (thread-scoped) + parse a dataset into a bounded, cached DataFrame."""
    import asyncio

    global _CACHE
    _CACHE._max = getattr(settings, "ai_data_cache_max", 6)
    key = (ref.storage_id, sheet or "")
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    raw, _mime = await convex.fetch_file(ref.storage_id, stream_id)
    if _is_xlsx(ref.name, ref.mime):
        # Same workbook guard as ingestion (audit F-04): archive limits plus a
        # metered, killable scan BEFORE pandas walks the same bytes.
        from app.ingest.xlsx_guard import XlsxRejected, check_xlsx_budget

        try:
            await check_xlsx_budget(raw, settings=settings)
        except XlsxRejected as e:
            raise DataError(f"could not load '{ref.name}': {e}") from e
    max_rows = getattr(settings, "ai_data_max_rows", 1_000_000)
    df, _trunc = await asyncio.to_thread(
        parse_dataframe, raw, ref.name, ref.mime, max_rows=max_rows, sheet=sheet
    )
    _CACHE.put(key, df)
    return df
