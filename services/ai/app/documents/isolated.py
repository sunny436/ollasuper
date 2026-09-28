"""Document operations, run in the SANDBOX (File Library P0 — parser isolation).

Every op in `app.documents` parses a user's PDF or PPTX with native or
XML-parsing code (pypdf, pdfplumber, pypdfium2, python-pptx, lxml). They used to
run on a thread of this service - its memory, its environment (every secret),
its network - and an `asyncio.wait_for` timeout ended the await but never the
parse. They now run whole inside the sandbox child (app/sandbox/harness.py):
namespaces, read-only root, masked secrets, process/memory/CPU caps, and a
process-group kill on timeout. Only an ALLOWLISTED operation name crosses the
boundary (app.sandbox.ops.DOC_FUNCS) - never a module path or code.

The dev box (sandbox tier 4) runs the same function in-process, through the
same encode/decode, so both paths return identical results.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from app.documents.pdf_ops import DocumentError
from app.sandbox import ops as sandbox_ops
from app.sandbox.harness import run_sandboxed

# Headroom for pdfplumber / python-pptx on a 25 MB document.
DOC_MEM_BYTES = 2_500_000_000


async def run_doc_call(
    name: str,
    blobs: list[bytes],
    args: list[Any],
    *,
    timeout_s: float,
) -> Any:
    """Run allowlisted document op `name` on `blobs` (one file, or several for a
    merge) with JSON-safe `args`; return exactly what the function returns."""
    payload = b"".join(blobs)
    sizes = [len(b) for b in blobs]

    async def fallback() -> tuple[dict, bytes]:
        fn: Callable[..., Any] = sandbox_ops.doc_function(name)
        first: Any = blobs if name in sandbox_ops.MULTI_BLOB_DOC_FUNCS else blobs[0]
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(fn, first, *args), timeout_s
            )
        except DocumentError as e:
            return {"ok": False, "kind": "document", "error": str(e)}, b""
        return sandbox_ops.doc_encode(result)

    try:
        meta, body = await run_sandboxed(
            "doc_call",
            payload,
            {"fn": name, "args": args, "sizes": sizes},
            timeout_s=timeout_s,
            cpu_s=int(timeout_s) + 5,
            mem_bytes=DOC_MEM_BYTES,
            fallback=fallback,
        )
    except TimeoutError as e:
        raise DocumentError("the operation exceeded the time limit.") from e
    if not meta.get("ok"):
        if meta.get("kind") == "document":
            raise DocumentError(
                str(meta.get("error") or "the document could not be read.")
            )
        raise RuntimeError(str(meta.get("error") or "the operation failed"))
    return sandbox_ops.doc_decode(meta, body)
