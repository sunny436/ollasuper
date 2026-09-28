"""The ONE guarded way untrusted workbook bytes are parsed (audit F-04).

Every path that opens an XLSX — ingestion, the inline document text of a chat
attachment, and the data-analysis preview/loader — goes through here, so they
cannot drift apart again (the preview used to skip the compression-ratio guard
and parse synchronously on the event loop).

Two layers, both mandatory:

  1. `guard_ooxml` — entry count, expanded bytes and compression ratio, from
     the zip directory, before anything decompresses.
  2. A metered decode in the SANDBOX child (app/sandbox): a killable process
     with CPU/memory rlimits, stopped at `ai_xlsx_max_cells` logical cells or
     `ai_xlsx_max_rows` rows. A thread under `asyncio.wait_for` was neither
     killable nor bounded — the await ended, the work did not.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable

from app.config import Settings
from app.ingest.guards import guard_ooxml
from app.ingest.types import IngestError, NormalizedDoc
from app.sandbox import ops
from app.sandbox.harness import run_sandboxed


class XlsxRejected(ValueError):
    """The workbook was refused (too large, malformed, or timed out)."""


def _limits(settings: Settings) -> dict:
    return {
        "max_cells": int(settings.ai_xlsx_max_cells),
        "max_rows": int(settings.ai_xlsx_max_rows),
    }


async def _run(
    op: str,
    raw: bytes,
    params: dict,
    settings: Settings,
    inproc: Callable[[], tuple[dict, bytes]],
) -> tuple[dict, bytes]:
    async def fallback() -> tuple[dict, bytes]:
        # Tier 4 only (no POSIX fork/exec — the Windows dev box). Same metered
        # decoder, just not killable; production runs the sandboxed child.
        try:
            return await asyncio.to_thread(inproc)
        except ops.DecodeError as e:
            return {"ok": False, "error": str(e), "kind": "decode"}, b""

    try:
        meta, body = await run_sandboxed(
            op,
            raw,
            params,
            timeout_s=settings.ai_ingest_parse_timeout_s,
            fallback=fallback,
        )
    except TimeoutError as e:
        raise XlsxRejected("the spreadsheet took too long to read") from e
    except RuntimeError as e:
        raise XlsxRejected("the spreadsheet could not be read") from e
    if not meta.get("ok"):
        reason = meta.get("error") or "the spreadsheet could not be read"
        raise XlsxRejected(str(reason))
    return meta, body


def _check_archive(raw: bytes, settings: Settings) -> None:
    try:
        guard_ooxml(raw, settings)
    except IngestError as e:
        raise XlsxRejected(str(e)) from e


async def parse_xlsx_guarded(
    raw: bytes, *, name: str, settings: Settings
) -> list[NormalizedDoc]:
    """Ingestion / inline text of a workbook, or XlsxRejected."""
    _check_archive(raw, settings)
    # Text is capped at twice what ingestion indexes (see ops.trim_docs).
    params = {
        "name": name,
        **_limits(settings),
        "max_chars": int(settings.ai_ingest_max_chars) * 2,
    }

    def inproc() -> tuple[dict, bytes]:
        docs = ops.xlsx_docs(raw, **params)
        return {"ok": True}, json.dumps(docs).encode("utf-8")

    _meta, body = await _run("xlsx_docs", raw, params, settings, inproc)
    return [
        NormalizedDoc(
            text=d["text"],
            section=d.get("section"),
            metadata=d.get("metadata") or {},
        )
        for d in json.loads(body.decode("utf-8") or "[]")
    ]


async def check_xlsx_budget(raw: bytes, *, settings: Settings) -> None:
    """Refuse a workbook whose logical size exceeds the ceiling, BEFORE a
    pandas parse of the same bytes (the data-analysis preview and loader)."""
    _check_archive(raw, settings)
    params = _limits(settings)

    def inproc() -> tuple[dict, bytes]:
        return {"ok": True, **ops.xlsx_scan(raw, **params)}, b""

    await _run("xlsx_scan", raw, params, settings, inproc)
