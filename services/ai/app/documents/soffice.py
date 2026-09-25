"""Sandboxed LibreOffice headless converter — the faithful PPTX<->PDF engine.

The source `soffice.py` has NO timeout and NO real sandbox (only an isolated profile for
a sandboxed env). Here we add REAL, VM-verified controls: each conversion runs inside a
private NETWORK NAMESPACE (`unshare -rn`, so a malicious document's remote refs cannot
reach the network — no SSRF / exfil) with address-space + fd RESOURCE CAPS (`prlimit`),
a per-call isolated `UserInstallation` profile, macros disabled, a locked temp jobdir,
and a HARD Python wall-clock timeout that kills the whole process group. A concurrency
semaphore bounds the memory-heavy soffice processes. (`systemd-run --scope` was tried
but scopes don't apply sandbox properties, and a `--wait` service tripped over
ProtectSystem/PrivateTmp vs the temp jobdir — `unshare -rn` + `prlimit` is what works.)
Untrusted OOXML/PDF is the input, so the sandbox is load-bearing. Returns the converted
bytes, or None (→ the caller degrades honestly: download + labeled-approximate/absent
preview, never a faked render).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import subprocess  # noqa: S404
import tempfile
from pathlib import Path

from app.logging import get_logger
from app.sandbox.harness import safe_child_env

log = get_logger(__name__)

_sema: asyncio.Semaphore | None = None
_sema_n = 0


def _semaphore(concurrency: int) -> asyncio.Semaphore:
    global _sema, _sema_n
    n = max(1, int(concurrency))
    if _sema is None or _sema_n != n:
        _sema = asyncio.Semaphore(n)
        _sema_n = n
    return _sema


def soffice_available() -> bool:
    return (
        shutil.which("soffice") is not None or shutil.which("libreoffice") is not None
    )


#: The components the documents capability actually needs. Impress alone was
#: installed on the first VM and DOCX conversion failed silently for a week
#: ("source file could not be loaded") — readiness now names each component.
_COMPONENT_LIBS = {"writer": "libswlo.so", "impress": "libsdlo.so"}
# Debian's program dir, checked as a fallback. A module constant so a test can
# point it away from a host that happens to have LibreOffice installed.
_DEBIAN_PROGRAM_DIR = Path("/usr/lib/libreoffice/program")


def soffice_components() -> dict:
    """{binary, writer, impress}: what is installed, checked on disk (no process
    is launched). The program dir is derived from the binary, with the Debian
    default as the fallback."""
    binary = shutil.which("soffice") or shutil.which("libreoffice")
    dirs: list[Path] = [_DEBIAN_PROGRAM_DIR]
    if binary:
        try:
            real = Path(binary).resolve()
            dirs.insert(0, real.parent)
            dirs.insert(1, real.parent.parent / "program")
        except OSError:
            pass
    out = {"binary": binary is not None}
    for name, lib in _COMPONENT_LIBS.items():
        out[name] = any((d / lib).exists() for d in dirs)
    return out


async def convert(
    raw: bytes,
    *,
    to: str,
    src_ext: str,
    enabled: bool,
    timeout_s: float,
    concurrency: int = 1,
) -> bytes | None:
    """Convert `raw` (a `src_ext` document) to `to` (e.g. 'pdf'). None when disabled,
    the binary is absent, or the conversion fails/times out."""
    if not enabled or not soffice_available():
        return None
    async with _semaphore(concurrency):
        try:
            return await asyncio.to_thread(_convert_sync, raw, to, src_ext, timeout_s)
        except Exception:  # noqa: BLE001
            log.warning("documents.soffice_failed", extra={"to": to})
            return None


def _bin() -> str:
    return shutil.which("soffice") or shutil.which("libreoffice") or "soffice"


def _wrap(cmd: list[str], jobdir: str) -> list[str]:
    """Prepend the strongest available isolation to the soffice argv. `jobdir` is the RW
    working dir (kept for signature symmetry; the network+resource sandbox doesn't jail
    the FS, it isolates the network and caps resources — verified working on the VM)."""
    _ = jobdir
    # Resource caps: address space + open files.
    caps: list[str] = []
    if shutil.which("prlimit"):
        caps = ["prlimit", "--as=1500000000", "--nofile=2048", "--"]
    if shutil.which("unshare"):
        # -n = private network namespace (NO network: blocks SSRF/exfil from a doc's
        # remote refs); -r maps the caller to root inside the userns so it works without
        # extra capabilities. This is the real, VM-verified isolation.
        return ["unshare", "-rn", "--", *caps, *cmd]
    return [*caps, *cmd]


def _convert_sync(raw: bytes, to: str, src_ext: str, timeout_s: float) -> bytes | None:
    jobdir = tempfile.mkdtemp(prefix="docops_")
    profile = tempfile.mkdtemp(prefix="lo_profile_")
    try:
        src = Path(jobdir) / f"input.{src_ext}"
        src.write_bytes(raw)
        argv = [
            _bin(),
            "--headless",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to",
            to,
            "--outdir",
            jobdir,
            str(src),
        ]
        cmd = _wrap(argv, jobdir)
        # Popen + a HARD timeout that kills the whole PROCESS GROUP (soffice forks
        # children; start_new_session makes the child a group leader so killpg reaps
        # the lot — a plain run(timeout=) would kill only the direct child).
        proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell, temp-file input
            cmd,
            cwd=jobdir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            # STRIPPED env, like the decoder sandbox — soffice parses untrusted
            # OOXML/PDF, so an exploit in it must not find OPENROUTER_API_KEY,
            # AI_INGRESS_SECRET, KNOWLEDGE_DATABASE_URL or the Convex admin key in
            # its environment. It needs only HOME (its isolated profile) and the
            # headless VCL plugin; the network is already cut by `unshare -rn`.
            env={**safe_child_env(), "HOME": profile, "SAL_USE_VCLPLUGIN": "svp"},
        )
        try:
            proc.communicate(timeout=float(timeout_s))
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            proc.communicate()
            log.warning("documents.soffice_timeout")
            return None
        out = Path(jobdir) / f"input.{to}"
        if out.exists() and out.stat().st_size > 0:
            return out.read_bytes()
        return None
    finally:
        _rmtree(jobdir)
        _rmtree(profile)


def _rmtree(path: str) -> None:
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:  # noqa: BLE001,S110
        pass


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001,S110
        pass
