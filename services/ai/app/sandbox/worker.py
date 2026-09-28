"""The sandbox child: decode attacker bytes, hand back the result, hold no secrets.

Launched as `python -m app.sandbox.worker <op>` by harness.py, ALWAYS inside a
stripped environment (no OPENROUTER_API_KEY, no AI_INGRESS_SECRET, no
KNOWLEDGE_DATABASE_URL — see harness._SAFE_ENV) and, where the platform allows,
inside a private network namespace with resource caps. So even a
memory-corruption RCE in Pillow or PDFium lands in a process that has no secret
to read and no network to reach.

Protocol, deliberately tiny (no pickle — a code-exec sink is the last thing this
process should expose):
  in : argv[1]=op, argv[2]=JSON params ; raw payload on stdin
  out: >I meta_len | meta(JSON utf-8) | body(bytes)   on stdout
  meta = {"ok": true, ...} or {"ok": false, "error": "..."}
An unexpected crash exits non-zero with nothing on stdout; the parent treats
that as failure, which is exactly right for a segfault or an OOM kill.
"""

from __future__ import annotations

import json
import struct
import sys


def _emit(meta: dict, body: bytes = b"") -> None:
    blob = json.dumps(meta).encode("utf-8")
    out = sys.stdout.buffer
    out.write(struct.pack(">I", len(blob)))
    out.write(blob)
    out.write(body)
    out.flush()


def _opt_int(v: object) -> int | None:
    return None if v is None else int(v)  # type: ignore[call-overload]


def main() -> int:
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    payload = sys.stdin.buffer.read()

    from app.sandbox import ops

    try:
        if op == "image":
            body, out_mime = ops.normalise_image(
                payload, params.get("mime", ""), int(params.get("long_edge", 1568))
            )
            _emit({"ok": True, "mime": out_mime}, body)
            return 0
        if op == "pdf_text":
            text = ops.extract_pdf_text(payload)
            _emit({"ok": True}, text.encode("utf-8"))
            return 0
        if op == "xlsx_docs":
            docs = ops.xlsx_docs(
                payload,
                name=str(params.get("name", "")),
                max_cells=int(params["max_cells"]),
                max_rows=int(params["max_rows"]),
                max_chars=_opt_int(params.get("max_chars")),
            )
            _emit({"ok": True}, json.dumps(docs).encode("utf-8"))
            return 0
        if op == "ingest_parse":
            docs = ops.ingest_parse(
                payload,
                file_type=str(params.get("file_type", "")),
                name=str(params.get("name", "")),
                max_chars=_opt_int(params.get("max_chars")),
            )
            _emit({"ok": True}, json.dumps(docs).encode("utf-8"))
            return 0
        if op == "pdf_pages":
            pages = ops.pdf_pages(
                payload,
                name=str(params.get("name", "")),
                budget_s=float(params.get("budget_s", 0)),
                max_chars=_opt_int(params.get("max_chars")),
            )
            _emit({"ok": True}, json.dumps(pages).encode("utf-8"))
            return 0
        if op == "xlsx_scan":
            stats = ops.xlsx_scan(
                payload,
                max_cells=int(params["max_cells"]),
                max_rows=int(params["max_rows"]),
            )
            _emit({"ok": True, **stats})
            return 0
        if op == "secret_sweep":
            # Security audit: rule-based secret scan over a repository's tracked
            # files. Runs HERE so a 16MB regex pass never holds the plane's GIL.
            from app.secaudit.scanners import sweep_files

            result = sweep_files(json.loads(payload.decode("utf-8")))
            _emit({"ok": True}, json.dumps(result).encode("utf-8"))
            return 0
        _emit({"ok": False, "error": f"unknown op {op!r}"})
        return 2
    except ops.DecodeError as e:
        # A handled decode failure the parent should surface to the user.
        _emit({"ok": False, "error": str(e), "kind": "decode"})
        return 0
    except Exception as e:  # noqa: BLE001 — never leak a native traceback to stdout
        _emit({"ok": False, "error": type(e).__name__, "kind": "internal"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
