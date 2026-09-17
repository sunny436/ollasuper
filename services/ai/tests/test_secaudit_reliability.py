"""Security audit reliability: bounded GitHub timeouts and the finalization
checkpoint. Neither may weaken access control, fabricate findings, or turn an
incomplete audit into a clean one."""

from __future__ import annotations

import json
import logging

import httpx
import pytest
from langchain_core.messages import AIMessage

from app.agent.executor import execute_tool_calls
from app.models.chat import ApprovalDecision, ApprovedPending
from app.models.tools import SideEffect, ToolDefinition, ToolPermissions
from app.secaudit.intent import detect
from app.secaudit.local import LocalAccess
from app.secaudit.report import SecurityTurn
from app.tools.errors import ToolError, ToolErrorKind
from qa.secaudit_fixture import build
from tests.test_agent_executor import _ctx
from tests.test_agent_runner import _ops
from tests.test_secaudit_turn import _call, _final, _git, _req, _settings, _turn

pytestmark = pytest.mark.anyio

READ = SideEffect.READ_ONLY


def _tool(tool_id: str, provider: str) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=tool_id.rsplit(":", 1)[-1],
        provider=provider,
        category=provider,
        side_effect=READ,
        permissions=ToolPermissions(approval_required=False),
        input_schema={"type": "object", "properties": {}},
        required_auth="mcp",
        method="",
        path="",
    )


class _Adapter:
    """Times out `hang` times, then answers."""

    def __init__(self, hang: int = 99) -> None:
        self.calls = 0
        self.hang = hang

    async def call_tool(self, tool, payload, **kw) -> dict:
        self.calls += 1
        if self.calls <= self.hang:
            raise ToolError(
                ToolErrorKind.TIMEOUT,
                f"[{tool.provider}] Request 'tools/call' timed out",
                retryable=True,
            )
        return {"data": {"result": {"content": [{"text": "README text"}]}}}


def _ctx_for(tools, adapters, *, security: bool):
    ctx, convex, client = _ctx(lambda r: httpx.Response(500), tools)
    ctx.adapters = adapters
    ctx.tool_max_retries = 2
    ctx.tool_retry_base_s = 0.0
    if security:
        ctx.security = SecurityTurn(
            intent=detect("security audit of acme/app on github"),
            user_id="u1",
            local=LocalAccess(),
            read_only=True,
        )
    return ctx, client


def _gh_call(i: int, repo: str = "app") -> dict:
    return {
        "name": "mcp:github:get_file_contents",
        "id": f"c{i}",
        "args": {"owner": "acme", "repo": repo, "path": f"f{i}.py"},
    }


# ------------------------------------------------------------ retry / timeout
async def test_a_github_timeout_is_not_retried_on_a_security_turn():
    gh = _Adapter()
    ctx, client = _ctx_for(
        [_tool("mcp:github:get_file_contents", "mcp:github")],
        {"mcp:github": gh},
        security=True,
    )
    try:
        [msg] = await execute_tool_calls([_gh_call(1)], ctx)
    finally:
        await client.aclose()
    assert gh.calls == 1  # was 3 (1 + 2 retries) ≈ 90s against a hanging server
    assert msg.status == "error"
    assert ctx.security.github_access == {"acme/app": "timeout"}
    assert ctx.security.github_timeouts == 1


async def test_two_github_timeouts_stop_further_github_calls_this_turn():
    gh = _Adapter()
    ctx, client = _ctx_for(
        [_tool("mcp:github:get_file_contents", "mcp:github")],
        {"mcp:github": gh},
        security=True,
    )
    try:
        await execute_tool_calls([_gh_call(1)], ctx)
        await execute_tool_calls([_gh_call(2)], ctx)
        [third] = await execute_tool_calls([_gh_call(3, repo="other")], ctx)
    finally:
        await client.aclose()
    assert gh.calls == 2  # the third call never reached GitHub
    body = json.loads(third.content)
    assert body["status"] == "denied" and "did not respond" in body["reason"]
    verdict, why = ctx.security.verdict(deadline=False)
    assert verdict == "BLOCKED" and any("timeout" in w for w in why)
    assert "### Blocked actions" in ctx.security.render()


async def test_an_answer_from_github_resets_the_timeout_breaker():
    gh = _Adapter(hang=1)
    ctx, client = _ctx_for(
        [_tool("mcp:github:get_file_contents", "mcp:github")],
        {"mcp:github": gh},
        security=True,
    )
    try:
        await execute_tool_calls([_gh_call(1)], ctx)  # timeout
        [ok] = await execute_tool_calls([_gh_call(2)], ctx)  # answers
    finally:
        await client.aclose()
    assert ok.status == "success"
    assert ctx.security.github_timeouts == 0
    assert ctx.security.github_access["acme/app"] == "verified"


async def test_other_tools_and_non_security_turns_keep_the_existing_retry_policy():
    other = _Adapter()
    ctx, client = _ctx_for(
        [_tool("mcp:slack:search", "mcp:slack")],
        {"mcp:slack": other},
        security=True,
    )
    try:
        await execute_tool_calls(
            [{"name": "mcp:slack:search", "id": "s1", "args": {}}], ctx
        )
    finally:
        await client.aclose()
    assert other.calls == 3  # unchanged: 1 + 2 retries

    gh = _Adapter()
    ctx2, client2 = _ctx_for(
        [_tool("mcp:github:get_file_contents", "mcp:github")],
        {"mcp:github": gh},
        security=False,
    )
    try:
        await execute_tool_calls([_gh_call(1)], ctx2)
    finally:
        await client2.aclose()
    assert gh.calls == 3  # a normal chat turn keeps its retries


# ------------------------------------------------------------ checkpoint
@pytest.fixture
def repo(tmp_path):
    build(tmp_path / "fixture")
    return tmp_path / "fixture"


REPORT = {
    "source": {"kind": "local", "repo": "fixture"},
    "findings": [
        {
            "title": "SSRF in /preview",
            "status": "confirmed",
            "cwe": ["CWE-918"],
            "path": "app.py",
            "start_line": 29,
            "evidence": [
                {"path": "app.py", "code": 'url = request.args.get("url", "")'}
            ],
            "source_to_sink": "url arg -> requests.get",
            "impact": "high",
            "likelihood": "high",
        }
    ],
}


async def test_a_scan_that_forgets_its_report_gets_one_checkpoint(
    monkeypatch, repo, caplog
):
    caplog.set_level(logging.INFO)
    steps = [
        _call(
            "security_repo", {"repo": "fixture", "op": "read", "path": "app.py"}, "c1"
        ),
        AIMessage(content="I reviewed app.py."),  # ends WITHOUT security_report
        _call("security_report", REPORT, "c2"),  # the checkpoint's one step
        AIMessage(content="Submitted."),
    ]
    convex = await _turn(
        monkeypatch, _req("security audit of the fixture repo"), _settings(repo), steps
    )
    text = _final(convex)["text"]
    assert "Verdict: FINDINGS" in text and "SSRF in /preview" in text
    assert sum("secaudit.checkpoint" in r.message for r in caplog.records) == 1
    # The instruction itself is never shown to the user.
    assert "SECURITY AUDIT CHECKPOINT" not in json.dumps(convex.calls)


async def test_a_model_that_still_does_not_submit_stays_incomplete(
    monkeypatch, repo, caplog
):
    caplog.set_level(logging.INFO)
    steps = [
        _call(
            "security_repo", {"repo": "fixture", "op": "read", "path": "app.py"}, "c1"
        ),
        AIMessage(content="Looks fine."),
        AIMessage(content="The audit is incomplete."),  # checkpoint declined
        AIMessage(content="The audit is incomplete."),
    ]
    convex = await _turn(
        monkeypatch, _req("security audit of the fixture repo"), _settings(repo), steps
    )
    text = _final(convex)["text"]
    assert "Verdict: INCOMPLETE" in text and "security_report was not called" in text
    assert "Findings — 0 confirmed" in text  # nothing fabricated
    assert sum("secaudit.checkpoint" in r.message for r in caplog.records) == 1


async def test_no_checkpoint_without_audit_work_or_on_a_normal_turn(
    monkeypatch, repo, caplog
):
    caplog.set_level(logging.INFO)
    convex = await _turn(
        monkeypatch,
        _req("security audit of acme/app on github"),  # nothing read at all
        _settings(repo),
        [AIMessage(content="GitHub is not connected.")],
    )
    assert "Verdict: BLOCKED" in _final(convex)["text"]
    convex = await _turn(
        monkeypatch,
        _req("hello there"),
        _settings(repo),
        [AIMessage(content="Hi!")],
    )
    assert "Security audit report" not in _final(convex)["text"]
    assert not any("secaudit.checkpoint" in r.message for r in caplog.records)


OLD = "return requests.get(url, timeout=5).text"
FIX = {
    "repo": "fixture",
    "path": "app.py",
    "old": OLD,
    "new": "return fetch_allowlisted(url)",
    "finding_title": "SSRF in /preview",
    "explanation": "only allowlisted hosts",
}


async def _approved_resume(monkeypatch, repo, steps):
    ask = "fix the SSRF in app.py of the fixture repo"
    settings = _settings(repo)
    convex = await _turn(
        monkeypatch,
        _req(ask),
        settings,
        [_call("security_apply_fix", FIX, "c1"), AIMessage(content="waiting")],
    )
    [approval] = _ops(convex, "approval")
    approved = _req(
        ask,
        approvals=[
            ApprovalDecision(
                approvalId=approval["approvalId"],
                toolId=approval["toolId"],
                decision="approved",
                token="tok_1",
            )
        ],
        approvedPending=[
            ApprovedPending(
                toolId=approval["toolId"],
                args=FIX,
                token="tok_1",
                approvalId=approval["approvalId"],
            )
        ],
    )
    return await _turn(monkeypatch, approved, settings, steps)


async def test_audit_approval_fix_retest_final_report(monkeypatch, repo):
    head = _git(repo, "rev-parse", "HEAD")
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
        AIMessage(content="Applied."),  # stalls without a report...
        _call("security_report", REPORT, "c4"),  # ...the checkpoint gets it
        AIMessage(content="Report submitted."),
    ]
    convex = await _approved_resume(monkeypatch, repo, steps)
    text = _final(convex)["text"]
    assert OLD not in (repo / "app.py").read_text()
    assert _git(repo, "rev-parse", "HEAD") == head  # never committed
    assert "### Fixes — 1" in text and "Fix retest: passed" in text
    assert "SSRF in /preview" in text and "Verdict: FINDINGS" in text
    assert "It is not a re-audit" in text
    assert "not a re-audit" in text.split("### Fixes")[1]


async def test_approval_without_findings_is_incomplete_but_shows_the_fix(
    monkeypatch, repo
):
    steps = [
        AIMessage(content="Applied the fix."),  # no retest call, no report
        AIMessage(content="The audit is incomplete."),  # checkpoint declined
        AIMessage(content="The audit is incomplete."),
    ]
    convex = await _approved_resume(monkeypatch, repo, steps)
    text = _final(convex)["text"]
    assert "Verdict: INCOMPLETE" in text
    assert (
        "### Fixes — 1" in text and "Fix retest: passed" in text
    )  # auto post-fix check
    assert "It is not a re-audit" in text
    assert "NO CONFIRMED FINDINGS" not in text and "Verdict: FINDINGS" not in text
