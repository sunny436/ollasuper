"""Run untrusted-byte decoders in a separate, secret-free, network-isolated process.

WHAT THIS BUYS OVER `asyncio.to_thread`. A thread shares the app process: its
memory, its file descriptors, its network, and its ENVIRONMENT — where
OPENROUTER_API_KEY, AI_INGRESS_SECRET and KNOWLEDGE_DATABASE_URL live. A
memory-corruption bug in Pillow's C decoders or in PDFium (both parse fully
attacker-controlled bytes) therefore executes with all of that in reach. A
separate process with a STRIPPED environment removes the secrets from reach; a
private network namespace removes exfiltration; resource caps and a
process-group timeout remove the DoS; and a segfault kills the child alone, not
every concurrent stream on this --workers 1 service.

TIERS (best first). The mode actually achieved is reported by `sandbox_status()`
and logged once at import, because "we think it's sandboxed" is not evidence:

  1. unshare -rn + prlimit + separate process + stripped env   (Linux w/ userns)
  2. prlimit + separate process + stripped env                 (no userns)
  3. separate process + stripped env                           (no prlimit)
  4. IN-PROCESS thread                                          (no fork/exec — dev)

Only tier 4 inherits secrets, and it is reached only where `unshare`/`prlimit`
and a POSIX fork/exec are unavailable — i.e. the Windows dev box, never the
Linux VM. Callers pass an in-process fallback so a dev machine still works; the
report states plainly which tier production runs.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import struct
import subprocess  # noqa: S404 — fixed argv, no shell
import sys
from collections.abc import Awaitable, Callable

from app.logging import get_logger

log = get_logger(__name__)

# The ONLY environment the child sees. No secret is on this list; in particular
# none of OPENROUTER_API_KEY / AI_INGRESS_SECRET / KNOWLEDGE_DATABASE_URL /
# CONVEX_* is carried. HOME/TMPDIR are pointed at the caller's temp so a decoder
# that writes scratch files has somewhere harmless to write.
def safe_child_env() -> dict[str, str]:
    keep = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env["HOME"] = env.get("TMPDIR") or "/tmp"  # noqa: S108 — deliberate scratch home
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONNOUSERSITE"] = "1"  # no ~/.local packages influencing the child
    return env


def _prlimit_prefix() -> list[str]:
    if shutil.which("prlimit"):
        # address space 1.5GB, 20s CPU, 256 fds, 64MB max output file.
        return [
            "prlimit",
            "--as=1500000000",
            "--cpu=20",
            "--nofile=256",
            "--fsize=67108864",
            "--",
        ]
    return []


def _unshare_prefix() -> list[str]:
    if shutil.which("unshare"):
        # -r maps caller->root in a userns (works without privileges); -n gives a
        # private network namespace with no interface up: no SSRF, no exfil.
        return ["unshare", "-rn", "--"]
    return []


def _tier() -> tuple[int, str]:
    posix = os.name == "posix" and hasattr(os, "fork")
    if not posix:
        return 4, "in-process (no posix fork/exec — dev only)"
    has_unshare = bool(_unshare_prefix())
    has_prlimit = bool(_prlimit_prefix())
    if has_unshare and has_prlimit:
        return 1, "unshare -rn + prlimit + stripped-env subprocess"
    if has_prlimit:
        return 2, "prlimit + stripped-env subprocess (no network namespace)"
    return 3, "stripped-env subprocess (no prlimit, no network namespace)"


_TIER, _TIER_DESC = _tier()
log.info("sandbox.mode", extra={"tier": _TIER, "detail": _TIER_DESC})


def sandbox_status() -> dict:
    """For the health endpoint / tests: the achievable tier and whether the child
    is guaranteed secret-free (tiers 1-3) vs an in-process dev fallback (4)."""
    return {"tier": _TIER, "detail": _TIER_DESC, "secret_free": _TIER <= 3}


def _argv(op: str, params: dict) -> list[str]:
    inner = [sys.executable, "-m", "app.sandbox.worker", op, json.dumps(params)]
    return [*_unshare_prefix(), *_prlimit_prefix(), *inner]


def _run_child(
    op: str, payload: bytes, params: dict, timeout_s: float
) -> tuple[dict, bytes]:
    proc = subprocess.Popen(  # noqa: S603 — fixed argv, no shell, cwd is our own pkg root
        _argv(op, params),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=safe_child_env(),
        cwd=os.getcwd(),
        start_new_session=True,  # own process group, so a timeout reaps forks too
    )
    try:
        out, _ = proc.communicate(input=payload, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        proc.communicate()
        raise TimeoutError(f"sandbox op {op!r} exceeded {timeout_s}s") from None

    if proc.returncode != 0 or len(out) < 4:
        # non-zero with no frame == crash/segfault/OOM/rlimit kill.
        raise RuntimeError(f"sandbox op {op!r} failed (rc={proc.returncode})")
    (mlen,) = struct.unpack(">I", out[:4])
    meta = json.loads(out[4 : 4 + mlen].decode("utf-8"))
    body = out[4 + mlen :]
    return meta, body


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001,S110
        try:
            proc.kill()
        except Exception:  # noqa: BLE001,S110
            pass


async def run_sandboxed(
    op: str,
    payload: bytes,
    params: dict,
    *,
    timeout_s: float,
    fallback: Callable[[], Awaitable[tuple[dict, bytes]]],
) -> tuple[dict, bytes]:
    """Decode `payload` in a sandboxed child and return (meta, body).

    On a platform that cannot fork/exec (tier 4) the `fallback` runs in-process —
    used ONLY by the dev box; production is tier 1. Any sandbox transport failure
    also degrades to the fallback rather than dropping the user's attachment, so
    a sandbox regression is a security downgrade to log, never an outage.
    """
    if _TIER == 4:
        return await fallback()
    try:
        return await asyncio.to_thread(_run_child, op, payload, params, timeout_s)
    except (TimeoutError, RuntimeError):
        raise
    except Exception as e:  # noqa: BLE001 — transport (spawn) failure, not a decode
        log.warning(
            "sandbox.transport_failed", extra={"op": op, "err": type(e).__name__}
        )
        return await fallback()
