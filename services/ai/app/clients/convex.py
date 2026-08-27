"""HTTP client for talking back to Convex.

One AsyncClient for the process lifetime, created in the FastAPI lifespan and
injected. Constructing a client per flush would mean a TCP handshake every 96
characters — the single most common way this design goes wrong, and the thing
tests/test_writer.py explicitly asserts against.
"""

from __future__ import annotations

import asyncio
import random

import httpx

from app.config import Settings
from app.logging import get_logger

log = get_logger(__name__)

# Retry only what is worth retrying. A 401 means the secret is wrong; retrying
# just burns the deadline.
_RETRY_BACKOFF = (0.15, 0.4, 1.0, 2.5)


class ConvexUnavailable(RuntimeError):
    """Convex could not be reached, or returned a retryable error.

    The writer swallows these and carries the backlog into the next flush.
    """


class ConvexRejected(RuntimeError):
    """Convex refused the request and will keep refusing it.

    Separate from ConvexUnavailable on purpose: a 401 means AI_INGRESS_SECRET
    is wrong, and treating that as "transient" means every generation quietly
    burns the full 20s ingress deadline before failing. This must surface
    immediately and loudly.
    """


class ConvexClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._s = settings
        self._c = client

    @staticmethod
    def build_http_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=32,
                max_keepalive_connections=16,
                keepalive_expiry=30,
            ),
            timeout=httpx.Timeout(connect=2.0, read=8.0, write=8.0, pool=2.0),
            # Loopback to a Rust server; HTTP/1.1 keep-alive is plenty and
            # avoids pulling in the h2 dependency.
            http2=False,
        )

    async def ingress(self, body: dict) -> dict:
        """POST one op to /ai/ingress. Raises ConvexUnavailable on failure."""
        headers = {
            "content-type": "application/json",
            "x-ai-key": self._s.ai_ingress_secret,
        }
        last: Exception | None = None
        for attempt, backoff in enumerate(_RETRY_BACKOFF):
            try:
                r = await self._c.post(self._s.ingress_url, json=body, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException) as e:
                last = e
            else:
                if r.status_code < 400:
                    try:
                        return r.json()
                    except ValueError:
                        return {}
                if r.status_code == 404:
                    # Unknown or already-finalized stream. Not retryable, and
                    # not an error: tell the caller to stop.
                    return {"ok": False, "cancel": True, "unknown": True}
                if r.status_code < 500:
                    log.error(
                        "ingress_rejected",
                        extra={"status": r.status_code, "op": body.get("op")},
                    )
                    raise ConvexRejected(f"ingress rejected: {r.status_code}")
                last = ConvexUnavailable(f"ingress {r.status_code}")

            if attempt < len(_RETRY_BACKOFF) - 1:
                jitter = 0.75 + random.random() * 0.5  # noqa: S311
                await asyncio.sleep(backoff * jitter)

        raise ConvexUnavailable(str(last) if last else "ingress unavailable")

    async def fetch_file(self, storage_id: str, stream_id: str) -> tuple[bytes, str]:
        """Fetch attachment bytes.

        Goes through Convex with the ingress secret rather than using a
        ctx.storage.getUrl(). That URL is a BEARER CAPABILITY — unguessable but
        unscoped — so passing it around would leak it into request bodies,
        httpx logs and traces.

        `stream_id` is not decoration: /ai/file is capability-scoped, and Convex
        will only return the blob if it belongs to an attachment on THIS
        stream's thread. Without it the ingress secret alone would be a key to
        every blob in the deployment.
        """
        r = await self._c.post(
            self._s.file_url,
            json={"storageId": storage_id, "streamId": stream_id},
            headers={
                "content-type": "application/json",
                "x-ai-key": self._s.ai_ingress_secret,
            },
        )
        if r.status_code == 404:
            # Not ours, or gone. Retrying cannot help.
            raise ConvexRejected("attachment not available")
        if r.status_code != 200:
            raise ConvexUnavailable(f"file fetch failed: {r.status_code}")
        return r.content, r.headers.get("content-type", "application/octet-stream")

    async def fetch_ingest_file(self, ingest_id: str) -> tuple[bytes, str]:
        """Fetch the staging bytes for a knowledge-base file.

        Sibling of fetch_file, scoped by the ingestId capability (not streamId).
        Convex resolves the storageId server-side and returns the blob only if it
        is this row's own staging blob — the storageId never crosses to Python.
        """
        r = await self._c.post(
            self._s.ingest_file_url,
            json={"fileId": ingest_id},
            headers={
                "content-type": "application/json",
                "x-ai-key": self._s.ai_ingress_secret,
            },
            timeout=httpx.Timeout(connect=2.0, read=30.0, write=8.0, pool=2.0),
        )
        if r.status_code == 404:
            raise ConvexRejected("ingest file not available")
        if r.status_code != 200:
            raise ConvexUnavailable(f"ingest file fetch failed: {r.status_code}")
        return r.content, r.headers.get("content-type", "application/octet-stream")

    async def store_artifact(
        self,
        blob: bytes,
        *,
        stream_id: str,
        filename: str,
        fmt: str,
        mime: str,
        sha256: str | None = None,
        artifact_key: str | None = None,
    ) -> dict:
        """Store a GENERATED file blob and register it (File Generation System).

        POSTs the raw bytes to /ai/artifact (a dedicated binary endpoint, not the
        JSON ingress) with the metadata in headers. Capability-scoped by streamId
        exactly like /ai/file: Convex derives the owning user/thread/message from the
        stream and never trusts a client-sent owner. Returns `{artifactId, size}`;
        the download URL is minted later, owner-checked, so no bearer token is issued
        here. Raises on failure so the tool reports honestly, never a fake file.

        Phase 3 (additive): `x-artifact-sha256` declares the content hash for
        server-side integrity verification (mismatch → 400); `x-artifact-key` makes
        the store idempotent (a re-store with the same stream+key returns the existing
        artifactId). Both omitted for filegen ⇒ byte-identical."""
        headers = {
            "content-type": mime,
            "x-ai-key": self._s.ai_ingress_secret,
            "x-stream-id": stream_id,
            "x-artifact-format": fmt,
            # RFC 5987 not needed: filename is server-slugified to ASCII already.
            "x-artifact-filename": filename,
        }
        if sha256:
            headers["x-artifact-sha256"] = sha256
        if artifact_key:
            headers["x-artifact-key"] = artifact_key
        r = await self._c.post(
            self._s.artifact_url,
            content=blob,
            headers=headers,
            timeout=httpx.Timeout(connect=2.0, read=30.0, write=30.0, pool=2.0),
        )
        if r.status_code == 422:
            raise ConvexRejected("artifact checksum mismatch")
        if r.status_code == 404:
            raise ConvexRejected("artifact stream not available")
        if r.status_code >= 400:
            raise ConvexUnavailable(f"artifact store failed: {r.status_code}")
        try:
            return r.json()
        except ValueError:
            return {}

    async def set_file_status(
        self,
        ingest_id: str,
        status: str,
        *,
        chunk_count: int | None = None,
        parser_used: str | None = None,
        page_count: int | None = None,
        detected_type: str | None = None,
        content_hash: str | None = None,
        error: str | None = None,
        note: str | None = None,
    ) -> dict:
        """Report terminal ingestion status back to Convex (op:"file").

        Goes through the retrying ingress() so a transient Convex blip doesn't
        strand the file in `processing` (the stall reaper is the backstop). A 404
        (file deleted mid-ingest) surfaces as {unknown: True} and is not an error.
        `note` is a truthful partial-success message (e.g. a content-limit
        truncation), stored alongside a `ready` status.
        """
        body: dict = {"op": "file", "fileId": ingest_id, "status": status}
        if chunk_count is not None:
            body["chunkCount"] = chunk_count
        if parser_used is not None:
            body["parserUsed"] = parser_used
        if page_count is not None:
            body["pageCount"] = page_count
        if detected_type is not None:
            body["detectedType"] = detected_type
        if content_hash is not None:
            body["contentHash"] = content_hash
        if error is not None:
            body["error"] = error[:500]
        if note is not None:
            body["note"] = note[:300]
        return await self.ingress(body)

    async def set_file_progress(
        self,
        ingest_id: str,
        *,
        stage: str,
        progress: int | None = None,
        processed_units: int | None = None,
        total_units: int | None = None,
        message: str | None = None,
    ) -> dict:
        """Report intermediate ingestion progress (op:"file-progress"), status
        stays `processing`. Best-effort and coarse/throttled by the caller: the
        userFiles row it patches is behind a usePaginatedQuery, so each write
        re-sends the whole list to every subscriber (mirrors the chat two-write
        discipline). The terminal set_file_status is the authority."""
        body: dict = {"op": "file-progress", "fileId": ingest_id, "stage": stage}
        if progress is not None:
            body["progress"] = max(0, min(100, int(progress)))
        if processed_units is not None:
            body["processedUnits"] = processed_units
        if total_units is not None:
            body["totalUnits"] = total_units
        if message is not None:
            body["stageMessage"] = message[:120]
        return await self.ingress(body)

    async def healthy(self) -> bool:
        try:
            r = await self._c.get(
                f"{self._s.convex_internal_url.rstrip('/')}/version", timeout=3.0
            )
            return r.status_code < 500
        except httpx.HTTPError:
            return False
