"""Phase 4 — fetch a first-party (Google) access token from Convex, out-of-band.

Mirrors `ConvexClient.fetch_file`: a POST to a streamId-SCOPED, ingress-secret-gated
endpoint. Convex derives the owning user from the live stream and returns ONLY a
short-lived access token (never the refresh token). The token is held transiently by
the adapter, injected in the outbound `Authorization` header, and NEVER placed in tool
args/results/events/dispatch/logs. A `needs_reauth` connector comes back as a typed,
honest capability gap — never a fabricated result.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx


@dataclass(frozen=True, slots=True)
class ConnectorToken:
    connected: bool
    access_token: str = ""
    scopes: tuple[str, ...] = ()
    gsc_site: str = ""
    ga4_property: str = ""
    needs_reauth: bool = False
    reason: str = ""  # "not_connected" | "needs_reauth" | "unavailable"


class ConnectorClient:
    """Resolves a fresh access token for the current stream's connected account."""

    def __init__(self, settings, http: httpx.AsyncClient) -> None:
        self._s = settings
        self._c = http

    async def fetch_token(
        self, stream_id: str, provider: str = "google"
    ) -> ConnectorToken:
        try:
            r = await self._c.post(
                self._s.connector_token_url,
                json={"streamId": stream_id, "provider": provider},
                headers={
                    "content-type": "application/json",
                    "x-ai-key": self._s.ai_ingress_secret,
                },
                timeout=httpx.Timeout(connect=2.0, read=15.0, write=5.0, pool=2.0),
            )
        except httpx.HTTPError:
            return ConnectorToken(connected=False, reason="unavailable")
        if r.status_code == 409:
            return ConnectorToken(
                connected=False, needs_reauth=True, reason="needs_reauth"
            )
        if r.status_code == 503:
            return ConnectorToken(connected=False, reason="unavailable")
        if r.status_code != 200:
            return ConnectorToken(connected=False, reason="unavailable")
        try:
            data = r.json()
        except ValueError:
            return ConnectorToken(connected=False, reason="unavailable")
        if not data.get("connected"):
            return ConnectorToken(
                connected=False,
                needs_reauth=bool(data.get("reason") == "needs_reauth"),
                reason=str(data.get("reason") or "not_connected"),
            )
        return ConnectorToken(
            connected=True,
            access_token=str(data.get("accessToken") or ""),
            scopes=tuple(data.get("scopes") or ()),
            gsc_site=str(data.get("gscSite") or ""),
            ga4_property=str(data.get("ga4Property") or ""),
        )
