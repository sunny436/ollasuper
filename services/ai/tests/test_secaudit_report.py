"""The report is written from recorded state: validation, severity, coverage,
verdicts — and nothing a model says can turn a gap into a clean result."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.secaudit import scanners
from app.secaudit.intent import detect
from app.secaudit.local import LocalAccess
from app.secaudit.report import Read, SecurityTurn, fingerprint, policy_severity
from app.secaudit.tool import run_security_tool
from qa.secaudit_fixture import build, planted

pytestmark = pytest.mark.anyio

SQLI = 'query = "SELECT id, email FROM users WHERE name = \'" + name + "\'"'


def _state(**kw) -> SecurityTurn:
    base = dict(
        intent=detect("security audit of the fixture repo"),
        user_id="u1",
        local=LocalAccess(),
        read_only=True,
    )
    base.update(kw)
    return SecurityTurn(**base)


def _app_read(state: SecurityTurn, shown=(1, 40)) -> None:
    from qa.secaudit_fixture import APP_PY

    state.local_access["fixture"] = "verified"
    state.local_heads["fixture"] = "a" * 40
    state.add_read(
        Read(source="local", repo="fixture", path="app.py", text=APP_PY, shown=[shown])
    )


def _finding(**kw) -> dict:
    f = {
        "title": "SQL injection in /users",
        "status": "confirmed",
        "vulnerability_class": "sql injection",
        "cwe": ["CWE-89"],
        "owasp": ["A03:2021"],
        "path": "app.py",
        "start_line": 15,
        "evidence": [{"path": "app.py", "start_line": 15, "code": SQLI}],
        "source_to_sink": "request.args name -> string concat -> db.execute",
        "reachability": "unauthenticated GET /users",
        "impact": "high",
        "likelihood": "high",
        "severity": "critical",
        "remediation": "use a bound parameter",
    }
    f.update(kw)
    return f


# ------------------------------------------------------------ validation
def test_evidence_that_was_read_confirms_and_severity_is_capped_by_policy():
    s = _state()
    _app_read(s)
    [f] = s.validate({"kind": "local", "repo": "fixture"}, "app.py", [_finding()])
    assert f["status"] == "confirmed" and f["line_verified"] and f["start_line"] == 15
    # the model said critical; high impact x high likelihood is HIGH by policy
    assert f["severity"] == "high" and f["claimed_severity"] == "critical"
    assert f["commit"] == "a" * 40


def test_evidence_never_read_cannot_be_confirmed():
    s = _state()
    _app_read(s)
    invented = _finding(
        evidence=[{"path": "app.py", "code": "os.system(request.args['cmd'])"}]
    )
    [f] = s.validate({"kind": "local", "repo": "fixture"}, "", [invented])
    assert f["status"] == "needs_validation"
    assert any("not found" in r for r in f["reasons"])


def test_evidence_outside_the_lines_actually_shown_is_not_line_verified():
    s = _state()
    _app_read(s, shown=(30, 40))  # the SQLi line (15) was never shown
    [f] = s.validate({"kind": "local", "repo": "fixture"}, "", [_finding()])
    assert f["status"] == "needs_validation"


def test_no_dataflow_or_unsupported_rejection_needs_validation():
    s = _state()
    _app_read(s)
    a, b = s.validate(
        {"kind": "local", "repo": "fixture"},
        "",
        [
            _finding(source_to_sink="", reachability=""),
            _finding(title="Maybe XSS", status="rejected", cwe=["CWE-79"]),
        ],
    )
    assert {a["status"], b["status"]} == {"needs_validation"}


@pytest.mark.parametrize(
    ("impact", "likelihood", "want"),
    [
        ("critical", "high", "critical"),
        ("critical", "unknown", "high"),
        ("high", "high", "high"),
        ("high", "medium", "medium"),
        ("high", "low", "low"),
        ("medium", "high", "medium"),
        ("medium", "medium", "low"),
        ("unknown", "unknown", "low"),
        ("low", "high", "low"),
    ],
)
def test_the_codex_severity_calibration(impact, likelihood, want):
    assert policy_severity(impact, likelihood) == want


def test_fingerprints_survive_a_line_shift_and_differ_per_location():
    a = fingerprint("fixture", "CWE-89", "app.py", "  rows = db.execute(x)")
    b = fingerprint("fixture", "cwe-89", "app.py", "rows   =  db.execute(x)")
    c = fingerprint("fixture", "CWE-89", "other.py", "rows = db.execute(x)")
    assert a == b != c


# ------------------------------------------------------------ verdicts
def test_nothing_accessed_is_blocked_never_clean():
    s = _state()
    s.validate({"kind": "github", "repo": "acme/app"}, "", [])
    verdict, why = s.verdict(deadline=False)
    assert verdict == "BLOCKED"
    text = s.render()
    assert "Verdict: BLOCKED" in text and "secure" not in text.split("Limitations")[
        0
    ].lower().replace("not a statement that the code is secure", "")


@pytest.mark.parametrize("status", ["not_found", "denied"])
def test_an_inaccessible_github_repository_is_blocked(status):
    s = _state(github_connected=True)
    s.github_access["acme/private"] = status
    s.validate({"kind": "github", "repo": "acme/private"}, "", [])
    verdict, why = s.verdict(deadline=False)
    assert verdict == "BLOCKED" and any(status in w for w in why)


def test_github_not_connected_is_named():
    s = _state(github_connected=False)
    s.validate({"kind": "github", "repo": "acme/app"}, "", [])
    verdict, why = s.verdict(deadline=False)
    assert verdict == "BLOCKED" and any("not connected" in w for w in why)


def test_a_failed_stage_or_a_missing_submission_is_incomplete_not_clean():
    s = _state()
    _app_read(s)
    s.set_stage("dependency_audit", "failed", reason="ConnectError")
    s.validate({"kind": "local", "repo": "fixture"}, "", [])
    assert s.verdict(deadline=False)[0] == "INCOMPLETE"
    s2 = _state()
    _app_read(s2)  # read, but the model never submitted anything
    assert s2.verdict(deadline=False)[0] == "INCOMPLETE"
    s3 = _state()
    _app_read(s3)
    s3.validate({"kind": "local", "repo": "fixture"}, "", [])
    assert s3.verdict(deadline=True)[0] == "INCOMPLETE"


def test_not_installed_scanners_are_a_listed_limitation_and_clean_is_scoped():
    s = _state()
    _app_read(s)
    s.set_stage("sast:semgrep", "not_installed")
    s.validate({"kind": "local", "repo": "fixture"}, "app.py only", [])
    verdict, _ = s.verdict(deadline=False)
    assert verdict == "NO CONFIRMED FINDINGS IN SCANNED SCOPE"
    text = s.render()
    assert "not a statement that the code is secure" in text
    assert "Not installed on this host (not run): sast:semgrep" in text


def test_the_rendered_report_never_contains_a_secret_value():
    s = _state()
    _app_read(s)
    token = planted()["github_token"]
    s.validate(
        {"kind": "local", "repo": "fixture"},
        f"scope includes {token}",
        [_finding(remediation=f"rotate {token}", title=f"leak {token}")],
    )
    text = s.render()
    assert token not in text and "[REDACTED:github-token" in text


def test_resume_seeds_access_and_reads_from_completed_tools():
    s = _state(github_connected=True)
    ok = SimpleNamespace(
        toolId="mcp:github:get_file_contents",
        args={"owner": "Acme", "repo": "App", "path": "app.py"},
        resultContent=json.dumps({"result": {"content": [{"text": SQLI}]}}),
    )
    s.seed_from_completed([ok])
    assert s.github_access == {"acme/app": "verified"} and s.resumed
    [f] = s.validate(
        {"kind": "github", "repo": "acme/app"},
        "",
        [_finding(evidence=[{"path": "app.py", "code": SQLI}])],
    )
    assert f["status"] == "confirmed" and not f["line_verified"]


# ------------------------------------------------------------ deterministic stages
async def test_the_dependency_audit_records_real_results_and_failures(tmp_path):
    repo = tmp_path / "fixture"
    build(repo)

    def osv(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/querybatch"):
            queries = json.loads(request.content)["queries"]
            results = [
                {"vulns": [{"id": "GHSA-TEST-0001"}]}
                if q["package"]["name"] == "requests"
                else {}
                for q in queries
            ]
            return httpx.Response(200, json={"results": results})
        return httpx.Response(
            200,
            json={
                "summary": "leaks auth headers",
                "database_specific": {"severity": "HIGH"},
                "affected": [{"ranges": [{"events": [{"fixed": "2.20.0"}]}]}],
            },
        )

    packages = [
        (e, n, v, "requirements.txt")
        for e, n, v in scanners.parse_lockfile(
            "requirements.txt", (repo / "requirements.txt").read_text()
        )
    ]
    res = await scanners.osv_audit(packages, transport=httpx.MockTransport(osv))
    assert res["packages_checked"] == 3
    [v] = res["vulnerable"]
    assert v["name"] == "requests" and v["details"]["GHSA-TEST-0001"]["fixed"] == [
        "2.20.0"
    ]

    def down(request):
        raise httpx.ConnectError("no route")

    with pytest.raises(httpx.ConnectError):
        await scanners.osv_audit(packages, transport=httpx.MockTransport(down))


def test_lockfile_parsers_read_the_real_formats():
    uv_lock = (
        '[[package]]\nname = "httpx"\nversion = "0.28.1"\n'
        'source = { registry = "https://pypi.org/simple" }\n\n'
        '[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n'
    )
    assert scanners.parse_lockfile("uv.lock", uv_lock) == [("PyPI", "httpx", "0.28.1")]
    bun_lock = (
        '{\n  "packages": {\n'
        '    "zod": ["zod@3.23.8", "", {}, "sha512-x"],\n'
        '    "@v1/ui": ["@v1/ui@workspace:packages/ui"],\n'
        '    "@radix-ui/react-slot": ["@radix-ui/react-slot@1.1.0", "", {}, "sha512-y"],\n'  # noqa: E501
        "  }\n}\n"
    )
    assert scanners.parse_lockfile("bun.lock", bun_lock) == [
        ("npm", "zod", "3.23.8"),
        ("npm", "@radix-ui/react-slot", "1.1.0"),
    ]
    pkg_lock = json.dumps(
        {"packages": {"": {}, "node_modules/a/node_modules/b": {"version": "1.0.0"}}}
    )
    assert scanners.parse_lockfile("package-lock.json", pkg_lock) == [
        ("npm", "b", "1.0.0")
    ]


async def test_retest_passes_only_when_the_flagged_code_is_gone(tmp_path):
    repo = tmp_path / "fixture"
    build(repo)

    class S:
        ai_security_local_roots = json.dumps({"fixture": str(repo)})
        ai_security_local_user_ids = "u1"

    state = _state(local=LocalAccess.from_settings(S()), read_only=False)
    ev = ["requests.get(url, timeout=5).text"]

    async def retest() -> dict:
        msg = await run_security_tool(
            state,
            "c",
            "security_scan",
            {"repo": "fixture", "op": "retest", "path": "app.py", "evidence": ev},
            8000,
        )
        return json.loads(msg.content)

    assert (await retest())["status"] == "failed"
    app = Path(repo / "app.py")
    app.write_text(app.read_text().replace(ev[0], "fetch_allowlisted(url)"))  # noqa: ASYNC240
    out = await retest()
    assert out["status"] == "passed"
    assert state.retests[("fixture", "app.py")]["status"] == "passed"


async def test_an_approval_resume_restores_local_reads_scans_and_the_report(tmp_path):
    """Prod: a turn paused for a fix approval resumed with 23 restored steps, but
    only GitHub results were re-seeded, so the verdict read BLOCKED."""
    repo = tmp_path / "fixture"
    build(repo)

    class S:
        ai_security_local_roots = json.dumps({"fixture": str(repo)})
        ai_security_local_user_ids = "u1"

    access = LocalAccess.from_settings(S())
    first = _state(local=access, read_only=False)
    calls = [
        ("security_repo", {"repo": "fixture", "op": "read", "path": "app.py"}),
        ("security_scan", {"repo": "fixture", "op": "secrets"}),
        (
            "security_report",
            {
                "source": {"kind": "local", "repo": "fixture"},
                "findings": [_finding()],
            },
        ),
    ]
    completed = []
    for name, args in calls:
        msg = await run_security_tool(first, "c", name, args, 8000)
        completed.append(
            SimpleNamespace(toolId=name, args=args, resultContent=msg.content)
        )
    resumed = _state(local=access, read_only=False)
    resumed.seed_from_completed(completed)
    assert resumed.local_access == {"fixture": "verified"} and resumed.resumed
    assert resumed.stages["secret_scan"]["status"] == "ran"
    assert {h["rule"] for h in resumed.secret_hits} >= {"github-token"}
    [f] = resumed.findings
    assert f["status"] == "confirmed" and f["line_verified"]
    assert resumed.verdict(deadline=False)[0] == "FINDINGS"

    # PROD SHAPE: built-in executions are recorded WITHOUT args. The resume must
    # still restore the reads, the scan and the validated findings.
    bare = [
        SimpleNamespace(toolId=c.toolId, args={}, resultContent=c.resultContent)
        for c in completed
    ]
    again = _state(local=access, read_only=False)
    again.seed_from_completed(bare)
    assert any(r.path == "app.py" for r in again.reads)
    assert again.stages["secret_scan"]["status"] == "ran"
    [g] = again.findings
    assert g["status"] == "confirmed" and g["fingerprint"] == f["fingerprint"]
    text = again.render()
    assert "Content read this turn: 1 file(s)" in text
    assert again.verdict(deadline=False)[0] == "FINDINGS"


async def test_a_call_without_a_repo_name_is_not_recorded_as_an_access_target():
    state = _state()
    msg = await run_security_tool(state, "c", "security_repo", {"op": "tree"}, 8000)
    assert json.loads(msg.content)["code"] == "invalid_input"
    assert state.local_access == {}


def test_evidence_read_before_a_fix_still_validates_after_the_file_changes():
    """Prod: after an approved fix, the retest re-read app.py and replaced the
    content the finding's evidence came from, so a confirmed SSRF read
    `needs_validation — evidence not found`."""
    from qa.secaudit_fixture import APP_PY

    s = _state(read_only=False)
    _app_read(s)
    s.add_read(
        Read(
            source="local",
            repo="fixture",
            path="app.py",
            text=APP_PY.replace(SQLI, "query = safe_query(name)"),
            shown=[(1, 40)],
        )
    )
    [f] = s.validate({"kind": "local", "repo": "fixture"}, "", [_finding()])
    assert f["status"] == "confirmed" and f["line_verified"]
    assert "Content read this turn: 1 file(s)" in s.render()


async def test_an_applied_fix_is_retested_even_if_the_model_never_asks(tmp_path):
    """Prod: after an approved fix the resumed model stalled without calling
    retest, so the report could not show the regression result."""
    from app.models.tools import ToolDefinition
    from app.secaudit.tool import SecurityFixAdapter, fix_tool_definition

    repo = tmp_path / "fixture"
    build(repo)

    class S:
        ai_security_local_roots = json.dumps({"fixture": str(repo)})
        ai_security_local_user_ids = "u1"

    state = _state(local=LocalAccess.from_settings(S()), read_only=False)
    tool: ToolDefinition = fix_tool_definition()
    old = "return requests.get(url, timeout=5).text"
    out = await SecurityFixAdapter(state).call_tool(
        tool,
        {
            "repo": "fixture",
            "path": "app.py",
            "old": old,
            "new": "return fetch_allowlisted(url)",
            "finding_title": "SSRF",
            "explanation": "allowlist",
        },
        user_id="u1",
    )
    assert out["data"]["status"] == "applied" and out["data"]["committed"] is False
    assert state.retests[("fixture", "app.py")]["status"] == "passed"
    text = state.render()
    assert "### Fixes — 1" in text and "Fix retest: passed" in text

    # A patch that introduces a secret fails the automatic check.
    leak = planted("introduced")["github_token"]
    await SecurityFixAdapter(state).call_tool(
        tool,
        {
            "repo": "fixture",
            "path": "app.py",
            "old": "return fetch_allowlisted(url)",
            "new": f'return fetch_allowlisted(url, token="{leak}")',
            "finding_title": "x",
            "explanation": "x",
        },
        user_id="u1",
    )
    assert state.retests[("fixture", "app.py")]["status"] == "failed"
    assert leak not in state.render()


def test_github_timeouts_and_approved_github_writes_are_reported_as_such():
    s = _state(github_connected=True, read_only=False)
    s.observe_registry(
        "mcp:github:get_file_contents",
        "get_file_contents",
        {"owner": "acme", "repo": "slow"},
        None,
        error={"error": "[github] Request 'tools/call' timed out"},
    )
    assert s.github_access["acme/slow"] == "timeout"
    args = {"owner": "acme", "repo": "app"}
    s.observe_registry(
        "mcp:github:create_branch",
        "create_branch",
        {**args, "branch": "fix/ssrf"},
        "created",
    )
    s.observe_registry(
        "mcp:github:create_or_update_file",
        "create_or_update_file",
        {**args, "branch": "fix/ssrf", "path": "app.py"},
        "ok",
    )
    s.observe_registry(
        "mcp:github:create_pull_request",
        "create_pull_request",
        {**args, "head": "fix/ssrf", "base": "main"},
        {"html_url": "https://github.com/acme/app/pull/7"},
    )
    text = s.render()
    assert "branch `fix/ssrf` created" in text
    assert "`app.py` updated on `fix/ssrf`" in text
    assert "pull request #7 opened: `fix/ssrf` → `main` (not merged)" in text
