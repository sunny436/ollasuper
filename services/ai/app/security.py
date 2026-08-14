"""Authentication for the inference plane."""

from __future__ import annotations

import hmac
from typing import Annotated

import jwt
from fastapi import Header, HTTPException, Request
from jwt import PyJWKClient

from app.config import Settings, get_settings

_jwks_client: PyJWKClient | None = None


async def require_service_key(
    request: Request,
    x_service_key: Annotated[str | None, Header()] = None,
) -> None:
    """Verify the Convex -> here service key.

    Reads settings off request.app.state rather than the cached global, so the
    credential this checks is always the same object the rest of the app was
    built with — a global here would let the two diverge, and would make the
    routes untestable without mutating process env.

    Uses hmac.compare_digest, never ==. Note the `|=` rather than an early
    return: returning as soon as a key matches would leak *which* key matched
    through timing. compare_digest still leaks length, which is acceptable for
    a fixed-length hex secret.
    """
    settings: Settings = getattr(request.app.state, "settings", None) or get_settings()
    presented = (x_service_key or "").encode()
    accepted = tuple(k.encode() for k in (settings.ai_service_key,) if k)
    if not accepted:
        # Refuse rather than fall open if the service was started unconfigured.
        raise HTTPException(status_code=503, detail="service key not configured")

    ok = False
    for key in accepted:
        ok |= hmac.compare_digest(presented, key)
    if not ok:
        raise HTTPException(status_code=401, detail="unauthorized")


def _jwks(settings: Settings) -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(
            f"{settings.convex_site_url.rstrip('/')}/.well-known/jwks.json",
            cache_keys=True,
            lifespan=600,
            max_cached_keys=8,
        )
    return _jwks_client


def verify_convex_jwt(token: str) -> dict:
    """Verify a Convex-issued RS256 JWT.

    Only used if the DIRECT browser->service path is ever enabled. `algorithms`
    is pinned explicitly — accepting the token's own `alg` header is the classic
    JWKS footgun.
    """
    settings = get_settings()
    signing_key = _jwks(settings).get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        issuer=settings.convex_site_url,
        audience=settings.convex_audience,
        options={"require": ["exp", "iss", "aud", "sub"], "verify_signature": True},
        leeway=30,
    )
