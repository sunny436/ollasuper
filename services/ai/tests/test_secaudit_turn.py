"""The security audit end to end, through the real turn.

Real `run_generation`, real LangGraph, real executor, real MCP SDK against an
in-process GitHub-shaped server, real git repository. Only the LLM is scripted —
the thing under test is what the system does with the calls a model makes:
routing, binding, read-only enforcement, redaction, access verification,
approval-gated fixes, and a report that cannot be talked into "clean".
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import httpx
import httpx2
import pytest
from langchain_core.messages import AIMessage, ToolMessage

from app.agent.executor import _run_builtin, execute_tool_calls
from app.models.chat import (
    ApprovalDecision,
    ApprovedPending,
    GenerateRequest,
    HistoryMessage,
    McpConnectionRef,
    ModelCandidate,
)
from app.models.execution import ExecutionLedger
from app.models.tools import SideEffect, ToolDefinition, ToolPermissions
from app.runtime.runner import run_generation
from app.secaudit.intent import detect
from app.secaudit.local import LocalAccess
from app.secaudit.report import SecurityTurn
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from qa.secaudit_fixture import build, planted
from tests.conftest import make_settings
from tests.fakes.mcp_http import BASE_URL, HOST, Traffic, _counting, running
from tests.test_agent_executor import _ctx
from tests.test_agent_runner import FakeLLM, RecordingConvex, _ops
from tests.test_mcp_turn_integration import _native_tool, _pool_for, _Target

pytestmark = pytest.mark.anyio

PROFILES = json.dumps(
    {
        "gemini-3.7-flash-high": {"ttft_s": 2.97, "reasoning_tier": 0},
        "deepseek-v4-flash": {"ttft_s": 3.68, "reasoning_tier": 1},
        "gemini-3.8-pro": {"ttft_s": 5.23, "reasoning_tier": 2},
    }
)
GH_TOKEN = planted("github-fixture")["github_token"]
SINK = 'rows = db.execute("SELECT * FROM t WHERE id=" + request.args["id"])'
GH_REF = McpConnectionRef(
    connectionId="conn-gh",
    serverName="test.fixture/github",
    slug="github",
    version="1.0.0",
)


def _github_app() -> Any:
    """A GitHub-MCP-shaped server: declared reads, undeclared (write) tools."""
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.server.transport_security import TransportSecuritySettings
    from mcp_types import ToolAnnotations

    server = MCPServer(name="github")
    ro = ToolAnnotations(read_only_hint=True)

    @server.tool(
        name="get_file_contents", description="Get file contents.", annotations=ro
    )
    def get_file_contents(owner: str, repo: str, path: str = "", ref: str = "") -> str:
        full = f"{owner}/{repo}".lower()
        if full == "acme/private":
            # GitHub MCP answers is_error with the API status in the text.
            raise ToolError(
                f"failed to get file contents: GET repos/{full}/contents: 404 Not Found"
            )
        if full == "acme/forbidden":
            raise ToolError("403 Resource not accessible by integration")
        return f'GITHUB_TOKEN = "{GH_TOKEN}"\n{SINK}\n'

    @server.tool(name="create_branch", description="Create a branch.")
    def create_branch(owner: str, repo: str, branch: str) -> str:
        return f"created {branch}"

    @server.tool(name="create_or_update_file", description="Write a file.")
    def create_or_update_file(
        owner: str, repo: str, path: str, content: str, message: str, branch: str
    ) -> str:
        return "written"

    @server.tool(name="merge_pull_request", description="Merge a pull request.")
    def merge_pull_request(owner: str, repo: str, pullNumber: int) -> str:  # noqa: N803
        return "merged"

    app = server.streamable_http_app(
        transport_security=TransportSecuritySettings(
            allowed_hosts=[HOST, f"{HOST}:443"], allowed_origins=[BASE_URL]
        )
    )
    return _counting(app, Traffic())


def _settings(repo: Path | None, **kw):
    return make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        mcp_connections_enabled=True,
        ai_agent_side_effect_enabled=True,
        ai_security_enabled=True,
        ai_security_local_roots=json.dumps({"fixture": str(repo)}) if repo else "",
        ai_router_enabled=True,
        ai_router_profiles=PROFILES,
        **{"ai_security_local_user_ids": "u1", **kw},
    )


def _req(content: str, connections=(), **kw) -> GenerateRequest:
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gemini-3.7-flash-high",
        modelCandidates=[ModelCandidate(id=m) for m in json.loads(PROFILES)],
        history=[HistoryMessage(role="user", content=content, seq=1)],
        mcpConnections=list(connections),
        **kw,
    )


def _call(name: str, args: dict, cid: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": cid}])


async def _turn(monkeypatch, req, settings, steps, *, captured=None, github=False):
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Target(slug="github")

    monkeypatch.setattr(curated, "resolve", resolve)

    class Capturing(FakeLLM):
        def bind_tools(self, specs):
            if captured is not None:
                captured.setdefault("names", set()).update(
                    s["function"]["name"] for s in specs
                )
            return super().bind_tools(specs)

    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: Capturing(AIMessage(content="done"), steps),
    )
    convex = RecordingConvex()
    registry = ToolRegistry()
    registry.register(_native_tool())
    kwargs = dict(
        engine=object(),
        tool_registry=registry,
        tool_selector=ToolSelector(registry),
        ollagraph_http=httpx2.AsyncClient(),
    )
    if github:
        app = _github_app()
        async with running(app), _pool_for(app) as pool:
            await run_generation(req, settings, convex, mcp_pool=pool, **kwargs)
    else:
        await run_generation(req, settings, convex, **kwargs)
    return convex


def _final(convex) -> dict:
    [f] = _ops(convex, "finalize")
    return f


def _no_secret_anywhere(convex, *values: str) -> None:
    blob = json.dumps(convex.calls, default=str)
    for v in values:
        assert v not in blob, "a secret value left the plane"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(  # noqa: S603
        ["git", *args],  # noqa: S607
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,  # noqa: S607
    ).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    build(tmp_path / "fixture")
    return tmp_path / "fixture"


# ------------------------------------------------------------------ local audit
async def test_a_local_audit_routes_deep_reads_redacts_validates_and_changes_nothing(
    monkeypatch, repo, caplog
):
    head = _git(repo, "rev-parse", "HEAD")
    steps = [
        _call(
            "security_repo",
            {"repo": "fixture", "op": "read", "path": "config.py"},
            "c1",
        ),
        _call(
            "security_repo", {"repo": "fixture", "op": "read", "path": "app.py"}, "c2"
        ),
        _call("security_scan", {"repo": "fixture", "op": "secrets"}, "c3"),
        _call(
            "security_report",
            {
                "source": {"kind": "local", "repo": "fixture"},
                "scope_summary": "app.py, config.py",
                "findings": [
                    {
                        "title": "SQL injection in /users",
                        "status": "confirmed",
                        "cwe": ["CWE-89"],
                        "path": "app.py",
                        "start_line": 15,
                        "evidence": [
                            {
                                "path": "app.py",
                                "start_line": 15,
                                "code": 'query = "SELECT id, email FROM users '
                                'WHERE name = \'" + name + "\'"',
                            }
                        ],
                        "source_to_sink": "name query arg -> string concat -> execute",
                        "reachability": "unauthenticated GET /users",
                        "impact": "high",
                        "likelihood": "high",
                        "severity": "critical",
                    }
                ],
            },
            "c4",
        ),
        AIMessage(content="The /users endpoint builds SQL from input."),
    ]
    captured: dict = {}
    convex = await _turn(
        monkeypatch,
        _req("run a security audit of the fixture repository"),
        _settings(repo),
        steps,
        captured=captured,
    )
    final = _final(convex)
    assert final["status"] == "done"
    # routed to the complex model, before anything else happened
    assert final["model"] == "gemini-3.8-pro"
    assert final["routedReason"].startswith("security:2")
    text = final["text"]
    assert "## Security audit report (system-validated)" in text
    assert "Verdict: FINDINGS" in text
    assert (
        "**[HIGH (claimed critical, set by policy)] SQL injection in /users**" in text
    )  # noqa: E501
    assert "SQL injection in /users** — `confirmed`" in text
    assert "`local:fixture` — access **verified**" in text
    assert "Secrets detected" in text and "github-token" in text
    # redaction: no planted value anywhere Convex (events, executions, text) saw
    _no_secret_anywhere(convex, *planted().values())
    assert not any(v in caplog.text for v in planted().values())
    # read-only: nothing changed, nothing committed; no write or delegation bound
    assert _git(repo, "status", "--porcelain") == ""
    assert _git(repo, "rev-parse", "HEAD") == head
    names = captured["names"]
    assert {"security_repo", "security_scan", "security_report"} <= names
    assert "security_apply_fix" not in names and "delegate_to_agent" not in names


async def test_a_turn_that_never_submits_findings_is_incomplete_not_clean(
    monkeypatch, repo
):
    steps = [
        _call(
            "security_repo", {"repo": "fixture", "op": "read", "path": "app.py"}, "c1"
        ),
        AIMessage(content="Looks secure to me."),
    ]
    convex = await _turn(
        monkeypatch, _req("security audit of the fixture repo"), _settings(repo), steps
    )
    text = _final(convex)["text"]
    assert "Verdict: INCOMPLETE" in text and "security_report was not called" in text


async def test_an_unauthorized_account_cannot_reach_a_local_repository(
    monkeypatch, repo
):
    steps = [
        _call("security_repo", {"repo": "fixture", "op": "tree"}, "c1"),
        AIMessage(content="I could not access it."),
    ]
    settings = _settings(repo, ai_security_local_user_ids="someone-else")
    convex = await _turn(
        monkeypatch, _req("security audit of the fixture repo"), settings, steps
    )
    text = _final(convex)["text"]
    assert "Verdict: BLOCKED" in text and "not_authorized" in text
    assert str(repo) not in json.dumps(convex.calls, default=str)


# ------------------------------------------------------------------ GitHub MCP
async def test_a_github_audit_verifies_access_and_redacts_the_mcp_result(
    monkeypatch, caplog
):
    steps = [
        _call(
            "mcp_github_get_file_contents",
            {"owner": "acme", "repo": "app", "path": "app.py"},
            "c1",
        ),
        _call(
            "security_report",
            {
                "source": {"kind": "github", "repo": "acme/app"},
                "findings": [
                    {
                        "title": "SQL injection via id",
                        "status": "confirmed",
                        "cwe": ["CWE-89"],
                        "path": "app.py",
                        "evidence": [{"path": "app.py", "code": SINK}],
                        "source_to_sink": "request.args id -> concat -> execute",
                        "impact": "high",
                        "likelihood": "medium",
                    }
                ],
            },
            "c2",
        ),
        AIMessage(content="Found an injection."),
    ]
    captured: dict = {}
    convex = await _turn(
        monkeypatch,
        _req("security review of acme/app on github", [GH_REF]),
        _settings(None),
        steps,
        captured=captured,
        github=True,
    )
    text = _final(convex)["text"]
    assert "`github:acme/app` — access **verified**" in text
    assert "**[MEDIUM] SQL injection via id** — `confirmed`" in text
    _no_secret_anywhere(convex, GH_TOKEN)
    assert GH_TOKEN not in caplog.text
    # read-only audit: the GitHub READ is bound, the writes are not
    names = captured["names"]
    assert "mcp_github_get_file_contents" in names
    assert not names & {
        "mcp_github_create_or_update_file",
        "mcp_github_merge_pull_request",
    }


@pytest.mark.parametrize(
    ("repo_name", "status"), [("private", "not_found"), ("forbidden", "denied")]
)
async def test_an_inaccessible_github_repository_is_blocked(
    monkeypatch, repo_name, status
):
    steps = [
        _call(
            "mcp_github_get_file_contents",
            {"owner": "acme", "repo": repo_name, "path": ""},
            "c1",
        ),
        AIMessage(content="I could not read that repository."),
    ]
    convex = await _turn(
        monkeypatch,
        _req(f"security audit of acme/{repo_name} on github", [GH_REF]),
        _settings(None),
        steps,
        github=True,
    )
    text = _final(convex)["text"]
    assert "Verdict: BLOCKED" in text
    assert f"`github:acme/{repo_name}` — access **{status}**" in text


async def test_github_not_connected_is_blocked(monkeypatch):
    convex = await _turn(
        monkeypatch,
        _req("security audit of acme/app on github"),
        _settings(None),
        [AIMessage(content="GitHub is not connected.")],
    )
    text = _final(convex)["text"]
    assert "Verdict: BLOCKED" in text and "no repository content was accessed" in text


# ------------------------------------------------------------------ guards
def _gh_tool(name: str, side=SideEffect.EXTERNAL_SIDE_EFFECT) -> ToolDefinition:
    return ToolDefinition(
        tool_id=f"mcp:github:{name}",
        name=name,
        provider="mcp:github",
        category="mcp:github",
        side_effect=side,
        permissions=ToolPermissions(approval_required=side != SideEffect.READ_ONLY),
        input_schema={"type": "object", "properties": {}},
        required_auth="mcp",
        method="",
        path="",
    )


class _RecordingAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def call_tool(self, tool, payload, **kw) -> dict:
        self.calls.append((tool.name, payload))
        return {"data": {"ok": True}}


def _guard_ctx(read_only: bool):
    tools = [_gh_tool("create_or_update_file"), _gh_tool("merge_pull_request")]
    ctx, convex, client = _ctx(lambda r: httpx.Response(500), tools)
    adapter = _RecordingAdapter()
    ctx.adapters = {"mcp:github": adapter}
    ctx.security = SecurityTurn(
        intent=detect("fix the leak in acme/app on github"),
        user_id="u1",
        local=LocalAccess(),
        read_only=read_only,
    )
    return ctx, convex, client, adapter


async def test_a_write_reaching_an_audit_turn_is_refused_not_offered_for_approval():
    ctx, convex, client, adapter = _guard_ctx(read_only=True)
    try:
        [msg] = await execute_tool_calls(
            [
                {
                    "name": "mcp:github:create_or_update_file",
                    "id": "c1",
                    "args": {
                        "owner": "acme",
                        "repo": "app",
                        "path": "a",
                        "content": "x",
                        "message": "m",
                        "branch": "fix/x",
                    },
                }
            ],
            ctx,
        )
    finally:
        await client.aclose()
    assert json.loads(msg.content)["status"] == "denied"
    assert adapter.calls == [] and ctx.writer.suspended is False
    assert not [c for c in convex.calls if c.get("op") == "approval"]


async def test_a_github_fix_never_merges_and_writes_only_to_a_branch_made_this_turn():
    ctx, convex, client, adapter = _guard_ctx(read_only=False)
    write = {
        "owner": "acme",
        "repo": "app",
        "path": "app.py",
        "content": "x",
        "message": "fix",
        "branch": "main",
    }
    try:
        [to_main] = await execute_tool_calls(
            [{"name": "mcp:github:create_or_update_file", "args": write, "id": "c1"}],
            ctx,
        )
        [merge] = await execute_tool_calls(
            [
                {
                    "name": "mcp:github:merge_pull_request",
                    "id": "c2",
                    "args": {"owner": "acme", "repo": "app", "pullNumber": 1},
                }
            ],
            ctx,
        )
        assert json.loads(to_main.content)["status"] == "denied"
        assert json.loads(merge.content)["status"] == "denied"
        ctx.security.created_branches.add(("acme/app", "fix/sqli"))
        [on_branch] = await execute_tool_calls(
            [
                {
                    "name": "mcp:github:create_or_update_file",
                    "id": "c3",
                    "args": {**write, "branch": "fix/sqli"},
                }
            ],
            ctx,
        )
    finally:
        await client.aclose()
    # a write to the new branch is NOT refused — it goes to the ordinary approval
    assert json.loads(on_branch.content)["status"] == "awaiting_approval"
    assert ctx.writer.suspended is True
    assert adapter.calls == []  # nothing ran without a human


async def test_every_builtin_result_is_redacted_on_a_security_turn():
    ctx, convex, client = _ctx(lambda r: httpx.Response(500), [])
    ctx.security = SecurityTurn(
        intent=detect("security audit"),
        user_id="u1",
        local=LocalAccess(),
        read_only=True,
    )
    execution = ExecutionLedger().create(
        run_id="s1",
        step_id="st",
        tool_call_id="c1",
        tool_id="mcp_read_resource",
        args={},
    )

    async def resource_read() -> ToolMessage:
        return ToolMessage(
            content=f"repo://acme/app/config.py\nKEY={GH_TOKEN}",
            tool_call_id="c1",
            status="success",
        )

    try:
        msg = await _run_builtin(
            ctx, execution, resource_read(), side_effect="read_only"
        )
        await ctx.writer.flush(force=True)
    finally:
        await client.aclose()
    assert GH_TOKEN not in msg.content and "[REDACTED:github-token" in msg.content
    _no_secret_anywhere(convex, GH_TOKEN)


# ------------------------------------------------------------------ fix flow
async def test_a_local_fix_needs_approval_rejection_changes_nothing_approval_retests(
    monkeypatch, repo
):
    head = _git(repo, "rev-parse", "HEAD")
    ask = "fix the SSRF in app.py of the fixture repo"
    old = "return requests.get(url, timeout=5).text"
    fix_args = {
        "repo": "fixture",
        "path": "app.py",
        "old": old,
        "new": "return fetch_allowlisted(url)",
        "finding_title": "SSRF in /preview",
        "explanation": "only allowlisted hosts",
    }
    settings = _settings(repo)

    # 1) the model proposes the fix -> it PARKS with a before/after preview
    captured: dict = {}
    convex = await _turn(
        monkeypatch,
        _req(ask),
        settings,
        [_call("security_apply_fix", fix_args, "c1"), AIMessage(content="waiting")],
        captured=captured,
    )
    assert "security_apply_fix" in captured["names"]
    [approval] = _ops(convex, "approval")
    assert (repo / "app.py").read_text().count(old) == 1  # untouched while waiting
    payload = json.loads(approval["event"]["payload"])
    preview = payload["preview"]
    assert preview["diff"]["app.py"] == {"before": old, "after": fix_args["new"]}
    approval_id, tool_id = approval["approvalId"], approval["toolId"]
    assert tool_id == "security_apply_fix"
    assert not _ops(convex, "finalize")  # suspended, not finished

    # 2) REJECTED: the model re-emits, nothing runs, the file is unchanged
    rejected = _req(
        ask,
        approvals=[
            ApprovalDecision(
                approvalId=approval_id, toolId=tool_id, decision="rejected"
            )
        ],
    )
    convex = await _turn(
        monkeypatch,
        rejected,
        settings,
        [
            _call("security_apply_fix", fix_args, "c1"),
            AIMessage(content="ok, not applied"),
        ],
    )
    assert _final(convex)["status"] == "done"
    assert (repo / "app.py").read_text().count(old) == 1

    # 3) APPROVED: the resume runs the durable args, then retest + report
    approved = _req(
        ask,
        approvals=[
            ApprovalDecision(
                approvalId=approval_id,
                toolId=tool_id,
                decision="approved",
                token="tok_1",
            )
        ],
        approvedPending=[
            ApprovedPending(
                toolId=tool_id, args=fix_args, token="tok_1", approvalId=approval_id
            )
        ],
    )
    steps = [
        _call(
            "security_scan",
            {
                "repo": "fixture",
                "op": "retest",
                "path": "app.py",
                "evidence": ["requests.get(url, timeout=5).text"],
            },
            "c2",
        ),
        _call(
            "security_repo", {"repo": "fixture", "op": "read", "path": "app.py"}, "c3"
        ),
        _call(
            "security_report",
            {
                "source": {"kind": "local", "repo": "fixture"},
                "findings": [
                    {
                        "title": "SSRF in /preview",
                        "status": "confirmed",
                        "cwe": ["CWE-918"],
                        "path": "app.py",
                        "start_line": 28,
                        "evidence": [
                            {
                                "path": "app.py",
                                "code": 'url = request.args.get("url", "")',
                            }
                        ],
                        "source_to_sink": "url arg -> outbound fetch",
                        "impact": "high",
                        "likelihood": "high",
                    }
                ],
            },
            "c4",
        ),
        AIMessage(content="Applied and retested."),
    ]
    convex = await _turn(monkeypatch, approved, settings, steps)
    final = _final(convex)
    assert final["status"] == "done"
    assert old not in (repo / "app.py").read_text()
    assert "fetch_allowlisted(url)" in (repo / "app.py").read_text()
    assert _git(repo, "rev-parse", "HEAD") == head  # never committed
    assert "Fix retest: **passed**" in final["text"]
    assert _git(repo, "status", "--porcelain").strip() == "M app.py"


# ------------------------------------------------------------------ normal turns
async def test_a_normal_turn_gets_no_security_tools_state_or_report(monkeypatch, repo):
    captured: dict = {}
    convex = await _turn(
        monkeypatch,
        _req("search the web for pages about pizza"),
        _settings(repo),
        [AIMessage(content="Here are some pages.")],
        captured=captured,
    )
    final = _final(convex)
    assert "Security audit report" not in final["text"]
    assert not captured.get("names", set()) & {
        "security_repo",
        "security_scan",
        "security_report",
        "security_apply_fix",
    }
    assert not final["routedReason"].startswith("security")


async def test_a_security_question_routes_deep_but_is_not_an_audit(monkeypatch, repo):
    captured: dict = {}
    convex = await _turn(
        monkeypatch,
        _req("what is SSRF?"),
        _settings(repo),
        [AIMessage(content="SSRF is ...")],
        captured=captured,
    )
    final = _final(convex)
    assert final["model"] == "gemini-3.8-pro"
    assert "Security audit report" not in final["text"]
    assert "security_repo" not in captured.get("names", set())
