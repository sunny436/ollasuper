"""The security tools: three read-only built-ins and one approval-gated fix tool.

  security_repo      read-only local repository access (allowlisted roots only)
  security_scan      deterministic stages: secrets | dependencies | scanners | retest
  security_report    submit findings → validated statuses (the runner appends the
                     canonical report from recorded state)
  security_apply_fix a REGISTRY tool (provider `secaudit`, approval_required) so the
                     existing approval card, binding and durable records apply
                     unchanged; its adapter builds the before/after preview.

Every result that leaves here is redacted; every outcome is recorded on the
turn's `SecurityTurn`, which is what the report is written from.
"""

from __future__ import annotations

import json

from app.logging import get_logger
from app.models.tools import SideEffect, ToolDefinition, ToolPermissions
from app.secaudit import local, scanners, secrets
from app.secaudit.report import Read, SecurityTurn
from app.tools.errors import ToolError, ToolErrorKind
from app.tools.registry import ToolRegistry

log = get_logger(__name__)

REPO_TOOL_NAME = "security_repo"
SCAN_TOOL_NAME = "security_scan"
REPORT_TOOL_NAME = "security_report"
SECURITY_TOOL_NAMES = frozenset({REPO_TOOL_NAME, SCAN_TOOL_NAME, REPORT_TOOL_NAME})
FIX_PROVIDER = "secaudit"
# Id == name: bound names are derived from the tool id, and the model (and the
# skill text) call it `security_apply_fix`.
FIX_TOOL_ID = "security_apply_fix"
FIX_TOOL_NAME = "security_apply_fix"

_STR = {"type": "string"}
_INT = {"type": "integer"}
_STRS = {"type": "array", "items": {"type": "string"}}

SECURITY_REPO_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": REPO_TOOL_NAME,
        "description": (
            "Read-only access to an allowlisted LOCAL git repository (names are listed "
            "in <security_audit>). ops: head (commit sha) | tree (tracked files, "
            "optional path prefix) | read (numbered lines; path + start_line/end_line; "
            "follow next_line for more) | grep (extended regex `pattern`, optional "
            "`path` glob) | log (recent commits, optional path) | diff (`base` and "
            "`target` commits/branches, optional path). Secret values come back "
            "redacted. Never modifies anything."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "repo": {**_STR, "description": "Local repository name."},
                "op": {
                    "type": "string",
                    "enum": ["head", "tree", "read", "grep", "log", "diff"],
                },
                "path": {**_STR, "description": "Relative file path, prefix or glob."},
                "start_line": _INT,
                "end_line": _INT,
                "pattern": _STR,
                "base": _STR,
                "target": _STR,
                "limit": _INT,
            },
            "required": ["repo", "op"],
        },
    },
}

SECURITY_SCAN_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": SCAN_TOOL_NAME,
        "description": (
            "Deterministic security stages for a LOCAL repository. ops: secrets (rule-"
            "based sweep of every tracked file) | dependencies (lockfile versions "
            "checked against the OSV database) | scanners (installed SARIF scanners "
            "such as semgrep/gitleaks/trivy; missing ones are reported as not "
            "installed) | retest (after a fix: re-read `path` and confirm each flagged "
            "`evidence` snippet is gone and no secret pattern remains). A failed stage "
            "is reported as failed, never as clean."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "repo": _STR,
                "op": {
                    "type": "string",
                    "enum": ["secrets", "dependencies", "scanners", "retest"],
                },
                "path": _STR,
                "evidence": {
                    **_STRS,
                    "description": "retest: the flagged code snippets.",
                },
            },
            "required": ["repo", "op"],
        },
    },
}

_FINDING = {
    "type": "object",
    "properties": {
        "title": _STR,
        "status": {
            "type": "string",
            "enum": ["confirmed", "needs_validation", "rejected"],
        },
        "vulnerability_class": _STR,
        "cwe": _STRS,
        "owasp": _STRS,
        "path": _STR,
        "start_line": _INT,
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"path": _STR, "start_line": _INT, "code": _STR},
                "required": ["code"],
            },
        },
        "source_to_sink": _STR,
        "control": _STR,
        "reachability": _STR,
        "attacker": _STR,
        "preconditions": _STR,
        "impact": {
            "type": "string",
            "enum": ["critical", "high", "medium", "low", "unknown"],
        },
        "likelihood": {"type": "string", "enum": ["high", "medium", "low", "unknown"]},
        "severity": {
            "type": "string",
            "enum": ["critical", "high", "medium", "low", "informational"],
        },
        "severity_rationale": _STR,
        "exploitability": _STR,
        "counterevidence": _STR,
        "remediation": _STR,
    },
    "required": ["title", "status", "path", "evidence", "impact", "likelihood"],
}

SECURITY_REPORT_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": REPORT_TOOL_NAME,
        "description": (
            "Submit the audit's findings ONCE at the end for validation. Evidence must "
            "be code you actually read this turn; unverifiable findings are marked "
            "needs_validation and severity is capped by impact x likelihood. Returns "
            "the validated statuses; the system appends the final report itself."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "source": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["local", "github", "inline"],
                        },
                        "repo": _STR,
                        "ref": _STR,
                    },
                    "required": ["kind"],
                },
                "scope_summary": _STR,
                "findings": {"type": "array", "items": _FINDING},
            },
            "required": ["source", "findings"],
        },
    },
}

SECURITY_TOOL_SPECS = [
    SECURITY_REPO_TOOL_SPEC,
    SECURITY_SCAN_TOOL_SPEC,
    SECURITY_REPORT_TOOL_SPEC,
]


def _msg(call_id: str, body: dict, *, ok: bool = True):
    from langchain_core.messages import ToolMessage

    text, _ = secrets.redact_text(json.dumps(body, ensure_ascii=False, default=str))
    return ToolMessage(
        content=text, tool_call_id=call_id, status="success" if ok else "error"
    )


async def _tracked(state: SecurityTurn, name: str, root: str) -> set[str]:
    if name not in state.tracked_cache:
        state.tracked_cache[name] = set(await local.tracked(root))
    return state.tracked_cache[name]


async def _root(state: SecurityTurn, name: str) -> str:
    try:
        root = state.local.resolve(state.user_id, name)
    except local.LocalError as e:
        state.local_access[str(name)[:64] or "(unnamed)"] = e.code
        raise
    if name not in state.local_heads:
        state.local_heads[name] = await local.head(root)
    state.local_access[name] = "verified"
    return root


async def run_security_tool(
    state: SecurityTurn, call_id: str, name: str, args: dict, max_chars: int
):
    """Dispatch one of the three built-ins. Never raises; always a ToolMessage."""
    try:
        if name == REPORT_TOOL_NAME:
            validated = state.validate(
                args.get("source") or {},
                str(args.get("scope_summary") or ""),
                args.get("findings") or [],
            )
            return _msg(
                call_id,
                {
                    "validated": [
                        {
                            k: f[k]
                            for k in (
                                "fingerprint",
                                "title",
                                "status",
                                "severity",
                                "reasons",
                            )
                        }
                        for f in validated
                    ],
                    "note": (
                        "The system appends the final validated report; "
                        "do not restate it as a table."
                    ),
                },
            )
        repo = str(args.get("repo") or "")
        root = await _root(state, repo)
        if name == REPO_TOOL_NAME:
            return _msg(call_id, await _repo_op(state, repo, root, args, max_chars))
        if name == SCAN_TOOL_NAME:
            return _msg(call_id, await _scan_op(state, repo, root, args))
        return _msg(call_id, {"error": f"unknown security tool {name}"}, ok=False)
    except local.LocalError as e:
        return _msg(
            call_id, {"status": "error", "code": e.code, "error": e.message}, ok=False
        )
    except Exception as e:  # noqa: BLE001 — a tool failure is a result, not a crash
        log.warning(
            "secaudit.tool_failed", extra={"tool": name, "error": type(e).__name__}
        )
        return _msg(call_id, {"status": "error", "error": type(e).__name__}, ok=False)


async def _repo_op(
    state: SecurityTurn, repo: str, root: str, args: dict, max_chars: int
) -> dict:
    op = str(args.get("op") or "")
    commit = state.local_heads.get(repo, "")
    if op == "head":
        return {"repo": repo, "commit": commit}
    if op == "tree":
        prefix = str(args.get("path") or "").strip().strip("/")
        files = sorted(await _tracked(state, repo, root))
        if prefix:
            files = [f for f in files if f == prefix or f.startswith(prefix + "/")]
        limit = max(1, min(int(args.get("limit") or 1500), 5000))
        listing = "\n".join(files[:limit])
        state.add_read(Read(source="local", repo=repo, path="", text=listing[:200_000]))
        return {
            "repo": repo,
            "commit": commit,
            "total": len(files),
            "files": files[: min(limit, max(50, max_chars // 60))],
            "truncated": len(files) > min(limit, max(50, max_chars // 60)),
        }
    if op == "read":
        path = local.safe_relpath(str(args.get("path") or ""))
        text = await local.read_text(root, path, await _tracked(state, repo, root))
        red, hits = secrets.redact_text(text)
        state.note_secret_hits(
            "local",
            repo,
            path,
            [
                {
                    "rule": h.rule,
                    "fp": h.fingerprint,
                    "line": secrets.line_of(text, h.start),
                }
                for h in hits
            ],
        )
        view = local.numbered(
            red,
            int(args.get("start_line") or 1),
            int(args.get("end_line") or 0),
            max_chars - 400,
        )
        state.add_read(
            Read(
                source="local",
                repo=repo,
                path=path,
                text=red,
                shown=[(view["start_line"], view["end_line"])],
                truncated=view["next_line"] is not None,
            )
        )
        return {"repo": repo, "commit": commit, "path": path, **view}
    if op == "grep":
        out = await local.grep(
            root, str(args.get("pattern") or ""), str(args.get("path") or "")
        )
        red, _ = secrets.redact_text(out)
        state.add_read(Read(source="local", repo=repo, path="", text=red))
        # A matched line was SHOWN: record it against its file for evidence checks.
        for line in red.splitlines():
            parts = line.split(":", 2)
            if len(parts) == 3 and parts[1].isdigit():
                n = int(parts[1])
                for r in state.reads:
                    if r.source == "local" and r.repo == repo and r.path == parts[0]:
                        r.shown.append((n, n))
        return {"repo": repo, "commit": commit, "matches": red[: max_chars - 400]}
    if op in ("log", "diff"):
        if op == "log":
            out = await local.log_text(
                root, int(args.get("limit") or 20), str(args.get("path") or "")
            )
        else:
            out = await local.diff_text(
                root,
                str(args.get("base") or ""),
                str(args.get("target") or ""),
                str(args.get("path") or ""),
            )
        red, _ = secrets.redact_text(out)
        state.add_read(Read(source="local", repo=repo, path="", text=red[:500_000]))
        return {
            "repo": repo,
            "commit": commit,
            op: red[: max_chars - 400],
            "truncated": len(red) > max_chars - 400,
        }
    raise local.LocalError("invalid_op", f"unknown op {op!r}")


async def _scan_op(state: SecurityTurn, repo: str, root: str, args: dict) -> dict:
    op = str(args.get("op") or "")
    files = sorted(await _tracked(state, repo, root))
    if op == "secrets":
        try:
            res = await scanners.secret_sweep(root, files)
        except Exception as e:  # noqa: BLE001
            state.set_stage("secret_scan", "failed", repo=repo, reason=type(e).__name__)
            return {"status": "failed", "reason": type(e).__name__}
        state.note_secret_hits("local", repo, "", res["hits"])
        state.set_stage(
            "secret_scan",
            "ran",
            repo=repo,
            files=res["files_scanned"],
            skipped=res["files_skipped"],
            truncated=res["truncated"] or None,
        )
        return {
            "status": "ran",
            "files_scanned": res["files_scanned"],
            "truncated": res["truncated"],
            "hits": res["hits"][:100],
        }
    if op == "dependencies":
        if not state.osv_enabled:
            state.set_stage("dependency_audit", "disabled", repo=repo)
            return {"status": "disabled"}
        tracked_set = set(files)
        packages: list[tuple[str, str, str, str]] = []
        locks = [f for f in files if scanners.is_lockfile(f)][:20]
        if not locks:
            state.set_stage(
                "dependency_audit", "not_run", repo=repo, reason="no supported lockfile"
            )
            return {"status": "not_run", "reason": "no supported lockfile"}
        parse_errors = []
        for lock in locks:
            try:
                text = await local.read_text(root, lock, tracked_set)
                packages += [
                    (e, n, v, lock) for e, n, v in scanners.parse_lockfile(lock, text)
                ]
            except Exception as e:  # noqa: BLE001
                parse_errors.append(f"{lock}: {type(e).__name__}")
        try:
            res = await scanners.osv_audit(packages)
        except Exception as e:  # noqa: BLE001
            state.set_stage(
                "dependency_audit", "failed", repo=repo, reason=type(e).__name__
            )
            return {"status": "failed", "reason": type(e).__name__}
        state.dep_vulns = res["vulnerable"]
        state.set_stage(
            "dependency_audit",
            "failed" if parse_errors else "ran",
            repo=repo,
            lockfiles=len(locks),
            packages=res["packages_checked"],
            vulnerable=len(res["vulnerable"]),
            parse_errors=parse_errors or None,
        )
        return {"status": "ran", "lockfiles": locks, **res}
    if op == "scanners":
        results = await scanners.run_sarif_scanners(root, state.scanner_timeout_s)
        for name, r in results.items():
            state.set_stage(
                f"sast:{name}",
                r["status"],
                reason=r.get("reason"),
                findings=len(r.get("findings") or []) or None,
            )
            state.scanner_findings += r.get("findings") or []
        return {
            n: {k: v for k, v in r.items() if k != "findings"}
            | {"findings": (r.get("findings") or [])[:50]}
            for n, r in results.items()
        }
    if op == "retest":
        path = local.safe_relpath(str(args.get("path") or ""))
        state.tracked_cache.pop(repo, None)
        text = await local.read_text(root, path, await _tracked(state, repo, root))
        red, hits = secrets.redact_text(text)
        norm = " ".join(red.split())
        evidence = [str(e) for e in (args.get("evidence") or []) if str(e).strip()][:10]
        still = [e[:120] for e in evidence if " ".join(e.split()) in norm]
        prior = {
            h["fp"]
            for h in state.secret_hits
            if h["repo"] == repo and h["path"] == path
        }
        remaining = [h.rule for h in hits if h.fingerprint in prior]
        new = [h.rule for h in hits if h.fingerprint not in prior]
        fixed_here = any(
            f["repo"] == repo and f["path"] == path and f["status"] == "applied"
            for f in state.fixes
        )
        if not evidence:
            status, detail = "not_run", "no flagged evidence was supplied to retest"
        elif still or remaining or new:
            status = "failed"
            detail = "; ".join(
                filter(
                    None,
                    [
                        f"flagged evidence still present ({len(still)})"
                        if still
                        else "",
                        f"secret pattern still present ({', '.join(remaining)})"
                        if remaining
                        else "",
                        f"new secret pattern introduced ({', '.join(new)})"
                        if new
                        else "",
                    ],
                )
            )
        else:
            status, detail = (
                "passed",
                "flagged evidence absent; no secret pattern in the file",
            )
        if not fixed_here and status == "passed":
            detail += " (no fix was applied through this turn)"
        state.retests[(repo, path)] = {"status": status, "detail": detail}
        state.add_read(
            Read(
                source="local",
                repo=repo,
                path=path,
                text=red,
                shown=[(1, red.count("\n") + 1)],
            )
        )
        return {"status": status, "detail": detail, "path": path}
    raise local.LocalError("invalid_op", f"unknown op {op!r}")


# ------------------------------------------------------------------ fix tool
def fix_tool_definition() -> ToolDefinition:
    return ToolDefinition(
        tool_id=FIX_TOOL_ID,
        name=FIX_TOOL_NAME,
        description=(
            "Apply ONE minimal security fix to a tracked text file in an allowlisted "
            "LOCAL repository: replaces the exact, unique `old` snippet with `new`. "
            "The user sees the before/after and must APPROVE it before it runs. Never "
            "commits, pushes, creates or deletes files. Retest afterwards with "
            "security_scan op=retest."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "repo": _STR,
                "path": _STR,
                "old": {
                    **_STR,
                    "description": "Exact current code to replace (must be unique).",
                },
                "new": {**_STR, "description": "The replacement code."},
                "finding_title": _STR,
                "explanation": {
                    **_STR,
                    "description": "Why this change closes the finding.",
                },
            },
            "required": ["repo", "path", "old", "new", "finding_title", "explanation"],
        },
        category="Security Fix",
        provider=FIX_PROVIDER,
        side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
        permissions=ToolPermissions(approval_required=True),
        timeout=30.0,
        method="",
        path="",
        required_auth="",
        origin="secaudit|local",
        trusted=True,
    )


def layered_registry(
    base: ToolRegistry | None, extra: list[ToolDefinition]
) -> ToolRegistry:
    """A per-request registry: `base`'s tools + `extra`; the shared one is untouched."""
    registry = ToolRegistry()
    if base is not None:
        for tool in base.list():
            registry.register(tool)
        for provider in {t.provider for t in base.list()}:
            components = base.components_for(provider)
            if components:
                registry.replace_provider(
                    provider,
                    [t for t in base.list() if t.provider == provider],
                    components,
                )
    registry.replace_provider(FIX_PROVIDER, extra)
    return registry


class SecurityFixAdapter:
    """Executes an APPROVED fix; builds the preview shown on the approval card."""

    def __init__(self, state: SecurityTurn) -> None:
        self._state = state

    async def build_preview(
        self, tool: ToolDefinition, args: dict, *, ttl_ms: int
    ) -> dict:
        old, _ = secrets.redact_text(str(args.get("old") or ""))
        new, _ = secrets.redact_text(str(args.get("new") or ""))
        title, _ = secrets.redact_text(
            str(args.get("finding_title") or "security finding")
        )
        why, _ = secrets.redact_text(str(args.get("explanation") or ""))
        path = str(args.get("path") or "")
        return {
            "tool_id": tool.tool_id,
            "action": f"Apply security fix: {title[:120]}",
            "targets": [f"{args.get('repo')}:{path}"],
            "provider": FIX_PROVIDER,
            "before": {},
            "after": {},
            "diff": {path or "file": {"before": old[:2000], "after": new[:2000]}},
            "before_hash": "",
            "reversibility": "reversible",
            "rollback_plan": (
                "Revert the change with git in the repository; nothing is committed."
            ),
            "verification_plan": (
                why[:300] + " — then retest: the flagged code must be gone."
            ).strip(" —"),
            "estimated_cost": {},
            "args_hash": "",
            "expiry_ms": ttl_ms,
        }

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
        idempotency_key: str | None = None,
        user_id: str = "",
        workspace_id: str = "",
    ) -> dict:
        state = self._state
        repo = str(payload.get("repo") or "")
        path = str(payload.get("path") or "")
        try:
            # Authority: the authenticated caller from the execution scope, never args.
            root = state.local.resolve(user_id or state.user_id, repo)
            if user_id and user_id != state.user_id:
                raise local.LocalError("not_authorized", "caller mismatch")
            res = await local.apply_fix(
                root, path, str(payload.get("old") or ""), str(payload.get("new") or "")
            )
        except local.LocalError as e:
            state.fixes.append(
                {"repo": repo, "path": path, "status": "refused", "reason": e.code}
            )
            raise ToolError(
                ToolErrorKind.INVALID_INPUT,
                f"{e.code}: {e.message}",
                tool_id=tool.tool_id,
            ) from None
        state.tracked_cache.pop(repo, None)
        state.fixes.append(
            {
                "repo": repo,
                "path": res["path"],
                "status": "applied",
                "changed_lines": res["changed_lines"],
            }
        )
        diff, _ = secrets.redact_text(res["diff"])
        log.info(
            "secaudit.fix_applied",
            extra={
                "repo": repo,
                "path": res["path"],
                "changed_lines": res["changed_lines"],
            },
        )
        return {
            "data": {
                "status": "applied",
                "path": res["path"],
                "diff": diff[:6000],
                "committed": False,
                "next": "retest with security_scan op=retest",
            }
        }
