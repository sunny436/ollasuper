"""Read-only access to operator-allowlisted local git repositories.

TRUST BOUNDARY. This is the AI host's own filesystem, in a multi-tenant product,
so access is closed by default and opened only by the operator:

  * `ai_security_local_roots`  — JSON {name: absolute path}; each must be a git
    work tree. The model only ever sees and names ROOT NAMES, never paths.
  * `ai_security_local_user_ids` — the authenticated `req.userId`s allowed to use
    them. Never taken from model arguments.

Only TRACKED files are reachable (`git ls-files`), so an ignored `.env` next to
the code cannot be read by construction. Every path is re-checked with realpath
containment (a tracked symlink that points outside the root is refused).

Git runs as argv (no shell), non-blocking, with a timeout, and hardened against a
hostile repository config: no fsmonitor, no hooks, no textconv/external diff, no
global/system config, no optional locks. Revisions go after `--end-of-options`,
so a model-supplied "rev" can never become an option such as `--output=`.

`apply_fix` is the ONLY write. It is reached solely through the approval-gated
`security_apply_fix` registry tool, replaces one exact, unique snippet in one
tracked text file atomically, and never commits, pushes, creates or deletes.
"""

from __future__ import annotations

import asyncio
import contextlib
import difflib
import json
import os
import re
import stat
import subprocess
import tempfile
from dataclasses import dataclass, field

from app.logging import get_logger

log = get_logger(__name__)

MAX_READ_BYTES = 2_000_000
MAX_FIX_CHANGED_LINES = 60
_GIT_TIMEOUT_S = 20.0
_REV = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,99}$")
_PATHSPEC = re.compile(r"^[A-Za-z0-9_.*/{}\[\]-]{1,200}$")
_NULL = "NUL" if os.name == "nt" else "/dev/null"


class LocalError(Exception):
    """A refused or failed local-repository operation. `code` is stable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LocalAccess:
    roots: dict[str, str] = field(default_factory=dict)
    user_ids: frozenset[str] = frozenset()

    @staticmethod
    def from_settings(settings: object) -> LocalAccess:
        raw = str(getattr(settings, "ai_security_local_roots", "") or "").strip()
        users = str(getattr(settings, "ai_security_local_user_ids", "") or "")
        roots: dict[str, str] = {}
        if raw:
            try:
                for name, path in (json.loads(raw) or {}).items():
                    real = os.path.realpath(str(path))
                    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", str(name)) and (
                        os.path.isdir(os.path.join(real, ".git"))
                        or os.path.isfile(os.path.join(real, ".git"))
                    ):
                        roots[str(name)] = real
                    else:
                        log.warning("secaudit.root_rejected", extra={"root": str(name)})
            except (ValueError, TypeError, AttributeError):
                log.warning("secaudit.roots_invalid")
        ids = frozenset(u.strip() for u in users.split(",") if u.strip())
        return LocalAccess(roots=roots, user_ids=ids)

    def names_for(self, user_id: str) -> list[str]:
        return sorted(self.roots) if user_id and user_id in self.user_ids else []

    def resolve(self, user_id: str, name: str) -> str:
        if not user_id or user_id not in self.user_ids:
            raise LocalError(
                "not_authorized", "local repositories are not enabled for this account"
            )
        root = self.roots.get(str(name or ""))
        if root is None:
            raise LocalError(
                "unknown_root",
                f"no local repository named {str(name)[:64]!r}; available: "
                + ", ".join(sorted(self.roots)),
            )
        return root


def _git_env() -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": _NULL,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "LC_ALL": "C",
    }
    for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP"):  # Windows dev only
        if key in os.environ:
            env[key] = os.environ[key]
    return env


async def git(root: str, *args: str, timeout_s: float = _GIT_TIMEOUT_S) -> str:
    """Run one hardened git command in `root`; stdout as text, or LocalError."""
    argv = [
        "git",
        "-c",
        "core.fsmonitor=false",
        "-c",
        f"core.hooksPath={_NULL}",
        "-c",
        f"core.attributesFile={_NULL}",
        "-c",
        "safe.directory=*",
        "-c",
        "diff.external=",
        "--no-pager",
        "-C",
        root,
        *args,
    ]
    # A worker thread running a blocking subprocess: never blocks the event loop,
    # works on every platform's loop, and `timeout` KILLS the child.
    try:
        proc = await asyncio.to_thread(
            subprocess.run,  # noqa: S603 — fixed argv, no shell
            argv,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            env=_git_env(),
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise LocalError("timeout", "git timed out") from None
    except OSError as e:
        raise LocalError(
            "git_unavailable", f"git could not start: {type(e).__name__}"
        ) from e
    out, err = proc.stdout, proc.stderr
    # git grep exits 1 for "no match"; that is an empty result, not a failure.
    if proc.returncode not in (0, 1) or (
        proc.returncode == 1 and args[:1] != ("grep",)
    ):
        raise LocalError(
            "git_failed", err.decode("utf-8", "replace").strip()[:300] or "git failed"
        )
    return out.decode("utf-8", "replace")


def _rev(value: str) -> str:
    v = str(value or "").strip()
    if not _REV.fullmatch(v) or ".." in v:
        raise LocalError("invalid_rev", "revision must be a commit, tag or branch name")
    return v


def safe_relpath(path: str) -> str:
    p = str(path or "").strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    if (
        not p
        or len(p) > 400
        or "\x00" in p
        or p.startswith("/")
        or re.match(r"^[A-Za-z]:", p)
        or any(seg in ("..", "") for seg in p.split("/"))
    ):
        raise LocalError("invalid_path", "path must be relative to the repository root")
    return p


async def tracked(root: str) -> list[str]:
    out = await git(root, "ls-files", "-z")
    return [p for p in out.split("\x00") if p]


async def head(root: str) -> str:
    return (await git(root, "rev-parse", "--verify", "HEAD")).strip()[:40]


def _contained(root: str, rel: str) -> str:
    full = os.path.realpath(os.path.join(root, rel))
    base = os.path.realpath(root)
    if os.path.commonpath([full, base]) != base:
        raise LocalError("invalid_path", "path resolves outside the repository")
    return full


def _read_bytes(full: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(full, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise LocalError("invalid_path", "not a regular file")
        chunks, size = [], 0
        while True:
            b = os.read(fd, 65536)
            if not b:
                break
            size += len(b)
            if size > MAX_READ_BYTES:
                raise LocalError("too_large", "file exceeds the read limit")
            chunks.append(b)
        return b"".join(chunks)
    finally:
        os.close(fd)


async def read_text(root: str, rel: str, tracked_set: set[str]) -> str:
    rel = safe_relpath(rel)
    if rel not in tracked_set:
        raise LocalError("not_tracked", "only files tracked by git can be read")
    full = _contained(root, rel)
    try:
        raw = await asyncio.to_thread(_read_bytes, full)
    except OSError as e:
        raise LocalError(
            "unreadable", f"file could not be read: {type(e).__name__}"
        ) from e
    if b"\x00" in raw[:8192]:
        raise LocalError("binary", "binary files are not read")
    return raw.decode("utf-8", "replace")


async def grep(root: str, pattern: str, pathspec: str = "", limit: int = 200) -> str:
    pat = str(pattern or "")
    if not pat or len(pat) > 200 or "\x00" in pat:
        raise LocalError("invalid_pattern", "pattern must be 1-200 characters")
    args = [
        "grep",
        "-n",
        "-I",
        "-E",
        "--no-color",
        "--no-textconv",
        "--max-count=20",
        "-e",
        pat,
        "--",
    ]
    if pathspec:
        if not _PATHSPEC.fullmatch(pathspec) or ".." in pathspec:
            raise LocalError("invalid_path", "pathspec must be a simple glob")
        args.append(pathspec)
    out = await git(root, *args)
    lines = out.splitlines()
    more = len(lines) - limit
    body = "\n".join(line[:400] for line in lines[:limit])
    return body + (f"\n… {more} more matches not shown" if more > 0 else "")


async def log_text(root: str, n: int = 20, path: str = "") -> str:
    args = [
        "log",
        "--no-color",
        "--no-textconv",
        "--no-ext-diff",
        "--format=%H%x09%ad%x09%s",
        "--date=short",
        f"-n{max(1, min(int(n), 100))}",
        "--end-of-options",
        "HEAD",
        "--",
    ]
    if path:
        args.append(safe_relpath(path))
    return await git(root, *args)


async def diff_text(root: str, base: str, target: str, path: str = "") -> str:
    args = [
        "diff",
        "--no-color",
        "--no-textconv",
        "--no-ext-diff",
        "--end-of-options",
        _rev(base),
        _rev(target),
        "--",
    ]
    if path:
        args.append(safe_relpath(path))
    return await git(root, *args, timeout_s=30.0)


def numbered(text: str, start: int, end: int, max_chars: int) -> dict:
    """Lines [start, end] (1-based, inclusive) with numbers, bounded to max_chars."""
    lines = text.splitlines()
    total = len(lines)
    start = max(1, int(start or 1))
    end = min(total, int(end or start + 399), start + 399)
    out, used, last = [], 0, start - 1
    for i in range(start, end + 1):
        row = f"{i}: {lines[i - 1][:500]}"
        if used + len(row) + 1 > max_chars and out:
            break
        out.append(row)
        used += len(row) + 1
        last = i
    return {
        "start_line": start,
        "end_line": last,
        "total_lines": total,
        "next_line": last + 1 if last < total else None,
        "content": "\n".join(out),
    }


def _changed_lines(before: str, after: str) -> int:
    diff = difflib.unified_diff(
        before.splitlines(), after.splitlines(), lineterm="", n=0
    )
    return sum(
        1 for line in diff if line[:1] in "+-" and not line.startswith(("+++", "---"))
    )


def plan_fix(text: str, old: str, new: str) -> str:
    """The patched text, or LocalError. Pure — also used for the approval preview."""
    if not old:
        raise LocalError("invalid_fix", "`old` must be the exact snippet to replace")
    if old == new:
        raise LocalError("invalid_fix", "`new` is identical to `old`")
    count = text.count(old)
    if count == 0:
        raise LocalError("no_match", "`old` was not found in the file")
    if count > 1:
        raise LocalError(
            "ambiguous_match", f"`old` occurs {count} times; make it unique"
        )
    patched = text.replace(old, new, 1)
    if _changed_lines(text, patched) > 2 * MAX_FIX_CHANGED_LINES:
        raise LocalError("fix_too_large", "a security fix must be a minimal patch")
    return patched


async def apply_fix(root: str, rel: str, old: str, new: str) -> dict:
    """Replace ONE exact snippet in ONE tracked text file, atomically. Never commits."""
    rel = safe_relpath(rel)
    if rel not in set(await tracked(root)):
        raise LocalError("not_tracked", "only files tracked by git can be changed")
    full = _contained(root, rel)
    raw = await asyncio.to_thread(_read_bytes, full)
    if b"\x00" in raw[:8192]:
        raise LocalError("binary", "binary files are not changed")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise LocalError("not_utf8", "only UTF-8 text files are changed") from None
    patched = plan_fix(text, old, new)

    def _write() -> None:
        mode = stat.S_IMODE(os.stat(full).st_mode)
        fd, tmp = tempfile.mkstemp(prefix=".secaudit-", dir=os.path.dirname(full))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(patched.encode("utf-8"))
            os.chmod(tmp, mode)
            os.replace(tmp, full)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise

    try:
        await asyncio.to_thread(_write)
    except OSError as e:
        raise LocalError(
            "write_failed", f"the file could not be written: {type(e).__name__}"
        ) from e
    diff = "\n".join(
        difflib.unified_diff(
            text.splitlines(), patched.splitlines(), f"a/{rel}", f"b/{rel}", lineterm=""
        )
    )
    return {"path": rel, "diff": diff, "changed_lines": _changed_lines(text, patched)}
