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
import glob
import json
import os
import shlex
import shutil
import signal
import struct
import subprocess  # noqa: S404 — fixed argv, no shell
import sys
import threading
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
        # private network namespace (no SSRF/exfil); -m gives a private MOUNT
        # namespace so the wrapper can mask secret files without affecting the host.
        return ["unshare", "-rnm", "--"]
    return []


_MASK_WALK_SKIP = frozenset({"node_modules", ".git", ".venv", "__pycache__"})


def _secret_masks() -> list[str]:
    """Absolute paths of on-disk secrets to make unreadable inside the sandbox.

    The env is already stripped, but `unshare -r` maps the caller to root inside
    the userns, so a decoder RCE still reads root-owned 0600 files like the AI
    `.env` (OPENROUTER_API_KEY, AI_INGRESS_SECRET, KNOWLEDGE_DATABASE_URL) and the
    Convex admin key — and could smuggle them out through the decoder's OWN output
    (the returned image/text is fed to the model). The network cut does not close
    that. Each of these is bind-masked with /dev/null inside the mount namespace.
    """
    cwd = os.getcwd()
    root = os.path.abspath(os.path.join(cwd, "..", ".."))
    candidates: list[str] = []
    # Every .env* under the AI service dir and the whole repo's env files.
    candidates += glob.glob(os.path.join(cwd, ".env*"))
    # A walk that skips dependency/VCS trees instead of `glob("**")`, which
    # descended node_modules on EVERY sandboxed decode: 0.56-0.65 s per image or
    # PDF on prod, now ~11 ms. Measured on the VM to mask the IDENTICAL set of
    # real files (34): the only env paths under node_modules are bun's workspace
    # symlinks (node_modules/@v1/app/.env -> apps/app/.env), whose real file is
    # found at its own path. `.next` is deliberately NOT skipped — a standalone
    # build can hold real copies of .env files.
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in _MASK_WALK_SKIP]
        candidates += [os.path.join(d, f) for f in files if f in (".env", ".env.local")]
    # Convex admin key + cloud key live outside the repo too.
    candidates += ["/root/.cvx-cloud-key", "/root/cloud-logs.sh"]
    # REAL paths, de-duped: a bind mount over the real file masks every path
    # (symlinks included) that resolves to it.
    return sorted({os.path.realpath(x) for x in candidates if os.path.isfile(x)})


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
    ushare = _unshare_prefix()
    limit = _prlimit_prefix()
    # With a mount namespace (unshare -m present), mask the secret files with
    # /dev/null before exec, inside a tiny /bin/sh. `exec "$@"` runs the real
    # command from POSITIONAL args, so the op/params JSON never goes through the
    # shell as text (no quoting/injection surface).
    if ushare and "-rnm" in ushare:
        masks = _secret_masks()
        script = "".join(
            f'mount --bind /dev/null {shlex.quote(m)} 2>/dev/null || true; '
            for m in masks
        )
        script += 'exec "$@"'
        return [*ushare, "/bin/sh", "-c", script, "sandbox", *limit, *inner]
    return [*ushare, *limit, *inner]


class _ChildHandle:
    """Lets the awaiting coroutine kill a child the worker THREAD started.

    `asyncio.to_thread` cannot be interrupted: cancelling the awaiting task used
    to leave the child running (up to its full timeout) while the caller's
    concurrency slot was already released — work outliving the budget that was
    meant to bound it (audit F-04). The kill may arrive before the child exists,
    so it is remembered and applied the moment it is attached.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._killed = False

    def attach(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._proc = proc
            if self._killed:
                _kill_group(proc)

    def kill(self) -> None:
        with self._lock:
            self._killed = True
            if self._proc is not None:
                _kill_group(self._proc)


def _run_child(
    op: str,
    payload: bytes,
    params: dict,
    timeout_s: float,
    handle: _ChildHandle | None = None,
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
    if handle is not None:
        handle.attach(proc)
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
    handle = _ChildHandle()
    work = asyncio.ensure_future(
        asyncio.to_thread(_run_child, op, payload, params, timeout_s, handle)
    )
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        # The caller gave up (turn stopped, file deleted). Kill the child NOW
        # and wait for the thread to reap it, so whatever slot the caller holds
        # is released only after the process is actually gone (audit F-04).
        handle.kill()
        try:
            await work
        except BaseException:  # noqa: BLE001,S110 — the kill is the expected outcome
            pass
        raise
    except (TimeoutError, RuntimeError):
        raise
    except Exception as e:  # noqa: BLE001 — transport (spawn) failure, not a decode
        # FAIL CLOSED (audit C-03). An earlier version ran the parser in-process
        # when the sandbox could not be spawned — which is precisely the moment
        # an attacker-shaped payload gets the unsandboxed parser it wanted. The
        # attachment is refused with a retryable error instead; the dev box
        # (tier 4) still has its explicit in-process path above.
        log.warning(
            "sandbox.transport_failed", extra={"op": op, "err": type(e).__name__}
        )
        raise RuntimeError(
            "the attachment sandbox is unavailable; try again shortly"
        ) from e
