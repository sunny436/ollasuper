"""HTTP client for the official MCP Registry (`/v0.1`).

Plain JSON over HTTP on the httpx already pinned in this service — no registry
SDK, no MCP SDK. The MCP protocol is not involved in discovery at all.

TARGETS `/v0.1`, NOT `/v0`. Both answer today, but `v0.1` is the version the
OpenAPI document describes (`list-servers-v0.1`) and the one the registry README
declares frozen.

THE TRAP THIS CLIENT IS SHAPED AROUND: the registry **silently ignores unknown
query parameters and still returns 200** (probed). A typo'd `updated_since`
therefore degrades an incremental sync into a full one with no error anywhere.
Parameter names are constants here, and `sync.py` verifies the filter actually
took effect rather than trusting the status code.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.logging import get_logger

log = get_logger(__name__)

__all__ = ["RegistryClient", "RegistryError", "RegistryPage"]

# The registry publishes no RateLimit-* headers (probed), so limits are UNKNOWN.
# Serial paging with backoff is the conservative reading: there is no reason to
# parallelise a cursor chain anyway, since each page depends on the previous one.
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
# A registry page is a few hundred KB at limit=100. A response far larger than
# that is a malfunction or an attack, and is refused before it is parsed.
_MAX_RESPONSE_BYTES = 32 * 1024 * 1024


class RegistryError(RuntimeError):
    """A registry fetch that failed. `retryable` drives the sync's backoff."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status


@dataclass(frozen=True)
class RegistryPage:
    payload: dict
    next_cursor: str | None


class RegistryClient:
    """Paged reads from the official registry. Stateless apart from its client."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        base_url: str,
        page_size: int = 100,
        max_retries: int = 4,
        backoff_base_s: float = 1.0,
    ) -> None:
        self._http = http
        self._base = base_url.rstrip("/")
        self._page_size = max(1, min(page_size, 100))
        self._max_retries = max(0, max_retries)
        self._backoff = backoff_base_s

    @staticmethod
    def build_http_client(timeout_s: float = 30.0) -> httpx.AsyncClient:
        """A client with the conservative posture registry reads need.

        `follow_redirects=False` is deliberate: a redirect is the one way an
        upstream response could point this client at a host the operator never
        configured. A legitimate registry move should be a config change, not a
        silently followed 302.
        """
        return httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=timeout_s, write=10.0, pool=5.0),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
            follow_redirects=False,
            headers={"accept": "application/json", "user-agent": "OllaSuper-MCP/0.1"},
        )

    async def fetch_page(
        self,
        *,
        cursor: str | None = None,
        updated_since: str | None = None,
        search: str | None = None,
        version: str | None = None,
    ) -> RegistryPage:
        """One page of `/v0.1/servers`, with bounded retry on transient failure."""
        params: dict[str, Any] = {"limit": self._page_size}
        if cursor:
            params["cursor"] = cursor
        if updated_since:
            # NOTE: `include_deleted` is documented as "always true when
            # updated_since is provided", so an incremental page CARRIES
            # TOMBSTONES. sync.py must apply them, not filter them out.
            params["updated_since"] = updated_since
        if search:
            params["search"] = search
        if version:
            params["version"] = version
        return await self._get("/v0.1/servers", params)

    async def fetch_versions(self, server_name: str) -> RegistryPage:
        """Every version of one server.

        The name is reverse-DNS and contains "/", so it MUST be percent-encoded
        with `safe=""` — otherwise the slash is read as a path separator and the
        request 404s against a route that does not exist.
        """
        encoded = quote(server_name, safe="")
        return await self._get(f"/v0.1/servers/{encoded}/versions", {})

    async def health(self) -> dict:
        return (await self._get("/v0.1/health", {})).payload

    async def _get(self, path: str, params: dict) -> RegistryPage:
        url = f"{self._base}{path}"
        attempt = 0
        while True:
            try:
                resp = await self._http.get(url, params=params)
            except httpx.TimeoutException as e:
                if attempt >= self._max_retries:
                    raise RegistryError(f"timeout: {e}", retryable=True) from e
                await self._sleep(attempt, None)
                attempt += 1
                continue
            except httpx.HTTPError as e:
                if attempt >= self._max_retries:
                    raise RegistryError(f"transport: {e}", retryable=True) from e
                await self._sleep(attempt, None)
                attempt += 1
                continue

            if resp.status_code in _RETRYABLE_STATUS:
                if attempt >= self._max_retries:
                    raise RegistryError(
                        f"registry {resp.status_code}",
                        retryable=True,
                        status=resp.status_code,
                    )
                await self._sleep(attempt, resp.headers.get("retry-after"))
                attempt += 1
                continue

            if resp.status_code >= 400:
                # A 4xx is a permanently invalid request. Retrying it is just
                # load on someone else's service for a result that cannot change.
                raise RegistryError(
                    f"registry {resp.status_code}",
                    retryable=False,
                    status=resp.status_code,
                )

            if len(resp.content) > _MAX_RESPONSE_BYTES:
                raise RegistryError("registry response too large", retryable=False)

            try:
                payload = resp.json()
            except ValueError as e:
                raise RegistryError(f"malformed JSON: {e}", retryable=False) from e
            if not isinstance(payload, dict):
                raise RegistryError(
                    "registry payload is not an object", retryable=False
                )

            meta = payload.get("metadata")
            cursor = None
            if isinstance(meta, dict):
                nxt = meta.get("nextCursor")
                cursor = nxt if isinstance(nxt, str) and nxt else None
            return RegistryPage(payload=payload, next_cursor=cursor)

    async def _sleep(self, attempt: int, retry_after: str | None) -> None:
        """Honour Retry-After when the server sends one; otherwise exponential
        backoff with jitter, so repeated failures do not synchronise into a
        thundering retry against a service that is already struggling."""
        if retry_after:
            try:
                await asyncio.sleep(min(float(retry_after), 60.0))
                return
            except ValueError:
                pass
        delay = min(self._backoff * (2**attempt), 30.0)
        await asyncio.sleep(delay * (0.5 + random.random() / 2))  # noqa: S311
