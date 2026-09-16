"""Background model health checks — the registry's only active component.

Runs inside myos-ai (the registry is per-process), started from `main.lifespan`
next to tool discovery. Lightweight by construction:

* one tick per `ai_model_health_probe_interval_s`, jittered, first tick after one
  interval (never at boot, never inside a short-lived test app);
* at most `_MAX_PROBES_PER_TICK` models per tick, most urgent first: cooldown
  expired, same-upstream sibling of a fresh 429, never checked, then no success
  from real traffic OR a probe within `ai_model_health_revalidate_s`;
* a probe is ONE tiny completion (`max_tokens` 8), 20s, no retries — a probe that
  retried a 429 would spend exactly the quota it exists to protect;
* the upstream map comes from the gateway's `/models` (`owned_by`), which costs
  no model quota.

Every tick is isolated: nothing it raises can reach chat, which only ever reads
the registry.
"""

from __future__ import annotations

import asyncio
import random

import httpx

from app.agent import health
from app.logging import get_logger

log = get_logger(__name__)

_MAX_PROBES_PER_TICK = 2
_PROBE_TIMEOUT_S = 20.0
_PROBE_MAX_TOKENS = 8


def seed_models(settings) -> list[str]:
    """What the worker knows before the first request names the candidates."""
    from app.routing import RouterConfig  # noqa: PLC0415

    cfg = RouterConfig.from_settings(True, settings.ai_router_profiles)
    seeds = [*cfg.profiles, settings.ai_default_model, settings.ai_quota_fallback_model]
    return [m for m in dict.fromkeys(seeds) if m]


def _retry_after(value: str | None) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
        return None


async def refresh_upstreams(client: httpx.AsyncClient, settings) -> int:
    r = await client.get(
        f"{settings.ollima_base_url.rstrip('/')}/models",
        headers={"Authorization": f"Bearer {settings.ollima_api_key}"},
    )
    r.raise_for_status()
    body = r.json()
    items = body.get("data", body) if isinstance(body, dict) else body
    mapping = {
        str(i.get("id")): str(i.get("owned_by"))
        for i in items
        if isinstance(i, dict) and i.get("id") and i.get("owned_by")
    }
    health.set_upstreams(mapping)
    return len(mapping)


async def probe(client: httpx.AsyncClient, settings, model: str) -> str:
    """One real, minimal request. Returns the outcome label (for logs/tests)."""
    try:
        r = await client.post(
            f"{settings.ollima_base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {settings.ollima_api_key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": _PROBE_MAX_TOKENS,
            },
            timeout=_PROBE_TIMEOUT_S,
        )
    except httpx.TimeoutException as e:
        health.record_failure(
            model, health.TIMEOUT, f"probe {type(e).__name__}", source="probe"
        )
        return health.TIMEOUT
    except httpx.TransportError as e:
        health.record_failure(
            model, health.UNREACHABLE, f"probe {type(e).__name__}", source="probe"
        )
        return health.UNREACHABLE
    if r.status_code == 200:
        health.record_success(model, source="probe")
        return health.HEALTHY
    kind = health.classify_status(r.status_code, r.text)
    if kind is None:
        health.record_probe_inconclusive(model, f"HTTP {r.status_code}")
        return "inconclusive"
    health.record_failure(
        model,
        kind,
        f"probe HTTP {r.status_code}: {r.text[:120]}",
        retry_after=_retry_after(r.headers.get("retry-after")),
        source="probe",
    )
    return kind


async def tick(
    client: httpx.AsyncClient, settings, state: dict
) -> list[tuple[str, str]]:
    loop_now = asyncio.get_running_loop().time()
    if loop_now >= state.get("upstreams_due", 0.0):
        try:
            n = await refresh_upstreams(client, settings)
            log.info("model_health.upstreams", extra={"models": n})
            state["upstreams_due"] = loop_now + settings.ai_model_health_revalidate_s
        except Exception as e:  # noqa: BLE001 — unknown upstreams degrade, never fail
            log.warning(
                "model_health.upstreams_failed", extra={"error": type(e).__name__}
            )
            state["upstreams_due"] = (
                loop_now + settings.ai_model_health_probe_interval_s
            )
    results = []
    for model in health.due_for_probe(
        limit=_MAX_PROBES_PER_TICK, revalidate_s=settings.ai_model_health_revalidate_s
    ):
        outcome = await probe(client, settings, model)
        log.info("model_health.probe", extra={"model": model, "outcome": outcome})
        results.append((model, outcome))
    return results


async def run_health_probe(
    settings, *, client: httpx.AsyncClient | None = None
) -> None:
    """The worker loop. Cancelled by the lifespan on shutdown."""
    health.configure(settings)
    health.observe(seed_models(settings))
    interval = max(5.0, float(settings.ai_model_health_probe_interval_s))
    own = client is None
    client = client or httpx.AsyncClient(
        timeout=httpx.Timeout(_PROBE_TIMEOUT_S, connect=min(10.0, _PROBE_TIMEOUT_S)),
        limits=httpx.Limits(max_connections=2, max_keepalive_connections=1),
    )
    state: dict = {}
    log.info("model_health.worker_started", extra={"interval_s": interval})
    try:
        while True:
            await asyncio.sleep(interval * random.uniform(0.9, 1.1))  # noqa: S311
            try:
                await tick(client, settings, state)
                health.mark_worker_tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — a broken tick must never stop the loop
                log.warning(
                    "model_health.tick_failed", extra={"error": type(e).__name__}
                )
    finally:
        if own:
            await client.aclose()
