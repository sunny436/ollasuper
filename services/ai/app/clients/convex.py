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

    async def fetch_file(self, storage_id: str) -> tuple[bytes, str]:
        """Fetch attachment bytes.

        Goes through Convex with the ingress secret rather than using a
        ctx.storage.getUrl(). That URL is a BEARER CAPABILITY — unguessable but
        unscoped — so passing it around would leak it into request bodies,
        httpx logs and traces.
        """
        r = await self._c.post(
            self._s.file_url,
            json={"storageId": storage_id},
            headers={
                "content-type": "application/json",
                "x-ai-key": self._s.ai_ingress_secret,
            },
        )
        if r.status_code != 200:
            raise ConvexUnavailable(f"file fetch failed: {r.status_code}")
        return r.content, r.headers.get("content-type", "application/octet-stream")

    async def healthy(self) -> bool:
        try:
            r = await self._c.get(
                f"{self._s.convex_internal_url.rstrip('/')}/version", timeout=3.0
            )
            return r.status_code < 500
        except httpx.HTTPError:
            return False
