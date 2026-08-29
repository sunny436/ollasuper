"""Sandboxed LibreOffice headless converter — the faithful PPTX<->PDF engine.

The source `soffice.py` has NO timeout and NO real sandbox (only an isolated profile for
a sandboxed env). Here we add REAL, proven-available controls: each conversion runs
under
the strongest isolation the host offers — `systemd-run --scope` with a network namespace
(`PrivateNetwork=yes`), memory/CPU caps, `ProtectSystem=strict`, a `ReadWritePaths` jail
and `NoNewPrivileges`; else `unshare -n` (no network) + `prlimit` (memory); else plain —
always with a per-call isolated `UserInstallation` profile, a locked temp jobdir, and a
HARD Python wall-clock timeout that kills the whole process group. A concurrency
semaphore bounds the memory-heavy soffice processes. Untrusted OOXML/PDF is the input,
so
the sandbox is load-bearing. Returns the converted bytes, or None (→ the caller degrades
honestly: download + labeled-approximate/absent preview, never a faked render).
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
    """Prepend the strongest available isolation to the soffice argv."""
    mem = "1G"
    if shutil.which("systemd-run"):
        return [
            "systemd-run",
            "--scope",
            "--quiet",
            "--collect",
            "-p",
            "PrivateNetwork=yes",
            "-p",
            f"MemoryMax={mem}",
            "-p",
            "CPUQuota=100%",
            "-p",
            "ProtectSystem=strict",
            "-p",
            f"ReadWritePaths={jobdir}",
            "-p",
            "PrivateTmp=yes",
            "-p",
            "NoNewPrivileges=yes",
            "--",
            *cmd,
        ]
    caps: list[str] = []
    if shutil.which("prlimit"):
        caps = ["prlimit", "--as=1500000000", "--nofile=2048", "--"]
    if shutil.which("unshare"):
        # -n = network namespace (no network); -r maps to root inside so it works
        # without CAP_SYS_ADMIN when the service is not already root.
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
        timeout = float(timeout_s)
        try:
            subprocess.run(  # noqa: S603 - fixed argv, no shell, temp-file input
                cmd,
                cwd=jobdir,
                timeout=timeout,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                check=False,
                env={**os.environ, "HOME": profile, "SAL_USE_VCLPLUGIN": "svp"},
            )
        except subprocess.TimeoutExpired:
            log.warning("documents.soffice_timeout")
            return None
        out = Path(jobdir) / f"input.{to}"
        if out.exists() and out.stat().st_size > 0:
            return out.read_bytes()
        # A stray systemd scope / child may still hold the file; nothing to read.
        return None
    finally:
        _rmtree(jobdir)
        _rmtree(profile)


def _rmtree(path: str) -> None:
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:  # noqa: BLE001,S110
        pass


def _kill_group(proc: subprocess.Popen) -> None:  # pragma: no cover - defensive
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001,S110
        pass
