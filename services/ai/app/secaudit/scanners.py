"""Deterministic scanners for LOCAL repositories.

  * secret sweep  — every tracked file, in the existing sandbox child (off the
                    single event loop, stripped env, killable), rule-based.
  * OSV audit     — pinned versions from lockfiles → api.osv.dev (fixed host). The
                    package names/versions leave the host; the report says so.
  * SARIF runners — semgrep/opengrep/gitleaks/trivy/checkov/osv-scanner, ONLY if the
                    binary is already on PATH. Nothing is installed; a missing
                    scanner is `not_installed`, never "clean".

Every stage returns an explicit status: ran | failed | not_installed | not_run |
disabled. A failed stage is recorded as failed — the report turns it into an
INCOMPLETE verdict rather than a quiet absence.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import tomllib
from pathlib import Path
from typing import Any

import httpx

from app.logging import get_logger
from app.secaudit import secrets
from app.secaudit.local import LocalError, _contained, _read_bytes

log = get_logger(__name__)

SWEEP_MAX_FILES = 20_000
SWEEP_MAX_BYTES = 64 * 1024 * 1024
SWEEP_FILE_MAX_BYTES = 1_000_000
SWEEP_CPU_BUDGET_S = 15.0  # the sandbox child has a 20s CPU rlimit
OSV_URL = "https://api.osv.dev/v1"
OSV_MAX_PACKAGES = 5000
OSV_MAX_DETAILS = 40
_SWEEP_LOCK = asyncio.Semaphore(1)


# ---------------------------------------------------------------- secret sweep
def sweep_files(req: dict) -> dict:
    """Pure + synchronous: runs inside the sandbox child (or a thread on dev)."""
    root = str(req.get("root") or "")
    files = [str(f) for f in (req.get("files") or [])][:SWEEP_MAX_FILES]
    hits: list[dict] = []
    scanned = skipped = total = 0
    truncated = False
    t0 = time.process_time()
    for rel in files:
        if total >= SWEEP_MAX_BYTES or time.process_time() - t0 > SWEEP_CPU_BUDGET_S:
            truncated = True
            break
        try:
            full = _contained(root, rel)
            if os.path.getsize(full) > SWEEP_FILE_MAX_BYTES:
                skipped += 1
                continue
            raw = _read_bytes(full)
        except (OSError, LocalError):
            skipped += 1
            continue
        if b"\x00" in raw[:8192]:
            skipped += 1
            continue
        text = raw.decode("utf-8", "replace")
        total += len(raw)
        scanned += 1
        for h in secrets.scan(text):
            hits.append(
                {
                    "path": rel,
                    "line": secrets.line_of(text, h.start),
                    "rule": h.rule,
                    "fp": h.fingerprint,
                }
            )
    return {
        "files_total": len(req.get("files") or []),
        "files_scanned": scanned,
        "files_skipped": skipped,
        "bytes": total,
        "truncated": truncated or len(req.get("files") or []) > SWEEP_MAX_FILES,
        "hits": hits[:2000],
    }


async def secret_sweep(root: str, files: list[str], timeout_s: float = 120.0) -> dict:
    from app.sandbox.harness import run_sandboxed

    payload = json.dumps({"root": root, "files": files}).encode("utf-8")

    async def _fallback() -> tuple[dict, bytes]:  # dev box (no posix fork) only
        res = await asyncio.to_thread(sweep_files, {"root": root, "files": files})
        return {"ok": True}, json.dumps(res).encode("utf-8")

    async with _SWEEP_LOCK:
        meta, body = await run_sandboxed(
            "secret_sweep", payload, {}, timeout_s=timeout_s, fallback=_fallback
        )
    if not meta.get("ok"):
        raise LocalError("sweep_failed", str(meta.get("error") or "sweep failed")[:200])
    return json.loads(body.decode("utf-8"))


# ------------------------------------------------------------------ lockfiles
_REQ_LINE = re.compile(
    r"^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9_.+!-]+)"
)
_BUN_ENTRY = re.compile(
    r'"(?:@[^"/\s]+/)?[^"@/\s]+"\s*:\s*\[\s*"((?:@[^"/\s]+/)?[^"@\s]+)@([^"\s]+)"'
)


def is_lockfile(path: str) -> bool:
    base = path.rsplit("/", 1)[-1]
    if "node_modules/" in path:
        return False
    return base in ("uv.lock", "package-lock.json", "bun.lock") or bool(
        re.fullmatch(r"requirements[\w.-]*\.txt", base)
    )


def parse_lockfile(path: str, text: str) -> list[tuple[str, str, str]]:
    """[(ecosystem, name, version)] of PINNED registry packages."""
    base = path.rsplit("/", 1)[-1]
    out: list[tuple[str, str, str]] = []
    if base == "uv.lock":
        data = tomllib.loads(text)
        for p in data.get("package", []) or []:
            src = p.get("source") or {}
            if isinstance(src, dict) and "registry" in src and p.get("version"):
                out.append(("PyPI", str(p["name"]), str(p["version"])))
    elif base == "package-lock.json":
        data = json.loads(text)
        for key, meta in (data.get("packages") or {}).items():
            if not key or not isinstance(meta, dict) or meta.get("link"):
                continue
            name = key.rsplit("node_modules/", 1)[-1]
            if meta.get("version"):
                out.append(("npm", name, str(meta["version"])))
    elif base == "bun.lock":
        for m in _BUN_ENTRY.finditer(text):
            name, version = m.group(1), m.group(2)
            if not re.match(r"^\d", version):  # workspace:/file:/github: etc.
                continue
            out.append(("npm", name, version))
    else:
        for line in text.splitlines():
            m = _REQ_LINE.match(line)
            if m:
                out.append(("PyPI", m.group(1), m.group(2)))
    return out


async def osv_audit(
    packages: list[tuple[str, str, str, str]],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """packages: [(ecosystem, name, version, lockfile)]. Raises on network failure."""
    uniq: dict[tuple[str, str, str], list[str]] = {}
    for eco, name, version, lock in packages:
        uniq.setdefault((eco, name, version), []).append(lock)
    keys = list(uniq)[:OSV_MAX_PACKAGES]
    vulns: list[dict] = []
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as client:
        for i in range(0, len(keys), 1000):
            batch = keys[i : i + 1000]
            r = await client.post(
                f"{OSV_URL}/querybatch",
                json={
                    "queries": [
                        {"package": {"ecosystem": e, "name": n}, "version": v}
                        for e, n, v in batch
                    ]
                },
            )
            r.raise_for_status()
            for (e, n, v), res in zip(
                batch, r.json().get("results") or [], strict=False
            ):
                ids = [
                    x.get("id") for x in (res or {}).get("vulns") or [] if x.get("id")
                ]
                if ids:
                    vulns.append(
                        {
                            "ecosystem": e,
                            "name": n,
                            "version": v,
                            "lockfiles": sorted(set(uniq[(e, n, v)])),
                            "ids": ids,
                        }
                    )
        details: dict[str, dict] = {}
        want = list(dict.fromkeys(i for v in vulns for i in v["ids"]))[:OSV_MAX_DETAILS]
        sem = asyncio.Semaphore(8)

        async def one(vid: str) -> None:
            async with sem:
                with contextlib.suppress(Exception):
                    d = (await client.get(f"{OSV_URL}/vulns/{vid}")).json()
                    fixed = sorted(
                        {
                            ev["fixed"]
                            for a in d.get("affected") or []
                            for rg in a.get("ranges") or []
                            for ev in rg.get("events") or []
                            if isinstance(ev, dict) and ev.get("fixed")
                        }
                    )
                    details[vid] = {
                        "summary": str(d.get("summary") or "")[:200],
                        "aliases": [a for a in d.get("aliases") or [] if a][:5],
                        "severity": str(
                            (d.get("database_specific") or {}).get("severity") or ""
                        ),
                        "fixed": fixed[:5],
                    }

        await asyncio.gather(*(one(v) for v in want))
    for v in vulns:
        v["details"] = {i: details[i] for i in v["ids"] if i in details}
    return {
        "packages_checked": len(keys),
        "packages_truncated": len(uniq) > OSV_MAX_PACKAGES,
        "vulnerable": vulns,
        "details_truncated": len({i for v in vulns for i in v["ids"]})
        > OSV_MAX_DETAILS,
    }


# ------------------------------------------------------------------ SARIF runners
# argv templates. `{rules}` = the OpenGrep/Semgrep ruleset (never `--config auto`:
# that fetches registry rules over the network under their own licence);
# `{gitleaks_config}` = the PINNED default gitleaks config and `{noignore}` = an
# empty directory, so a scanned repository's own `.gitleaks.toml`,
# `.gitleaksignore` or `gitleaks:allow` comments cannot switch detection off.
SARIF_SCANNERS: dict[str, list[str]] = {
    "opengrep": [
        "opengrep", "scan", "--sarif", "--quiet", "--disable-version-check",
        "--jobs", "2", "--timeout", "10", "--max-target-bytes", "1000000",
        "--config", "{rules}", ".",
    ],
    "semgrep": [
        "semgrep", "scan", "--sarif", "--quiet", "--metrics=off",
        "--disable-version-check", "--jobs", "2", "--timeout", "10",
        "--max-target-bytes", "1000000", "--config", "{rules}", ".",
    ],
    "gitleaks": [
        "gitleaks", "git", ".", "--config", "{gitleaks_config}",
        "--ignore-gitleaks-allow", "--gitleaks-ignore-path", "{noignore}",
        "--report-format", "sarif", "--report-path", "-", "--redact",
        "--no-banner", "--log-level", "error", "--max-target-megabytes", "5",
    ],
    "trivy": ["trivy", "fs", "--format", "sarif", "--quiet", "."],
    "checkov": ["checkov", "-d", ".", "-o", "sarif", "--quiet", "--compact"],
    "osv-scanner": ["osv-scanner", "scan", "--format", "sarif", "-r", "."],
}  # fmt: skip

DEFAULT_RULES = Path(__file__).parent / "rules" / "ollasuper.yaml"
# Address-space cap for a scanner child. Go binaries (gitleaks) reserve large
# virtual ranges and panic under RLIMIT_AS, so they get Go's own soft memory
# limit instead (measured on the VM: gitleaks panics with --as, runs in 84MB
# without it; opengrep peaks at 274MB on the whole repository).
_DEFAULT_AS_BYTES = 2_500_000_000
_SCANNER_LIMITS: dict[str, dict] = {
    "gitleaks": {"as_bytes": 0, "env": {"GOMEMLIMIT": "1GiB", "GOMAXPROCS": "2"}},
}
# One scanner run at a time across the plane: the service shares one cgroup.
_SCANNER_LOCK = asyncio.Semaphore(1)


def parse_sarif(raw: str, limit: int = 500) -> list[dict]:
    data = json.loads(raw)
    out: list[dict] = []
    for run in data.get("runs") or []:
        tool = (((run.get("tool") or {}).get("driver") or {}).get("name")) or ""
        for res in run.get("results") or []:
            loc = ((res.get("locations") or [{}])[0] or {}).get(
                "physicalLocation"
            ) or {}
            region = loc.get("region") or {}
            msg, _ = secrets.redact_text(
                str((res.get("message") or {}).get("text") or "")
            )
            # OpenGrep/Semgrep prefix a rule id with its config path
            # ("opt.myos...rules.py-sql-built-from-strings"); keep the rule name.
            rule = str(res.get("ruleId") or "").rsplit(".", 1)[-1]
            out.append(
                {
                    "tool": str(tool)[:40],
                    "rule": rule[:120],
                    "level": str(res.get("level") or "warning"),
                    "path": str((loc.get("artifactLocation") or {}).get("uri") or "")[
                        :400
                    ],
                    "line": int(region.get("startLine") or 0),
                    "message": msg[:300],
                }
            )
            if len(out) >= limit:
                return out
    return out


def _isolation(name: str) -> tuple[list[str], dict[str, str]]:
    """No network (a scanner must not phone home or fetch rules), bounded memory,
    files and CPU priority. Absent tools on a dev box simply add nothing."""
    from app.sandbox.harness import safe_child_env

    limits = _SCANNER_LIMITS.get(name, {})
    prefix: list[str] = []
    if os.name == "posix":
        if shutil.which("unshare"):
            prefix += ["unshare", "-rn", "--"]
        if shutil.which("prlimit"):
            as_bytes = limits.get("as_bytes", _DEFAULT_AS_BYTES)
            prefix += ["prlimit", "--nofile=2048", "--fsize=67108864"]
            prefix += [f"--as={as_bytes}"] if as_bytes else []
            prefix += ["--"]
        if shutil.which("nice"):
            prefix += ["nice", "-n", "10"]
    return prefix, {**safe_child_env(), **limits.get("env", {})}


def _missing_resource(argv: list[str], rules: str, gitleaks_config: str) -> str:
    """A scanner whose ruleset/pinned config is absent does not run at all — it
    would otherwise fall back to network rules or the repository's own config."""
    if "{rules}" in argv and not Path(rules).is_file():
        return "ruleset not found"
    if "{gitleaks_config}" in argv and not Path(gitleaks_config).is_file():
        return "pinned gitleaks.toml not found next to the binary"
    return ""


async def run_sarif_scanners(
    root: str,
    timeout_s: float,
    *,
    enabled: tuple[str, ...] | list[str] = ("opengrep", "gitleaks"),
    bin_dir: str = "",
    rules: str = "",
) -> dict[str, dict]:
    """Run the CONFIGURED scanners. Every outcome is explicit: ran | failed |
    not_installed — a scanner that could not run is never reported as clean."""
    results: dict[str, dict] = {}
    rules_path = rules or str(DEFAULT_RULES)
    async with _SCANNER_LOCK:
        for name in enabled:
            argv = SARIF_SCANNERS.get(name)
            if argv is None:
                results[name] = {"status": "failed", "reason": "unknown scanner"}
                continue
            exe = (shutil.which(argv[0], path=bin_dir) if bin_dir else None) or (
                shutil.which(argv[0])
            )
            if exe is None:
                results[name] = {"status": "not_installed"}
                continue
            gitleaks_config = str(Path(exe).parent / "gitleaks.toml")
            missing = _missing_resource(argv, rules_path, gitleaks_config)
            if missing:
                results[name] = {"status": "failed", "reason": missing}
                continue
            prefix, env = _isolation(name)
            with tempfile.TemporaryDirectory(prefix="secaudit-noignore-") as noignore:
                subs = {
                    "{rules}": rules_path,
                    "{gitleaks_config}": gitleaks_config,
                    "{noignore}": noignore,
                }
                cmd = [*prefix, exe, *(subs.get(a, a) for a in argv[1:])]
                try:
                    proc = await asyncio.to_thread(
                        subprocess.run,  # noqa: S603 — fixed argv table, no shell
                        cmd,
                        cwd=root,
                        env=env,
                        stdin=subprocess.DEVNULL,
                        capture_output=True,
                        timeout=timeout_s,
                        check=False,
                    )
                except subprocess.TimeoutExpired:
                    results[name] = {"status": "failed", "reason": "timeout"}
                    continue
                except OSError as e:
                    results[name] = {"status": "failed", "reason": type(e).__name__}
                    continue
            # 0 = clean run, 1 = findings (gitleaks/opengrep --error); else failure.
            if proc.returncode not in (0, 1):
                tail, _ = secrets.redact_text(
                    proc.stderr.decode("utf-8", "replace")[-300:]
                )
                results[name] = {
                    "status": "failed",
                    "reason": f"exit {proc.returncode}: {tail}",
                }
                continue
            try:
                findings = parse_sarif(proc.stdout.decode("utf-8", "replace"))
            except (ValueError, TypeError, AttributeError):
                results[name] = {
                    "status": "failed",
                    "reason": "unreadable SARIF output",
                }
                continue
            results[name] = {"status": "ran", "findings": findings}
    return results


def summarize(obj: Any, limit: int = 6000) -> str:
    text = json.dumps(obj, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"
