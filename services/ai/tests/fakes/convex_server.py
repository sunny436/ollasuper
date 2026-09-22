"""A real Convex-ingress stand-in on a real loopback socket.

Deliberately NOT an ASGITransport mock: part of what test_writer asserts is
that the writer reuses one pooled connection, and an in-process transport has
no connections to count. A per-flush AsyncClient would show ~150 connections
here instead of 1 — that is the single worst mistake this design can make, and
this fake is how it gets caught.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import time
from dataclasses import dataclass, field

import uvicorn
from fastapi import FastAPI, Request


@dataclass
class Delta:
    seq: int
    text: str
    t_ms: float


@dataclass
class Finalized:
    status: str
    text: str
    usage: dict | None
    error: dict | None


@dataclass
class FakeConvex:
    url: str
    deltas: dict[str, list[Delta]] = field(default_factory=dict)
    finalized: dict[str, Finalized] = field(default_factory=dict)
    finalize_count: dict[str, int] = field(default_factory=dict)
    heartbeats: dict[str, int] = field(default_factory=dict)
    titles: dict[str, str] = field(default_factory=dict)
    #: (streamId, storageId) -> bytes, served by /ai/file.
    files: dict[tuple[str, str], bytes] = field(default_factory=dict)
    connections_opened: int = 0
    started_at: float = field(default_factory=time.monotonic)

    # Phase 5 durable SEO runs (keyed by runId).
    seo_enqueued: list[dict] = field(default_factory=list)
    seo_progress: list[dict] = field(default_factory=list)
    seo_parks: list[dict] = field(default_factory=list)
    seo_heartbeats: dict[str, int] = field(default_factory=dict)
    seo_finalized: dict[str, dict] = field(default_factory=dict)
    seo_reports: dict[str, dict] = field(default_factory=dict)
    seo_artifacts: list[dict] = field(default_factory=list)

    # test knobs
    cancel_streams: set[str] = field(default_factory=set)
    unknown_streams: set[str] = field(default_factory=set)
    seo_stale: set[str] = field(default_factory=set)  # runIds whose writes return stale
    seo_cancel: set[str] = field(default_factory=set)  # runIds whose writes get cancel
    fail_next: int = 0
    fail_status: int = 500
    attempts: int = 0
    # /api/mutation (chat/ingress:apply) accounting — see build()
    expected_key: str = "test-ingress-secret-bbbbbbbbbbbbbbbb"
    mutation_calls: int = 0

    def total_text(self, stream_id: str) -> str:
        return "".join(
            d.text for d in sorted(self.deltas.get(stream_id, []), key=lambda d: d.seq)
        )


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def build(state: FakeConvex) -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def count_connections(request: Request, call_next):
        # Starlette gives each TCP connection a distinct client port.
        client = request.scope.get("client")
        if client:
            key = f"{client[0]}:{client[1]}"
            if key not in _seen:
                _seen.add(key)
                state.connections_opened += 1
        return await call_next(request)

    _seen: set[str] = set()

    @app.post("/api/mutation")
    async def mutation(request: Request):
        # What the real backend does for chat/ingress:apply: the same op
        # handler, wrapped in Convex's {status, value} envelope. Any other path
        # is "not found", which the client treats as "use the HTTP action".
        env = await request.json()
        if env.get("path") != "chat/ingress:apply":
            return _json(
                {"status": "error", "errorMessage": "Could not find public function"}
            )
        args = env.get("args") or {}
        if args.get("key") != state.expected_key:
            return _json(
                {
                    "status": "error",
                    "errorMessage": "Uncaught ConvexError: unauthorized",
                }
            )
        state.mutation_calls += 1
        inner = await _ingress_body(args.get("body") or {})
        return _json(
            {
                "status": "success",
                "value": {"status": inner.status_code, "body": json.loads(inner.body)},
            }
        )

    @app.post("/ai/ingress")
    async def ingress(request: Request):
        return await _ingress_body(await request.json())

    async def _ingress_body(body: dict):
        state.attempts += 1
        if state.fail_next > 0:
            state.fail_next -= 1
            return _json({"error": "boom"}, state.fail_status)

        op = body.get("op")
        sid = body.get("streamId", "")

        if sid in state.unknown_streams:
            return _json({"error": "unknown stream"}, 404)

        cancel = sid in state.cancel_streams

        if op == "delta":
            bucket = state.deltas.setdefault(sid, [])
            known = {d.seq for d in bucket}
            for d in body.get("deltas", []):
                if d["seq"] in known:
                    continue  # mirror Convex's indexed idempotency probe
                bucket.append(
                    Delta(
                        seq=d["seq"],
                        text=d["text"],
                        t_ms=(time.monotonic() - state.started_at) * 1000,
                    )
                )
            return _json({"ok": True, "cancel": cancel})

        if op == "heartbeat":
            state.heartbeats[sid] = state.heartbeats.get(sid, 0) + 1
            return _json({"ok": True, "cancel": cancel})

        if op == "finalize":
            state.finalize_count[sid] = state.finalize_count.get(sid, 0) + 1
            state.finalized[sid] = Finalized(
                status=body.get("status", ""),
                text=body.get("text", ""),
                usage=body.get("usage"),
                error=body.get("error"),
            )
            return _json({"ok": True})

        if op == "title":
            state.titles[sid] = body.get("title", "")
            return _json({"ok": True})

        # Phase 5 — durable SEO run ops (keyed by runId, not streamId).
        if op and op.startswith("seo-run-"):
            rid = body.get("runId", "")
            stale = {"stale": rid in state.seo_stale, "cancel": rid in state.seo_cancel}
            if op == "seo-run-enqueue":
                state.seo_enqueued.append(body)
                return _json({"ok": True, "runId": f"run_{len(state.seo_enqueued)}"})
            if op == "seo-run-progress":
                state.seo_progress.append(body)
                return _json(stale)
            if op == "seo-run-heartbeat":
                state.seo_heartbeats[rid] = state.seo_heartbeats.get(rid, 0) + 1
                return _json(stale)
            if op == "seo-run-park":
                state.seo_parks.append(body)
                return _json(stale)
            if op == "seo-run-finalize":
                state.seo_finalized[rid] = body
                return _json({"ok": True})
            if op == "seo-run-report":
                state.seo_reports[rid] = body
                return _json(
                    {
                        "ok": True,
                        "reportId": body.get("report", {}).get("report_id", "rpt_x"),
                    }
                )

        return _json({"error": f"unknown op {op}"}, 400)

    @app.post("/ai/file")
    async def file(request: Request):
        from fastapi.responses import Response

        body = await request.json()
        # Mirrors the real route's capability scoping: the blob is only served
        # if it is reachable from THIS stream. A test that keyed on storageId
        # alone would pass even if the client stopped sending streamId.
        key = (body.get("streamId", ""), body.get("storageId", ""))
        blob = state.files.get(key)
        if blob is None:
            return _json({"error": "not found"}, 404)
        return Response(blob, media_type="application/octet-stream")

    @app.post("/ai/seo-artifact")
    async def seo_artifact(request: Request):
        blob = await request.body()
        rid = request.headers.get("x-run-id", "")
        key = request.headers.get("x-artifact-key", "")
        state.seo_artifacts.append(
            {"runId": rid, "artifactKey": key, "size": len(blob)}
        )
        return _json(
            {
                "artifactId": f"art_{len(state.seo_artifacts)}",
                "size": len(blob),
                "contentHash": request.headers.get("x-artifact-sha256", ""),
            }
        )

    @app.get("/version")
    async def version():
        return _json({"version": "fake"})

    return app


def _json(body: dict, status: int = 200):
    from fastapi.responses import JSONResponse

    return JSONResponse(body, status_code=status)


class FakeConvexServer:
    """Runs the fake on a real ephemeral port for the duration of a test."""

    def __init__(self) -> None:
        self.port = _free_port()
        self.state = FakeConvex(url=f"http://127.0.0.1:{self.port}")
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None

    async def __aenter__(self) -> FakeConvex:
        config = uvicorn.Config(
            build(self.state),
            host="127.0.0.1",
            port=self.port,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve())
        for _ in range(200):
            if self._server.started:
                break
            await asyncio.sleep(0.02)
        return self.state

    async def __aexit__(self, *exc) -> None:
        if self._server:
            self._server.should_exit = True
        if self._task:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._task, timeout=5)
