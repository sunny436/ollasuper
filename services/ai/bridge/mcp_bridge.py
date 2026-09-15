"""One local MCP server: spawn it hardened, PROVE it, serve it on loopback.

    python -m bridge.mcp_bridge <slug> --port 8811

WHAT THIS PROCESS IS. The launcher-and-gateway the audit asked for (H-12,
N-06), replacing `docker mcp gateway run`, which is not installed on the host
and could not be inspected. Per local server, one instance:

  1. reads the row from Postgres and runs `policy.validate_local_server`;
  2. builds `docker run …` from `app.mcp.local.launch.docker_argv` — every
     hardening flag explicit, the image pinned by digest;
  3. spawns the container over STDIO with the MCP SDK's stdio client and
     completes the MCP handshake;
  4. runs `docker inspect` on the container and hands the JSON to
     `app.mcp.local.attest.check`. ANY mismatch: `docker rm -f`, attestation
     `verified: false`, exit 1 — the systemd unit fails, visibly;
  5. writes the attestation (`/run/myos/mcp-local/<slug>.json`, root-owned),
     which the AI plane REQUIRES before it will dial this server;
  6. serves the server over streamable HTTP on 127.0.0.1:<port>/mcp, forwarding
     tools/resources/prompts verbatim, behind a BEARER TOKEN
     (`MCP_GATEWAY_AUTH_TOKEN`, constant-time compare) — the token that was
     configured before and never sent by anyone.

WHAT IT IS NOT. Not part of the AI plane (`app/mcp` can spawn nothing), not a
general gateway (one server per instance, one slug per port, so the plane's
identity model needs no parsing), and not a policy engine (that is `policy.py`,
pure and tested; this only applies its verdict).
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
import signal
import subprocess  # noqa: S404 -- this process's whole job is to spawn one container
import sys
import time
from collections.abc import Awaitable, Callable
from typing import Any

from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.config import get_settings
from app.db.engine import create_knowledge_engine
from app.logging import configure, get_logger
from app.mcp.local import attest
from app.mcp.local.launch import container_name, docker_argv, expected
from app.mcp.local.policy import PolicyCeilings, validate_local_server
from app.mcp.registry import local_store

log = get_logger("bridge")

ENV_DIR = "/etc/myos/mcp-local"


class BearerGate(BaseHTTPMiddleware):
    """Every request carries the gateway token or gets 401. Constant-time."""

    def __init__(self, app: Any, token: str) -> None:
        super().__init__(app)
        self._token = token.encode()

    async def dispatch(self, request: Any, call_next: Any) -> Any:
        header = request.headers.get("authorization", "")
        presented = header[7:].encode() if header.startswith("Bearer ") else b""
        if not presented or not hmac.compare_digest(presented, self._token):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)


DOCKER = "/usr/bin/docker"


def _inspect(name: str) -> dict[str, Any]:
    out = subprocess.run(  # noqa: S603 -- fixed argv, absolute binary, no shell
        [DOCKER, "inspect", name], capture_output=True, text=True, check=True
    )
    data = json.loads(out.stdout)
    if not isinstance(data, list) or not data:
        raise RuntimeError("docker inspect returned nothing")
    return data[0]


def _remove(name: str) -> None:
    subprocess.run(  # noqa: S603 -- fixed argv, absolute binary, no shell
        [DOCKER, "rm", "-f", name], capture_output=True, check=False
    )


def _ensure_env_file(slug: str) -> str:
    """The row's env file. An empty allowlist still needs a file: `--env-file`
    is how NOTHING else from this process's environment reaches the container."""
    path = os.path.join(ENV_DIR, f"{slug}.env")
    if not os.path.exists(path):
        with open(path, "a", encoding="utf-8"):
            pass
        os.chmod(path, 0o600)
    return path


def _arm_stop_signals() -> None:
    """`systemctl stop` MUST reach `run`'s finally. uvicorn captures SIGTERM for
    its graceful shutdown, then RESTORES the previous handler and re-raises the
    signal (`Server.capture_signals`, uvicorn 0.52). With Python's default
    handler that terminates the process on the spot — measured on the host: a
    stopped unit left `verified: true` on disk, which the plane would honour
    for MAX_AGE_S. Raising SystemExit instead unwinds through every finally,
    whether the signal lands before serve (container starting) or after it."""

    def _stop(_sig: int, _frame: Any) -> None:
        raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _stop)


async def _attested_run(
    body: Callable[[], Awaitable[int]],
    *,
    slug: str,
    exp: Any,
    name: str,
    started: float,
) -> int:
    """Run `body`; however it ends — return, error, or the stop signal — the
    container is removed and the attestation says `stopped`, so the plane never
    dials a server whose bridge is gone."""
    try:
        return await body()
    except BaseExceptionGroup as group:
        # The stop signal lands inside the MCP client's task group, which
        # wraps it; a group holding NOTHING but SystemExit is still a clean
        # stop (measured: the unit otherwise ends status=1/FAILURE).
        _stops, rest = group.split(SystemExit)
        if rest is not None:
            raise
        raise SystemExit(0) from None
    finally:
        _remove(name)
        try:
            attest.write(
                attest.Attestation(
                    slug=slug,
                    verified=False,
                    image_digest=exp.image_digest,
                    container_id="",
                    started_at=started,
                    failed=("stopped",),
                )
            )
        except OSError:
            pass


async def _wait_for_container(name: str, timeout_s: float = 30.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            info = _inspect(name)
            if (info.get("State") or {}).get("Running"):
                return info
        except (subprocess.CalledProcessError, RuntimeError, ValueError):
            pass
        if time.monotonic() > deadline:
            raise RuntimeError("the container did not start")
        await asyncio.sleep(0.5)


def _proxy_app(client: Any, name: str, token: str, host: str, port: int) -> Any:
    """A streamable-HTTP MCP server whose every handler forwards to `client`."""
    from mcp.server.lowlevel.server import Server
    from mcp.server.transport_security import TransportSecuritySettings

    async def on_list_tools(_ctx: Any, params: Any) -> Any:
        return await client.list_tools()

    async def on_call_tool(_ctx: Any, params: Any) -> Any:
        return await client.call_tool(params.name, params.arguments or {})

    async def on_list_resources(_ctx: Any, params: Any) -> Any:
        return await client.list_resources()

    async def on_list_resource_templates(_ctx: Any, params: Any) -> Any:
        return await client.list_resource_templates()

    async def on_read_resource(_ctx: Any, params: Any) -> Any:
        return await client.read_resource(str(params.uri))

    async def on_list_prompts(_ctx: Any, params: Any) -> Any:
        return await client.list_prompts()

    async def on_get_prompt(_ctx: Any, params: Any) -> Any:
        return await client.get_prompt(params.name, params.arguments or {})

    server = Server(
        name,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
        on_list_resources=on_list_resources,
        on_list_resource_templates=on_list_resource_templates,
        on_read_resource=on_read_resource,
        on_list_prompts=on_list_prompts,
        on_get_prompt=on_get_prompt,
    )
    inner: Starlette = server.streamable_http_app(
        transport_security=TransportSecuritySettings(
            allowed_hosts=[f"{host}:{port}", host, "localhost", f"localhost:{port}"],
            allowed_origins=[f"http://{host}:{port}", f"http://localhost:{port}"],
        )
    )
    inner.add_middleware(BearerGate, token=token)
    return inner


async def run(slug: str, port: int) -> int:
    _arm_stop_signals()
    settings = get_settings()
    configure(settings.ai_log_level, settings.secrets())
    token = settings.mcp_gateway_auth_token
    if not token:
        log.error("bridge.no_token")
        return 2

    engine = create_knowledge_engine(settings)
    try:
        row = await local_store.resolve(engine, slug)
    finally:
        await engine.dispose()
    if row is None:
        log.error("bridge.no_row", extra={"slug": slug})
        return 2
    verdict = validate_local_server(
        row,
        ceilings=PolicyCeilings(
            max_cpus=settings.mcp_local_max_cpus,
            max_memory_mb=settings.mcp_local_max_memory_mb,
        ),
        allow_untrusted=settings.mcp_local_allow_untrusted,
    )
    if not verdict.ok:
        log.error("bridge.refused", extra={"slug": slug, "reasons": verdict.reasons})
        return 2

    env_file = _ensure_env_file(slug)
    argv = [DOCKER, *docker_argv(row, env_file=env_file)[1:]]
    name = container_name(slug)
    exp = expected(row)
    _remove(name)  # a leftover from a previous unit is never reused

    from mcp.client import Client
    from mcp.client.stdio import StdioServerParameters

    params = StdioServerParameters(command=argv[0], args=argv[1:], env={})
    started = time.time()

    async def session() -> int:
        # LEGACY HANDSHAKE, deliberately. The containerised servers in the MCP
        # catalogue are built on older SDKs, and the modern `server/discover`
        # probe does not merely go unanswered by them — measured on mcp/time,
        # it CRASHES the server (an unhandled method in its dispatcher), so the
        # session dies before initialize is ever tried. `initialize` is what
        # every stdio server understands.
        async with Client(server=params, mode="legacy") as client:
            info = await _wait_for_container(name)
            failed = attest.check(info, exp)
            container_id = str(info.get("Id") or "")[:64]
            att = attest.Attestation(
                slug=slug,
                verified=not failed,
                image_digest=exp.image_digest,
                container_id=container_id,
                started_at=started,
                failed=tuple(failed),
            )
            path = attest.write(att)
            if failed:
                # FAIL CLOSED: the container is not what the row describes. It
                # does not get to serve a single request.
                log.error(
                    "bridge.attestation_failed", extra={"slug": slug, "failed": failed}
                )
                return 1
            log.info(
                "bridge.attested",
                extra={"slug": slug, "path": str(path), "container": container_id[:12]},
            )
            import uvicorn

            app = _proxy_app(client, slug, token, "127.0.0.1", port)
            config = uvicorn.Config(
                app, host="127.0.0.1", port=port, log_level="warning"
            )
            await uvicorn.Server(config).serve()
            return 0

    return await _attested_run(session, slug=slug, exp=exp, name=name, started=started)


def main() -> None:
    parser = argparse.ArgumentParser(description="OllaSuper local MCP bridge")
    parser.add_argument("slug")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    sys.exit(asyncio.run(run(args.slug, args.port)))


if __name__ == "__main__":
    main()
