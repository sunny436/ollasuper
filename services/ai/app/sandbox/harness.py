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
import functools
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
import time
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
    # A decoder needs no thread pool; one thread each keeps a child far inside
    # its process cap (threads count against RLIMIT_NPROC).
    for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        env[k] = "1"
    return env


DEFAULT_CPU_S = 20
# The child's whole stdout is buffered by THIS service, and RLIMIT_FSIZE does
# not apply to a pipe — so without this cap a decoder could hand the plane an
# unbounded result. Past it the child's process group is killed.
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
# Total scratch disk inside the mount namespace (a tmpfs over /tmp). --fsize
# caps ONE file; this caps them all, and nr_inodes caps how MANY.
TMP_SIZE = "64m"
TMP_INODES = 4096
# Processes AND threads the child may have at once. Counted per user namespace
# (measured on the VM, kernel 6.8: a cap of 16 stopped the 15th fork), so the
# service's own threads do not count against it. A fork bomb stops here; the
# process-group kill and the PID namespace clean up whatever it started.
MAX_PROCS = 64
# The least isolation this process may run untrusted decoders at. Production
# sets AI_SANDBOX_MIN_TIER=1 (the service .env); anything weaker then REFUSES
# the decode instead of running it less isolated. The dev box keeps 4.
_MIN_TIER = int(os.environ.get("AI_SANDBOX_MIN_TIER", "4") or "4")
_READ_CHUNK = 1 << 16


class SandboxOutputExceeded(RuntimeError):
    """The child produced more than MAX_OUTPUT_BYTES and was killed."""


DEFAULT_MEM_BYTES = 1_500_000_000


def _prlimit_prefix(
    cpu_s: int = DEFAULT_CPU_S, mem_bytes: int = DEFAULT_MEM_BYTES
) -> list[str]:
    if shutil.which("prlimit"):
        # address space (default 1.5GB), CPU seconds, 256 fds, 64MB max output
        # file, and the process cap.
        return [
            "prlimit",
            f"--as={int(mem_bytes)}",
            f"--cpu={max(1, int(cpu_s))}",
            "--nofile=256",
            "--fsize=67108864",
            f"--nproc={MAX_PROCS}",
            "--",
        ]
    return []


def _probe(argv: list[str]) -> bool:
    try:
        done = subprocess.run(  # noqa: S603 — fixed argv, no shell
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


@functools.cache
def _pid_namespace_mode() -> str:
    """The PID namespace this host lets an unprivileged user create, probed once:

      "private" - `--mount-proc`: the child sees only its own processes;
      "shared"  - a PID namespace WITHOUT a fresh /proc (the child still sees
                  the service's /proc) - kept for the kill guarantee;
      ""        - none.

    "shared" exists because of production: under systemd's
    ProtectKernelTunables the kernel refuses a new /proc inside a user
    namespace (it would reveal what the unit over-mounted), so --mount-proc
    fails there while the namespace itself works - and the namespace is what
    kills a decoder's setsid() grandchild when the decode is killed. Probed,
    never assumed: an assumed capability that is missing turns every decode
    into a failure (the harness fails CLOSED).
    """
    if _probe(["unshare", "-rnmpf", "--mount-proc", "true"]):  # noqa: S607
        return "private"
    if _probe(["unshare", "-rnmpf", "true"]):  # noqa: S607
        return "shared"
    return ""


# The exit code of a sandbox whose SETUP failed (seal, private /tmp, a secret
# mask) - never a decoder's. The setup prints `sandbox-setup: <step>` first.
SETUP_FAILED_RC = 97
_SETUP_TAG = b"sandbox-setup:"
# Makes the sandbox's whole filesystem read-only in one mount_setattr(2) call
# (see seal.py for why one call, not a remount per mount). Run by the SAME
# interpreter, isolated from site-packages and the environment.
_SEAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seal.py")


def _seal_argv() -> list[str]:
    return [sys.executable, "-I", "-S", _SEAL]


@functools.cache
def _ro_fs_works() -> bool:
    """Whether the sandbox's filesystem can be sealed read-only (probed once,
    with the very command the sandbox runs): with it, a decoder RCE cannot
    write ANYWHERE on the host filesystem the service user can - only to its
    private, capped /tmp and the pool's /dev/shm. Stable for the process's
    life: the seal does not depend on the mount table, which changes."""
    return _probe(["unshare", "-rnm", "--", *_seal_argv()])  # noqa: S607


@functools.cache
def _proc_isolated() -> bool:
    """Whether a sandboxed decoder is blind to every OTHER user's process.

    Not a detail: the self-hosted Convex backend runs as root with its instance
    secret (from which the admin key is derived) and its Postgres password on
    its command line, and /proc/<pid>/cmdline is world-readable. With a private
    /proc the child sees only itself; otherwise only the service unit's own
    `ProtectProc=invisible` (hidepid) hides them. Counted, from this process's
    view of /proc - which is the child's view whenever it gets no /proc of its
    own.
    """
    if _pid_namespace_mode() == "private":
        return True
    me = os.getuid()
    try:
        pids = [e for e in os.listdir("/proc") if e.isdigit()]
    except OSError:
        return False
    for pid in pids:
        try:
            if os.stat(f"/proc/{pid}").st_uid != me:
                return False
        except OSError:
            continue  # exited between listdir and stat
    return True


def _unshare_prefix() -> list[str]:
    if shutil.which("unshare"):
        # -r maps caller->root in a userns (works without privileges); -n gives a
        # private network namespace (no SSRF/exfil); -m gives a private MOUNT
        # namespace so the wrapper can mask secret files without affecting the host.
        # -p/-f add a PID namespace: when its init dies the kernel kills
        # everything it forked — even a process that left the group with
        # setsid(). --mount-proc also hides every host process (where allowed).
        mode = _pid_namespace_mode()
        if mode == "private":
            return ["unshare", "-rnmpf", "--mount-proc", "--"]
        if mode == "shared":
            return ["unshare", "-rnmpf", "--"]
        return ["unshare", "-rnm", "--"]
    return []


def _has_mount_namespace(prefix: list[str]) -> bool:
    return len(prefix) > 1 and prefix[1].startswith("-rnm")


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
    # Other deployments on the same host (a staging copy under /opt/<name>):
    # the SAME service user can read their secrets, so a decoder here must not.
    for pattern in (
        "/opt/*/services/ai/.env*",
        "/opt/*/apps/app/.env*",
        "/opt/*/packages/backend/.env*",
    ):
        candidates += glob.glob(pattern)
    # Convex admin key + cloud key live outside the repo too.
    candidates += ["/root/.cvx-cloud-key", "/root/cloud-logs.sh"]
    # REAL paths, de-duped: a bind mount over the real file masks every path
    # (symlinks included) that resolves to it.
    return sorted({os.path.realpath(x) for x in candidates if os.path.isfile(x)})


def _tier() -> tuple[int, str]:
    posix = os.name == "posix" and hasattr(os, "fork")
    if not posix:
        return 4, "in-process (no posix fork/exec — dev only)"
    ushare = _unshare_prefix()
    has_prlimit = bool(_prlimit_prefix())
    if ushare and has_prlimit:
        pid = {
            "private": " + pid namespace",
            "shared": " + pid namespace (service /proc)",
        }.get(_pid_namespace_mode(), " (no pid namespace)")
        ro = " + read-only filesystem" if _ro_fs_works() else " (filesystem writable)"
        procs = (
            " + other users' processes hidden"
            if _proc_isolated()
            else " (other users' processes visible)"
        )
        return 1, (
            "unshare -rnm + prlimit(nproc) + tmpfs /tmp + stripped-env subprocess"
            f"{pid}{ro}{procs}"
        )
    if has_prlimit:
        return 2, "prlimit + stripped-env subprocess (no network namespace)"
    return 3, "stripped-env subprocess (no prlimit, no network namespace)"


_TIER, _TIER_DESC = _tier()
log.info("sandbox.mode", extra={"tier": _TIER, "detail": _TIER_DESC})


def sandbox_status() -> dict:
    """For the health endpoint / tests: the achievable tier, whether the child
    is guaranteed secret-free (tiers 1-3) vs an in-process dev fallback (4), and
    whether it meets this deployment's required minimum (AI_SANDBOX_MIN_TIER)."""
    posix = _TIER == 1
    return {
        "tier": _TIER,
        "detail": _TIER_DESC,
        "secret_free": _TIER <= 3,
        "min_tier": _MIN_TIER,
        "meets_minimum": _TIER <= _MIN_TIER,
        # Each layer on its own, so the host monitor can alert on the one that
        # regressed instead of parsing the detail string.
        "pid_namespace": _pid_namespace_mode() if posix else "",
        "readonly_fs": _ro_fs_works() if posix else False,
        "proc_isolated": _proc_isolated() if posix else False,
    }


def _assert_minimum() -> None:
    """Refuse - never downgrade - when this host cannot give the isolation the
    deployment requires (a missing unshare, a profile that stopped allowing
    namespaces). Surfaces as a retryable 'unavailable' failure."""
    if _TIER > _MIN_TIER:
        log.warning(
            "LIB_SANDBOX_BELOW_MINIMUM", extra={"tier": _TIER, "min": _MIN_TIER}
        )
        raise RuntimeError("the sandbox is below the required isolation")


def setup_step(out: bytes) -> str:
    """The step a failed setup named on stdout. Only a line carrying the
    setup's own tag counts: a decoder can also exit 97, and its stdout is
    attacker-shaped, so anything else is reported as unrecognised."""
    head = bytes(out[:200]).split(b"\n", 1)[0]
    if not head.startswith(_SETUP_TAG):
        return "(unrecognised)"
    return head[len(_SETUP_TAG) :].decode("utf-8", "replace").strip()


def _setup_failed(step: str) -> str:
    """Shell that reports a failed setup step on stdout and fails CLOSED."""
    msg = shlex.quote(f"sandbox-setup: {step}")
    return f"{{ printf '%s\\n' {msg}; exit {SETUP_FAILED_RC}; }}"


def mount_script() -> str:
    """The shell run INSIDE the mount namespace before the real command: the
    whole filesystem sealed read-only (where the host allows it), a size- and
    inode-capped private /tmp, and /dev/null over every secret file. Each step
    FAILS CLOSED and names itself - a decoder never runs with a seal, a cap or a
    mask that did not take, and the log says which one."""
    script = ""
    if _ro_fs_works():
        seal = " ".join(shlex.quote(a) for a in _seal_argv())
        script += f"{seal} || exit {SETUP_FAILED_RC}; "
    script += (
        f"mount -t tmpfs -o size={TMP_SIZE},nr_inodes={TMP_INODES},mode=1777 "
        f"tmpfs /tmp || {_setup_failed('tmp')}; "
    )
    script += "".join(
        f"mount --bind /dev/null {shlex.quote(m)} || {_setup_failed('mask ' + m)}; "
        for m in _secret_masks()
    )
    return script + 'exec "$@"'


def isolation_prefix(limits: list[str]) -> list[str]:
    """argv that runs a command in the sandbox: the namespaces, the mount script,
    then `limits` (a prlimit prefix). Empty on a host with no mount namespace."""
    ushare = _unshare_prefix()
    if not _has_mount_namespace(ushare):
        return [*ushare, *limits]
    return [*ushare, "/bin/sh", "-c", mount_script(), "sandbox", *limits]


def _argv(
    op: str,
    params: dict,
    cpu_s: int = DEFAULT_CPU_S,
    mem_bytes: int = DEFAULT_MEM_BYTES,
) -> list[str]:
    inner = [sys.executable, "-m", "app.sandbox.worker", op, json.dumps(params)]
    # `exec "$@"` in the mount script runs the real command from POSITIONAL
    # args, so the op/params JSON never goes through the shell as text (no
    # quoting/injection surface).
    return [*isolation_prefix(_prlimit_prefix(cpu_s, mem_bytes)), *inner]


def _child_env() -> dict[str, str]:
    env = safe_child_env()
    if _has_mount_namespace(_unshare_prefix()):
        # Point scratch at the capped tmpfs, whatever TMPDIR the service had.
        env["TMPDIR"] = env["HOME"] = "/tmp"  # noqa: S108 — the private tmpfs
    return env


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


def collect_bounded(
    proc: subprocess.Popen, payload: bytes, timeout_s: float, cap: int
) -> bytes:
    """Feed stdin and read stdout under a HARD byte cap and a wall-clock kill.

    Replaces `communicate()`, which buffers everything the child writes: a
    decoder (or an RCE inside one) could hand this service gigabytes. Stdin is
    fed from its own thread so a child that stops reading cannot deadlock the
    reader, and the timeout is a timer that kills the process GROUP, which ends
    the read with EOF.
    """
    timed_out = threading.Event()

    def feed() -> None:
        try:
            if proc.stdin is not None:
                proc.stdin.write(payload)
        except OSError:
            pass
        finally:
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except OSError:
                pass

    def expire() -> None:
        timed_out.set()
        _kill_group(proc)

    feeder = threading.Thread(target=feed, daemon=True)
    timer = threading.Timer(timeout_s, expire)
    feeder.start()
    timer.start()
    out = bytearray()
    try:
        stdout = proc.stdout
        while stdout is not None:
            chunk = stdout.read1(_READ_CHUNK)
            if not chunk:
                break
            out += chunk
            if len(out) > cap:
                _kill_group(proc)
                proc.wait()
                raise SandboxOutputExceeded(f"sandbox output exceeded {cap} bytes")
        proc.wait()
    finally:
        timer.cancel()
        feeder.join(timeout=1.0)
    if timed_out.is_set():
        raise TimeoutError(f"sandbox exceeded {timeout_s}s")
    return bytes(out)


def _run_child(
    op: str,
    payload: bytes,
    params: dict,
    timeout_s: float,
    handle: _ChildHandle | None = None,
    cpu_s: int = DEFAULT_CPU_S,
    mem_bytes: int = DEFAULT_MEM_BYTES,
    max_output: int = MAX_OUTPUT_BYTES,
) -> tuple[dict, bytes]:
    _assert_minimum()
    proc = subprocess.Popen(  # noqa: S603 — fixed argv, no shell, cwd is our own pkg root
        _argv(op, params, cpu_s, mem_bytes),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=_child_env(),
        cwd=os.getcwd(),
        start_new_session=True,  # own process group, so a timeout reaps forks too
    )
    if handle is not None:
        handle.attach(proc)
    try:
        out = collect_bounded(proc, payload, timeout_s, max_output)
    except TimeoutError:
        log.warning("LIB_SANDBOX_KILL", extra={"op": op, "why": "timeout"})
        raise TimeoutError(f"sandbox op {op!r} exceeded {timeout_s}s") from None
    except SandboxOutputExceeded:
        log.warning("LIB_SANDBOX_KILL", extra={"op": op, "why": "output"})
        raise

    if proc.returncode == SETUP_FAILED_RC:
        log.warning(
            "LIB_SANDBOX_SETUP_FAILED", extra={"op": op, "step": setup_step(out)}
        )
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


# How long a live result stands. /readyz is polled (the host monitor, every
# 5 min; deploy scripts); one real sandbox start per 30 s is the most it costs.
LIVE_TTL_S = 30.0
_LIVE_TIMEOUT_S = 15.0
_live_lock = threading.Lock()
_live: tuple[float, dict] | None = None


def _start_live() -> dict:
    t0 = time.monotonic()
    try:
        proc = subprocess.Popen(  # noqa: S603 — fixed argv, no shell
            [*isolation_prefix(_prlimit_prefix(5, 256 << 20)), "/bin/true"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=_child_env(),
            cwd=os.getcwd(),
            start_new_session=True,
        )
    except OSError as e:
        return {"ok": False, "rc": None, "step": f"spawn: {type(e).__name__}"}
    try:
        out, _ = proc.communicate(timeout=_LIVE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        proc.communicate()
        return {"ok": False, "rc": None, "step": "timeout"}
    ms = round((time.monotonic() - t0) * 1000)
    if proc.returncode == 0:
        return {"ok": True, "rc": 0, "ms": ms}
    step = setup_step(out) if proc.returncode == SETUP_FAILED_RC else "exit"
    return {"ok": False, "rc": proc.returncode, "step": step, "ms": ms}


def live_check() -> dict:
    """Start a REAL sandbox - the same namespaces, seal, private /tmp, secret
    masks and limits every decoder gets - and run /bin/true in it.

    The import-time probes say what this host CAN do; this says what it DOES
    right now. They differ exactly when something changes under a running
    service, which is how production lost every decode on 29-09-2026 while
    /readyz, reading only the probes, stayed green. Cached LIVE_TTL_S.
    """
    global _live
    with _live_lock:
        if _live is not None and time.monotonic() - _live[0] < LIVE_TTL_S:
            return _live[1]
    result = {"ok": True, "rc": 0, "in_process": True} if _TIER == 4 else _start_live()
    if not result["ok"]:
        log.warning("LIB_SANDBOX_LIVE_FAILED", extra=result)
    with _live_lock:
        _live = (time.monotonic(), result)
    return result


async def run_sandboxed(
    op: str,
    payload: bytes,
    params: dict,
    *,
    timeout_s: float,
    fallback: Callable[[], Awaitable[tuple[dict, bytes]]],
    cpu_s: int = DEFAULT_CPU_S,
    mem_bytes: int = DEFAULT_MEM_BYTES,
    max_output: int = MAX_OUTPUT_BYTES,
) -> tuple[dict, bytes]:
    """Decode `payload` in a sandboxed child and return (meta, body).

    On a platform that cannot fork/exec (tier 4) the `fallback` runs in-process —
    used ONLY by the dev box; production is tier 1. A transport failure (the
    sandbox could not be spawned) FAILS CLOSED — see the handler below.
    """
    if _TIER == 4:
        # The in-process path exists for the dev box only; a deployment that
        # requires isolation refuses it.
        _assert_minimum()
        return await fallback()
    handle = _ChildHandle()
    work = asyncio.ensure_future(
        asyncio.to_thread(
            _run_child,
            op,
            payload,
            params,
            timeout_s,
            handle,
            cpu_s,
            mem_bytes,
            max_output,
        )
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


def isolated() -> bool:
    """True where decoders run in a separate secret-free process (tiers 1-3)."""
    return _TIER <= 3


def run_sandboxed_sync(
    op: str, payload: bytes, params: dict, *, timeout_s: float, cpu_s: int
) -> tuple[dict, bytes]:
    """`run_sandboxed` for a caller that is already on a worker thread.

    Same fail-closed contract; the caller checks `isolated()` first and keeps
    its own in-process path for the dev box.
    """
    try:
        return _run_child(op, payload, params, timeout_s, None, cpu_s)
    except (TimeoutError, RuntimeError):
        raise
    except Exception as e:  # noqa: BLE001 — transport (spawn) failure
        log.warning(
            "sandbox.transport_failed", extra={"op": op, "err": type(e).__name__}
        )
        raise RuntimeError("the document sandbox is unavailable") from e
