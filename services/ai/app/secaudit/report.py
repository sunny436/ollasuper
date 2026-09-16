"""The security turn's recorded state, finding validation and the final report.

THE RULE THIS MODULE ENFORCES: the report is written from what was RECORDED this
turn — which tools ran, what they returned, what failed — never from what the
model says it did. A model can submit findings, but:

  * a finding is `confirmed` only when its evidence snippet is actually present
    in content read this turn (and, for a local file, near the claimed line), and
    it states a source→sink path or reachability;
  * severity cannot exceed the calibration policy (adapted from codex-security's
    severity-policy): high impact only becomes high with high likelihood;
  * repository access, files read, and every stage's outcome come from recorded
    executions; an inaccessible target is BLOCKED, a failed stage or a missing
    submission is INCOMPLETE, and no verdict ever says "secure".
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

from app.secaudit import secrets
from app.secaudit.intent import SecIntent
from app.secaudit.local import LocalAccess

FINGERPRINT_ALGO = "ollasuper-secaudit/v1"
_MAX_READ_CACHE = 8 * 1024 * 1024
_MAX_RENDERED_FINDINGS = 30
GITHUB_PROVIDER = "mcp:github"

_IMPACTS = ("critical", "high", "medium", "low", "unknown")
_LIKELIHOODS = ("high", "medium", "low", "unknown")
_LEVELS = ("critical", "high", "medium", "low", "informational")
_RANK = {lvl: i for i, lvl in enumerate(reversed(_LEVELS))}  # informational=0

# GitHub tools that only ever mutate a repository in ways a security audit must
# never do, whatever the approval state.
_GITHUB_FORBIDDEN = re.compile(
    r"^(?:merge_|delete_)|^(?:update_pull_request_branch|create_repository|fork_repository)$"
)
_GITHUB_FILE_WRITES = frozenset({"create_or_update_file", "push_files"})


def policy_severity(impact: str, likelihood: str) -> str:
    """Codex-security calibration: impact is capped by how likely exploitation is."""
    i = impact if impact in _IMPACTS else "unknown"
    lk = likelihood if likelihood in _LIKELIHOODS else "unknown"
    if i == "critical":
        return {"high": "critical", "low": "medium"}.get(lk, "high")
    if i == "high":
        return {"high": "high", "low": "low"}.get(lk, "medium")
    if i in ("medium", "unknown"):
        return "medium" if lk == "high" else "low"
    return "low"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


_NUMBERED = re.compile(r"^\s*\d+\s*[:|]\s?")


def _snippet_lines(code: str) -> list[str]:
    return [
        _norm(_NUMBERED.sub("", ln)) for ln in (code or "").splitlines() if _norm(ln)
    ]


def _decode_recorded(content: str) -> Any:
    """A durable tool result is the injection-FRAMED JSON the model saw. Recover
    the JSON so its string leaves carry real newlines/quotes, not escapes."""
    for candidate in (content, content[content.find("{") : content.rfind("}") + 1]):
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except ValueError:
            continue
    return content.replace("\\n", "\n").replace('\\"', '"')


def _infer_op(tool_id: str, data: dict) -> str:
    """Which op produced a recorded result. Built-in executions are stored without
    their args, so a resume must read the operation off the result's shape."""
    if data.get("op"):
        return str(data["op"])
    if tool_id == "security_repo":
        for key, op in (
            ("content", "read"),
            ("matches", "grep"),
            ("files", "tree"),
            ("log", "log"),
            ("diff", "diff"),
        ):
            if key in data:
                return op
        return "head"
    if "files_scanned" in data:
        return "secrets"
    if (
        "packages_checked" in data
        or "lockfiles" in data
        or data.get("op") == "dependencies"
    ):
        return "dependencies"
    if "detail" in data and "path" in data:
        return "retest"
    if data and all(isinstance(v, dict) and "status" in v for v in data.values()):
        return "scanners"
    return ""


def _restored_finding(v: dict) -> dict:
    """A validated finding restored from the summary `security_report` returned."""
    return {
        "fingerprint": str(v.get("fingerprint") or ""),
        "title": str(v.get("title") or "Untitled finding"),
        "status": str(v.get("status") or "needs_validation"),
        "reasons": list(v.get("reasons") or []),
        "severity": str(v.get("severity") or "low"),
        "claimed_severity": "",
        "repo": "",
        "commit": "",
        "path": "",
        "start_line": 0,
        "line_verified": False,
        "vulnerability_class": "",
        "cwe": [],
        "owasp": [],
        "source_to_sink": "",
        "control": "",
        "reachability": "",
        "attacker": "",
        "preconditions": "",
        "impact": "unknown",
        "likelihood": "unknown",
        "severity_rationale": "",
        "exploitability": "",
        "remediation": "",
        "counterevidence": "",
        "regression": {"status": "not_run", "detail": "restored from before the pause"},
    }


def fingerprint(repo: str, klass: str, path: str, anchor: str) -> str:
    raw = f"{repo}|{klass.lower()}|{path}|{_norm(anchor).lower()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


@dataclass
class Read:
    source: str  # local | github | inline
    repo: str
    path: str
    text: str  # redacted
    ref: str = ""
    shown: list[tuple[int, int]] = field(default_factory=list)  # local line ranges
    truncated: bool = False
    seq: int = 0


@dataclass
class SecurityTurn:
    intent: SecIntent
    user_id: str
    local: LocalAccess
    read_only: bool
    user_text: str = ""
    github_connected: bool = False
    github_connection_failed: bool = False
    model: str = ""
    route_reason: str = ""
    resumed: bool = False
    osv_enabled: bool = True
    scanner_timeout_s: float = 300.0
    # -- recorded state --------------------------------------------------------
    reads: list[Read] = field(default_factory=list)
    read_bytes: int = 0
    local_access: dict[str, str] = field(default_factory=dict)
    local_heads: dict[str, str] = field(default_factory=dict)
    github_access: dict[str, str] = field(default_factory=dict)
    github_refs: dict[str, str] = field(default_factory=dict)
    created_branches: set[tuple[str, str]] = field(default_factory=set)
    github_writes: list[dict] = field(default_factory=list)
    secret_hits: list[dict] = field(default_factory=list)
    stages: dict[str, dict] = field(default_factory=dict)
    dep_vulns: list[dict] = field(default_factory=list)
    scanner_findings: list[dict] = field(default_factory=list)
    findings: list[dict] = field(default_factory=list)
    submitted: bool = False
    submission_source: dict = field(default_factory=dict)
    scope_summary: str = ""
    fixes: list[dict] = field(default_factory=list)
    retests: dict[tuple[str, str], dict] = field(default_factory=dict)
    denied_calls: list[dict] = field(default_factory=list)
    tracked_cache: dict[str, set[str]] = field(default_factory=dict)
    _seq: int = 0

    # ------------------------------------------------------------ recording
    def _next(self) -> int:
        self._seq += 1
        return self._seq

    def add_read(self, read: Read) -> None:
        if self.read_bytes + len(read.text) > _MAX_READ_CACHE:
            read.text = read.text[: max(0, _MAX_READ_CACHE - self.read_bytes)]
            read.truncated = True
        read.seq = self._next()
        self.read_bytes += len(read.text)
        # One entry per (source, repo, path, ref) AND content version: line ranges
        # of the same content accumulate, but a changed file (re-read after a
        # fix) is a NEW version — evidence read before the change must still
        # validate against what was actually read then.
        for r in self.reads:
            if (r.source, r.repo, r.path, r.ref) == (
                read.source,
                read.repo,
                read.path,
                read.ref,
            ) and (not read.text or read.text == r.text):
                r.shown.extend(read.shown)
                r.truncated = r.truncated or read.truncated
                r.seq = read.seq
                return
        self.reads.append(read)

    def note_secret_hits(
        self, source: str, repo: str, path: str, hits: list[dict]
    ) -> None:
        seen = {(h["repo"], h["path"], h["fp"]) for h in self.secret_hits}
        for h in hits:
            key = (repo, path or h.get("path", ""), h["fp"])
            if key in seen:
                continue
            seen.add(key)
            self.secret_hits.append(
                {
                    "source": source,
                    "repo": repo,
                    "path": key[1],
                    "line": h.get("line", 0),
                    "rule": h["rule"],
                    "fp": h["fp"],
                }
            )

    def set_stage(self, name: str, status: str, **detail: Any) -> None:
        self.stages[name] = {"status": status, **detail}

    # ------------------------------------------------------- registry results
    @staticmethod
    def _repo_of(args: dict) -> str:
        owner, repo = str(args.get("owner") or ""), str(args.get("repo") or "")
        if owner and repo:
            return f"{owner}/{repo}".lower()
        full = str(args.get("repository") or args.get("full_name") or "")
        return full.lower() if "/" in full else ""

    @staticmethod
    def _text_leaves(obj: Any) -> str:
        parts: list[str] = []

        def walk(o: Any) -> None:
            if isinstance(o, str):
                parts.append(o)
            elif isinstance(o, dict):
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        walk(obj)
        return "\n".join(parts)

    @staticmethod
    def _access_from_error(text: str) -> str:
        t = text.lower()
        if re.search(r"\b404\b|not found|could not resolve to a repository", t):
            return "not_found"
        if re.search(
            r"\b40[13]\b|forbidden|resource not accessible|permission|bad credentials|"
            r"requires authentication|saml|access restrictions",
            t,
        ):
            return "denied"
        return "error"

    def observe_registry(
        self,
        tool_id: str,
        tool_name: str,
        args: dict,
        data: Any,
        *,
        error: Any = None,
        is_error: bool = False,
        truncated: bool = False,
    ) -> None:
        """One MCP/Ollagraph result, already redacted. Only GitHub shapes matter."""
        if not tool_id.startswith(GITHUB_PROVIDER + ":"):
            return
        repo = self._repo_of(args)
        ok = error is None and not is_error
        text = self._text_leaves(data if ok else (data if data is not None else error))
        if repo:
            status = "verified" if ok else self._access_from_error(text)
            prior = self.github_access.get(repo)
            if prior != "verified":
                self.github_access[repo] = status
        if not ok:
            return
        name = tool_name
        if name == "create_branch" and repo and args.get("branch"):
            self.created_branches.add((repo, str(args["branch"])))
            return
        if name in _GITHUB_FILE_WRITES and repo:
            self.github_writes.append(
                {
                    "repo": repo,
                    "branch": str(args.get("branch") or ""),
                    "path": str(args.get("path") or ""),
                    "seq": self._next(),
                }
            )
            return
        ref = str(args.get("ref") or args.get("sha") or args.get("branch") or "")
        if repo and ref and "sha" in args:
            self.github_refs.setdefault(repo, ref)
        path = str(args.get("path") or "")
        self.add_read(
            Read(
                source="github",
                repo=repo,
                path=path,
                text=text,
                ref=ref,
                truncated=truncated,
            )
        )

    def seed_from_completed(self, completed: list[Any]) -> None:
        """Approval/crash resume: earlier tools come back as recorded results.

        Every security tool's recorded result is restored — GitHub reads, local
        reads/scans (access, commit, shown lines, stages, secret hits) and the last
        submitted report — so a resumed turn's verdict covers the WHOLE turn, not
        only what ran after the pause."""
        reports: list[dict] = []
        for ct in completed or []:
            tool_id = str(getattr(ct, "toolId", "") or "")
            args = getattr(ct, "args", {}) or {}
            content = str(getattr(ct, "resultContent", "") or "")
            content, _ = secrets.redact_text(content)
            if tool_id.startswith(GITHUB_PROVIDER + ":"):
                name = tool_id.split(":", 2)[-1]
                self.resumed = True
                err = '"is_error": true' in content or '"status": "error"' in content
                data = _decode_recorded(content)
                self.observe_registry(
                    tool_id,
                    name,
                    args,
                    None if err else data,
                    error=data if err else None,
                )
            elif tool_id in ("security_repo", "security_scan", "security_report"):
                self.resumed = True
                data = _decode_recorded(content)
                if isinstance(data, dict) and data.get("status") != "error":
                    if tool_id == "security_report":
                        reports.append((args, data))
                    else:
                        self._seed_local(tool_id, args, data)
        # A report submitted before the pause is re-validated against the reads
        # restored above (a later report in this attempt replaces it). Built-in
        # executions are recorded WITHOUT their args, so when the findings are not
        # available the validated summary the tool returned is restored as-is.
        for args, data in reports[-1:]:
            if args.get("findings"):
                self.validate(
                    args.get("source") or {},
                    str(args.get("scope_summary") or ""),
                    args.get("findings") or [],
                )
            else:
                self.submitted = True
                self.findings = [
                    _restored_finding(v) for v in data.get("validated") or []
                ]

    def _seed_local(self, tool_id: str, args: dict, data: dict) -> None:
        """Restore one recorded local-repository result (security_repo / _scan)."""
        repo = str(args.get("repo") or data.get("repo") or "")
        if not repo:
            return
        self.local_access.setdefault(repo, "verified")
        if data.get("commit"):
            self.local_heads.setdefault(repo, str(data["commit"]))
        op = str(args.get("op") or "") or _infer_op(tool_id, data)
        if tool_id == "security_repo":
            if op == "read" and data.get("path"):
                lines: dict[int, str] = {}
                for row in str(data.get("content") or "").splitlines():
                    m = re.match(r"^(\d+): ?(.*)$", row)
                    if m:
                        lines[int(m.group(1))] = m.group(2)
                if lines:
                    top = max(lines)
                    self.add_read(
                        Read(
                            source="local",
                            repo=repo,
                            path=str(data["path"]),
                            text="\n".join(lines.get(i, "") for i in range(1, top + 1)),
                            shown=[(min(lines), top)],
                            truncated=data.get("next_line") is not None,
                        )
                    )
            elif op in ("tree", "grep", "log", "diff"):
                self.add_read(
                    Read(
                        source="local",
                        repo=repo,
                        path="",
                        text=json.dumps(data)[:200_000],
                    )
                )
            return
        status = str(data.get("status") or "")
        if op == "secrets" and status:
            self.note_secret_hits("local", repo, "", data.get("hits") or [])
            self.set_stage(
                "secret_scan",
                status,
                repo=repo,
                files=data.get("files_scanned"),
                truncated=data.get("truncated") or None,
            )
        elif op == "dependencies" and status:
            self.dep_vulns = data.get("vulnerable") or self.dep_vulns
            self.set_stage(
                "dependency_audit",
                status,
                repo=repo,
                packages=data.get("packages_checked"),
                vulnerable=len(data.get("vulnerable") or []) or None,
            )
        elif op == "scanners":
            for name, r in data.items():
                if isinstance(r, dict) and r.get("status"):
                    self.set_stage(f"sast:{name}", str(r["status"]))
        elif op == "retest" and data.get("path"):
            self.retests[(repo, str(data["path"]))] = {
                "status": status or "not_run",
                "detail": str(data.get("detail") or ""),
            }

    # ------------------------------------------------------------ hard guards
    def refuse(self, tool: Any) -> str | None:
        """Deterministic refusals, checked before approval. None = not refused."""
        raw_side = getattr(tool, "side_effect", "")
        side = str(getattr(raw_side, "value", raw_side) or "")
        tool_id = str(getattr(tool, "tool_id", "") or "")
        name = str(getattr(tool, "name", "") or "")
        if self.read_only and side != "read_only":
            return (
                "security audits are read-only; ask explicitly for a fix to change "
                "anything"
            )
        if tool_id.startswith(GITHUB_PROVIDER + ":") and _GITHUB_FORBIDDEN.search(name):
            return (
                "merging, deleting, forking or creating repositories is never "
                "done by a security audit"
            )
        return None

    def refuse_args(self, tool: Any, args: dict) -> str | None:
        reason = self.refuse(tool)
        if reason:
            return reason
        tool_id = str(getattr(tool, "tool_id", "") or "")
        name = str(getattr(tool, "name", "") or "")
        if tool_id.startswith(GITHUB_PROVIDER + ":") and name in _GITHUB_FILE_WRITES:
            key = (self._repo_of(args), str(args.get("branch") or ""))
            if key not in self.created_branches:
                return (
                    "a security fix is written only to a new branch created in this "
                    "turn (create_branch first), never to an existing or default branch"
                )
        return None

    # ------------------------------------------------------ finding validation
    def _find_evidence(self, repo: str, path: str, code: str, line: int) -> dict:
        lines = _snippet_lines(code)
        if not lines or len("".join(lines)) < 8:
            return {"found": False, "reason": "evidence snippet is empty or too short"}
        anchor = lines[0]
        whole = " ".join(lines)
        candidates = [
            r
            for r in self.reads
            if (not repo or r.repo.lower() == repo.lower() or r.source == "inline")
            and (not path or not r.path or r.path == path)
        ]
        if self.user_text and _norm(whole) in _norm(self.user_text):
            return {"found": True, "line_verified": False, "source": "inline"}
        for r in candidates:
            if r.source == "local" and r.path:
                file_lines = r.text.splitlines()
                for i, fl in enumerate(file_lines, 1):
                    if anchor not in _norm(fl):
                        continue
                    window = _norm(" ".join(file_lines[i - 1 : i - 1 + len(lines) + 3]))
                    if whole not in window:
                        continue
                    shown = any(a - 3 <= i <= b + 3 for a, b in r.shown)
                    near = not line or abs(i - line) <= 3
                    if shown and near:
                        return {
                            "found": True,
                            "line_verified": True,
                            "line": i,
                            "source": "local",
                        }
                continue
            if whole in _norm(r.text):
                return {"found": True, "line_verified": False, "source": r.source}
        return {
            "found": False,
            "reason": "evidence not found in content read this turn",
        }

    def validate(self, source: dict, scope_summary: str, raw: list[dict]) -> list[dict]:
        self.submitted = True
        self.submission_source = {
            "kind": str(source.get("kind") or "")[:20],
            "repo": str(source.get("repo") or "")[:200],
            "ref": str(source.get("ref") or "")[:100],
        }
        self.scope_summary = secrets.redact_text(str(scope_summary or "")[:1000])[0]
        repo = self.submission_source["repo"]
        out: dict[str, dict] = {}
        for f in (raw or [])[:100]:
            f, _ = secrets.redact_obj(f if isinstance(f, dict) else {})
            path = str(f.get("path") or "")[:400]
            line = (
                int(f.get("start_line") or 0)
                if str(f.get("start_line") or "").isdigit()
                else 0
            )
            cwe = [str(c)[:20] for c in (f.get("cwe") or []) if c][:5]
            klass = str(f.get("vulnerability_class") or "")[:80]
            evidence = [e for e in (f.get("evidence") or []) if isinstance(e, dict)][:5]
            reasons: list[str] = []
            ev_result = {"found": False, "reason": "no code evidence supplied"}
            anchor = ""
            for e in evidence:
                code = str(e.get("code") or "")
                anchor = anchor or (_snippet_lines(code) or [""])[0]
                e_line = (
                    int(e.get("start_line") or 0)
                    if str(e.get("start_line") or "").isdigit()
                    else line
                )
                ev_result = self._find_evidence(
                    repo, str(e.get("path") or path), code, e_line
                )
                if ev_result.get("found"):
                    break
            dataflow = _norm(str(f.get("source_to_sink") or ""))
            reach = _norm(str(f.get("reachability") or ""))
            claimed = str(f.get("status") or "").lower()
            counter = _norm(str(f.get("counterevidence") or ""))
            if claimed == "rejected":
                status = "rejected" if counter else "needs_validation"
                if not counter:
                    reasons.append("rejection needs counterevidence")
            elif ev_result.get("found") and (dataflow or reach):
                status = (
                    "confirmed" if claimed != "needs_validation" else "needs_validation"
                )
            else:
                status = "needs_validation"
                if not ev_result.get("found"):
                    reasons.append(str(ev_result.get("reason")))
                if not (dataflow or reach):
                    reasons.append("no source→sink path or reachability given")
            impact = str(f.get("impact") or "unknown").lower()
            likelihood = str(f.get("likelihood") or "unknown").lower()
            policy = policy_severity(impact, likelihood)
            claimed_sev = str(f.get("severity") or "").lower()
            severity = policy
            if claimed_sev in _RANK and _RANK[claimed_sev] < _RANK[policy]:
                severity = claimed_sev  # a model may rate LOWER, never higher
            fp = fingerprint(
                repo,
                (cwe[0] if cwe else klass) or "finding",
                path,
                anchor or str(f.get("title") or ""),
            )
            retest = self.retests.get((repo, path)) or self._github_retest(
                repo, path, evidence
            )
            out[fp] = {
                "fingerprint": fp,
                "title": _norm(str(f.get("title") or "Untitled finding"))[:160],
                "status": status,
                "reasons": reasons,
                "repo": repo,
                "commit": self.local_heads.get(repo)
                or self.github_refs.get(repo.lower(), "")
                or self.submission_source["ref"],
                "path": path,
                "start_line": ev_result.get("line") or line,
                "line_verified": bool(ev_result.get("line_verified")),
                "vulnerability_class": klass,
                "cwe": cwe,
                "owasp": [str(o)[:30] for o in (f.get("owasp") or []) if o][:3],
                "source_to_sink": dataflow[:400],
                "control": _norm(str(f.get("control") or ""))[:300],
                "reachability": reach[:300],
                "attacker": _norm(str(f.get("attacker") or ""))[:200],
                "preconditions": _norm(str(f.get("preconditions") or ""))[:200],
                "impact": impact,
                "likelihood": likelihood,
                "severity": severity,
                "claimed_severity": claimed_sev,
                "severity_rationale": _norm(str(f.get("severity_rationale") or ""))[
                    :300
                ],
                "exploitability": _norm(str(f.get("exploitability") or ""))[:300],
                "remediation": _norm(str(f.get("remediation") or ""))[:400],
                "counterevidence": counter[:300],
                "regression": retest or {"status": "not_run"},
            }
        order = {"confirmed": 0, "needs_validation": 1, "rejected": 2}
        self.findings = sorted(
            out.values(),
            key=lambda x: (order[x["status"]], -_RANK.get(x["severity"], 0)),
        )
        return self.findings

    def _github_retest(self, repo: str, path: str, evidence: list[dict]) -> dict | None:
        writes = [
            w
            for w in self.github_writes
            if w["repo"] == repo.lower() and (not w["path"] or w["path"] == path)
        ]
        if not writes:
            return None
        last_write = max(w["seq"] for w in writes)
        branches = {w["branch"] for w in writes}
        later = [
            r
            for r in self.reads
            if r.source == "github"
            and r.repo == repo.lower()
            and r.path == path
            and r.ref in branches
            and r.seq > last_write
        ]
        if not later:
            return {"status": "not_run", "detail": "patched file was not re-read"}
        text = _norm(later[-1].text)
        gone = all(
            " ".join(_snippet_lines(str(e.get("code") or ""))) not in text
            for e in evidence
        )
        return {
            "status": "passed" if gone else "failed",
            "detail": "flagged evidence absent after the fix"
            if gone
            else "flagged evidence still present",
        }

    # ------------------------------------------------------------------ report
    def _targets(self) -> dict[str, str]:
        t: dict[str, str] = {}
        for k, v in self.local_access.items():
            t[f"local:{k}"] = v
        for k, v in self.github_access.items():
            t[f"github:{k}"] = v
        return t

    def verdict(self, *, deadline: bool) -> tuple[str, list[str]]:
        why: list[str] = []
        targets = self._targets()
        verified = [k for k, v in targets.items() if v == "verified"]
        inline = (
            any(f.get("status") != "rejected" for f in self.findings) and not targets
        )
        wanted = self.submission_source.get("repo", "")
        if not verified and not inline:
            if not targets:
                why.append("no repository content was accessed this turn")
            for k, v in targets.items():
                why.append(f"{k}: {v}")
            if (
                wanted
                and self.submission_source.get("kind") == "github"
                and not self.github_connected
            ):
                why.append("GitHub is not connected for this account")
            return "BLOCKED", why
        failed = [k for k, s in self.stages.items() if s.get("status") == "failed"]
        blocked_targets = [k for k, v in targets.items() if v != "verified"]
        if deadline:
            why.append("the turn hit its time limit before finishing")
        if failed:
            why.append("failed stages: " + ", ".join(sorted(failed)))
        if blocked_targets:
            why.append(
                "inaccessible targets: "
                + ", ".join(f"{k} ({targets[k]})" for k in blocked_targets)
            )
        if not self.submitted:
            why.append(
                "no findings were submitted for validation "
                "(security_report was not called)"
            )
        if why:
            return "INCOMPLETE", why
        live = [f for f in self.findings if f["status"] != "rejected"]
        if live or self.secret_hits or self.dep_vulns or self.scanner_findings:
            return "FINDINGS", why
        return "NO CONFIRMED FINDINGS IN SCANNED SCOPE", why

    def render(
        self, *, deadline: bool = False, answered_by: str = "", tier: int | None = None
    ) -> str:
        verdict, why = self.verdict(deadline=deadline)
        L: list[str] = [
            "",
            "",
            "---",
            "",
            "## Security audit report (system-validated)",
            "",
        ]
        L.append(f"**Verdict: {verdict}**" + (f" — {'; '.join(why)}" if why else ""))
        if verdict == "NO CONFIRMED FINDINGS IN SCANNED SCOPE":
            L.append("")
            L.append(
                "_This is not a statement that the code is secure: it covers "
                "only the scope and stages listed below._"
            )
        L += ["", "### Scope and access"]
        for k, v in self._targets().items() or {"(none)": "not_attempted"}.items():
            head = ""
            if k.startswith("local:"):
                head = self.local_heads.get(k[6:], "")
            elif k.startswith("github:"):
                head = self.github_refs.get(k[7:], "")
            L.append(
                f"- `{k}` — access **{v}**" + (f" @ `{head[:12]}`" if head else "")
            )
        if self.scope_summary:
            L.append(f"- Declared scope: {self.scope_summary}")
        versions = [r for r in self.reads if r.path and r.source != "inline"]
        files = list({(r.source, r.repo, r.path): r for r in versions}.values())
        partial = [r for r in files if r.truncated]
        L.append(
            f"- Content read this turn: {len(files)} file(s)"
            + (f", {len(partial)} truncated/partial" if partial else "")
            + (
                f"; {sum(1 for r in self.reads if not r.path)} "
                "listing/diff/search result(s)"
                if any(not r.path for r in self.reads)
                else ""
            )
        )
        if self.resumed:
            L.append(
                "- Resumed after approval: earlier tool results were restored "
                "from the durable record."
            )
        model_line = answered_by or self.model
        if model_line:
            floor = (
                " — reasoning floor NOT met (the complex model was unavailable)"
                if "floor_unmet" in self.route_reason
                else ""
            )
            L.append(
                f"- Model: `{model_line}`"
                + (f" (tier {tier})" if tier is not None else "")
                + floor
            )
        L += ["", "### Stages"]
        L.append(
            f"- Source review (model): {'ran' if files or self.reads else 'not_run'}"
        )
        if not self.stages:
            L.append("- Deterministic scanners: not_run")
        for name, st in sorted(self.stages.items()):
            if name == "resumed_tools":
                continue
            extra = {k: v for k, v in st.items() if k not in ("status", "findings")}
            detail = ", ".join(
                f"{k}={v}" for k, v in extra.items() if v not in (None, "", [], {})
            )
            L.append(
                f"- {name}: **{st.get('status')}**" + (f" ({detail})" if detail else "")
            )
        L.append(f"- Finding validation: {'ran' if self.submitted else 'not_run'}")

        live = [f for f in self.findings if f["status"] != "rejected"]
        rejected = [f for f in self.findings if f["status"] == "rejected"]
        conf = sum(1 for f in live if f["status"] == "confirmed")
        L += [
            "",
            f"### Findings — {conf} confirmed, {len(live) - conf} need "
            f"validation, {len(rejected)} rejected",
        ]
        if not self.findings:
            L.append("- None submitted." if not self.submitted else "- None.")
        for f in live[:_MAX_RENDERED_FINDINGS]:
            loc = f"{f['path']}:{f['start_line']}" if f["path"] else "(no location)"
            tags = (
                ", ".join([*f["cwe"], *f["owasp"]])
                or f["vulnerability_class"]
                or "unclassified"
            )
            sev = f["severity"].upper()
            if f["claimed_severity"] and f["claimed_severity"] != f["severity"]:
                sev += f" (claimed {f['claimed_severity']}, set by policy)"
            L.append("")
            L.append(f"**[{sev}] {f['title']}** — `{f['status']}`")
            L.append(
                f"- Fingerprint `{f['fingerprint']}` ({FINGERPRINT_ALGO}) · "
                f"`{f['repo'] or 'inline'}`"
                + (f"@`{str(f['commit'])[:12]}`" if f["commit"] else "")
                + f" · `{loc}`"
                + ("" if f["line_verified"] else " (line not verified)")
            )
            L.append(f"- Class: {tags}")
            if f["source_to_sink"] or f["control"]:
                L.append(
                    f"- Source → control → sink: {f['source_to_sink'] or '—'}"
                    + (f" | control: {f['control']}" if f["control"] else "")
                )
            if f["reachability"] or f["attacker"]:
                L.append(
                    f"- Reachability: {f['reachability'] or '—'}"
                    + (f" | attacker: {f['attacker']}" if f["attacker"] else "")
                )
            L.append(
                f"- Impact {f['impact']} × likelihood {f['likelihood']}"
                + (f" — {f['severity_rationale']}" if f["severity_rationale"] else "")
            )
            if f["exploitability"]:
                L.append(f"- Exploitability: {f['exploitability']}")
            if f["reasons"]:
                L.append(f"- Not confirmed because: {'; '.join(f['reasons'])}")
            if f["remediation"]:
                L.append(f"- Remediation: {f['remediation']}")
            reg = f["regression"]
            L.append(
                f"- Fix retest: **{reg.get('status')}**"
                + (f" — {reg.get('detail')}" if reg.get("detail") else "")
            )
        if len(live) > _MAX_RENDERED_FINDINGS:
            L.append("")
            L.append(
                "Also recorded: "
                + "; ".join(
                    f"`{f['fingerprint']}` {f['title']}"
                    for f in live[_MAX_RENDERED_FINDINGS:]
                )
            )
        if rejected:
            L.append("")
            L.append(
                "Rejected (with counterevidence): "
                + "; ".join(
                    f"`{f['fingerprint']}` {f['title']} — {f['counterevidence']}"
                    for f in rejected[:15]
                )
            )
        if self.secret_hits:
            L += [
                "",
                f"### Secrets detected — {len(self.secret_hits)} (rule-based; "
                "values redacted; validity not verified)",
            ]
            for h in self.secret_hits[:40]:
                L.append(
                    f"- `{h['rule']}` fp `{h['fp']}` at "
                    f"`{h['repo']}:{h['path']}:{h['line']}` — rotate if real"
                )
            if len(self.secret_hits) > 40:
                L.append(f"- … {len(self.secret_hits) - 40} more")
        if self.dep_vulns:
            L += [
                "",
                f"### Known-vulnerable dependency versions — {len(self.dep_vulns)} "
                "(OSV; reachability not validated)",
            ]
            for v in self.dep_vulns[:30]:
                det = v.get("details") or {}
                ids = ", ".join(
                    i
                    + (
                        f" ({det[i]['severity']})"
                        if det.get(i, {}).get("severity")
                        else ""
                    )
                    for i in v["ids"][:4]
                )
                fixed = sorted({x for d in det.values() for x in d.get("fixed", [])})
                L.append(
                    f"- {v['ecosystem']} `{v['name']}@{v['version']}` — {ids}"
                    + (f"; fixed in {', '.join(fixed[:3])}" if fixed else "")
                )
        if self.scanner_findings:
            L += [
                "",
                f"### Scanner-reported (unvalidated) — {len(self.scanner_findings)}",
            ]
            for s in self.scanner_findings[:30]:
                L.append(
                    f"- {s['tool']} `{s['rule']}` {s['path']}:{s['line']} — "
                    f"{s['message']}"
                )
        if self.denied_calls:
            L += ["", "### Blocked actions"]
            for d in self.denied_calls[:10]:
                L.append(f"- `{d['tool']}` — {d['reason']}")
        L += ["", "### Limitations"]
        lim = [
            "Secret detection is rule-based: shapeless secrets can be missed, and "
            "detected values are not tested for validity.",
            "The narrative above is model-written; this block is the "
            "system-validated record.",
        ]
        if self.stages.get("dependency_audit", {}).get("status") == "ran":
            lim.append(
                "Dependency names and versions were sent to api.osv.dev for the "
                "dependency audit."
            )
        if any(k.startswith("github:") for k in self._targets()):
            lim.append(
                "GitHub sources: no dependency/SAST scanners run (no local "
                "checkout); files larger than the tool result limit are partial."
            )
        not_inst = [
            k for k, s in self.stages.items() if s.get("status") == "not_installed"
        ]
        if not_inst:
            lim.append(
                "Not installed on this host (not run): "
                + ", ".join(sorted(not_inst))
                + "."
            )
        if any(f["regression"].get("status") == "passed" for f in self.findings):
            lim.append(
                "A passed fix retest means the flagged code and secret patterns "
                "are gone; the project's own test suite was not run."
            )
        L += [f"- {x}" for x in lim]
        text, _ = secrets.redact_text("\n".join(L) + "\n")
        return text


def as_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)
