"""Local repositories: allowlisted, tracked-only, hardened git, redacted, and the
one write (a fix) is exact, unique, atomic and never committed.

Everything here runs against a REAL git repository (the shared fixture), because
the risks are real-git risks: a hostile `.git/config`, a `.gitattributes` textconv
driver, a revision that is really an option, a tracked symlink out of the root.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.secaudit import local, scanners, secrets
from app.secaudit.intent import detect
from app.secaudit.local import LocalAccess, LocalError
from app.secaudit.report import SecurityTurn
from app.secaudit.tool import run_security_tool
from qa.secaudit_fixture import build, planted

pytestmark = pytest.mark.anyio


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    build(tmp_path / "fixture")
    return tmp_path / "fixture"


def _access(repo: Path, users: str = "u1") -> LocalAccess:
    class S:
        ai_security_local_roots = json.dumps({"fixture": str(repo)})
        ai_security_local_user_ids = users

    return LocalAccess.from_settings(S())


def _state(repo: Path, *, user: str = "u1", read_only: bool = True) -> SecurityTurn:
    return SecurityTurn(
        intent=detect("security audit of the fixture repo"),
        user_id=user,
        local=_access(repo),
        read_only=read_only,
    )


async def _call(state, name, **args) -> dict:
    msg = await run_security_tool(state, "c1", name, args, 8000)
    return json.loads(msg.content)


def _git_status(repo: Path) -> str:
    return subprocess.run(
        ["git", "status", "--porcelain"],  # noqa: S607
        cwd=repo,
        capture_output=True,
        text=True,  # noqa: S607
    ).stdout


# ------------------------------------------------------------------ access
async def test_an_unlisted_user_or_root_is_refused_without_leaking_paths(repo):
    state = _state(repo, user="someone-else")
    out = await _call(state, "security_repo", repo="fixture", op="tree")
    assert out["code"] == "not_authorized"
    assert str(repo) not in json.dumps(out)
    state = _state(repo)
    out = await _call(state, "security_repo", repo="prod-secrets", op="tree")
    assert out["code"] == "unknown_root" and str(repo) not in json.dumps(out)
    assert state.local_access["prod-secrets"] == "unknown_root"


def test_access_is_closed_by_default():
    class S:
        ai_security_local_roots = ""
        ai_security_local_user_ids = ""

    a = LocalAccess.from_settings(S())
    assert a.names_for("u1") == []
    with pytest.raises(LocalError):
        a.resolve("u1", "anything")


async def test_authorized_reads_are_numbered_pinned_and_redacted(repo):
    state = _state(repo)
    head = await _call(state, "security_repo", repo="fixture", op="head")
    assert len(head["commit"]) == 40
    tree = await _call(state, "security_repo", repo="fixture", op="tree")
    assert "app.py" in tree["files"] and ".env" not in tree["files"]
    cfg = await _call(
        state, "security_repo", repo="fixture", op="read", path="config.py"
    )
    assert "2: GITHUB_TOKEN = " in cfg["content"]
    for value in planted().values():
        assert value not in json.dumps(cfg)
    assert "[REDACTED:github-token fp=" in cfg["content"]
    rules = {h["rule"] for h in state.secret_hits}
    assert {"github-token", "aws-access-key", "generic-secret-assignment"} <= rules
    grep = await _call(
        state, "security_repo", repo="fixture", op="grep", pattern="execute\\("
    )
    assert "app.py:" in grep["matches"]
    log = await _call(state, "security_repo", repo="fixture", op="log")
    assert "billing-lite fixture" in log["log"]
    assert state.local_access == {"fixture": "verified"}


# --------------------------------------------------------- boundary refusals
@pytest.mark.parametrize(
    "path", ["../outside.txt", "/etc/passwd", "C:/Windows/win.ini", ".env", "a/../../x"]
)
async def test_traversal_absolute_and_untracked_paths_are_refused(repo, path):
    state = _state(repo)
    out = await _call(state, "security_repo", repo="fixture", op="read", path=path)
    assert out["status"] == "error"
    assert out["code"] in ("invalid_path", "not_tracked")
    assert planted()["env_only_secret"] not in json.dumps(out)


@pytest.mark.skipif(
    sys.platform == "win32", reason="symlinks need privileges on Windows"
)
async def test_a_tracked_symlink_out_of_the_root_is_refused(repo, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("TOP SECRET")
    os.symlink(outside, repo / "link.txt")
    subprocess.run(["git", "add", "link.txt"], cwd=repo, check=True)  # noqa: ASYNC221, S607
    state = _state(repo)
    out = await _call(
        state, "security_repo", repo="fixture", op="read", path="link.txt"
    )
    assert out["status"] == "error" and "TOP SECRET" not in json.dumps(out)


async def test_a_revision_can_never_become_an_option(repo, tmp_path):
    target = tmp_path / "written-by-git.txt"
    state = _state(repo)
    out = await _call(
        state,
        "security_repo",
        repo="fixture",
        op="diff",
        base=f"--output={target}",
        target="HEAD",
    )
    assert out["code"] == "invalid_rev"
    assert not target.exists()


async def test_a_hostile_repository_config_never_executes(repo, tmp_path):
    sentinel = tmp_path / "pwned"
    py = sys.executable.replace("\\", "/")
    cmd = f"\"{py}\" -c \"open(r'{sentinel.as_posix()}', 'w').write('x')\""
    (repo / ".gitattributes").write_text("*.py diff=evil\n")
    (repo / "app.py").write_text((repo / "app.py").read_text() + "\n# changed\n")
    subprocess.run(["git", "add", ".gitattributes", "app.py"], cwd=repo, check=True)  # noqa: ASYNC221, S607
    subprocess.run(  # noqa: ASYNC221
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "attrs"],  # noqa: S607
        cwd=repo,
        check=True,
    )
    # The hostile config lands only AFTER setup, so nothing but the audit's own
    # git calls can trigger it.
    subprocess.run(["git", "config", "core.fsmonitor", cmd], cwd=repo, check=True)  # noqa: ASYNC221, S603, S607
    subprocess.run(["git", "config", "diff.evil.textconv", cmd], cwd=repo, check=True)  # noqa: ASYNC221, S603, S607
    subprocess.run(["git", "config", "core.pager", cmd], cwd=repo, check=True)  # noqa: ASYNC221, S603, S607
    # CONTROL: the hostile driver is live — plain git executes it.
    subprocess.run(["git", "log", "-p", "-1"], cwd=repo, capture_output=True)  # noqa: ASYNC221, S607
    assert sentinel.exists(), "control failed: the hostile config is not live"
    sentinel.unlink()
    state = _state(repo)
    await _call(state, "security_repo", repo="fixture", op="tree")
    await _call(state, "security_repo", repo="fixture", op="grep", pattern="request")
    await _call(state, "security_repo", repo="fixture", op="log")
    await _call(
        state, "security_repo", repo="fixture", op="diff", base="HEAD~1", target="HEAD"
    )
    assert not sentinel.exists(), "a repository-controlled command ran"


# ------------------------------------------------------------------ secrets
def test_each_secret_rule_redacts_and_fingerprints_stably():
    p = planted("rules")
    samples = {
        "github-token": p["github_token"],
        "aws-access-key": p["aws_access_key"],
        "slack-token": "xo" + "xb-" + "1234567890-abcdefghij",
        "stripe-live-key": p["env_only_secret"],
        "google-api-key": "AI" + "za" + "B" * 35,
        "private-key": "-----BEGIN RSA PRIVATE KEY-----\n"
        + "Q" * 64
        + "\n-----END RSA PRIVATE KEY-----",
        "jwt": "ey" + "JhbGciOiJIUzI1NiJ9.ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0.sig12345678",
    }
    for rule, value in samples.items():
        text = f"line one\nconst v = {value}\nline three"
        red, hits = secrets.redact_text(text)
        assert value not in red, rule
        assert [h.rule for h in hits] == [rule], (rule, hits)
        # line numbers after a redaction still point at the same line
        assert red.splitlines()[-1] == "line three"
        again, again_hits = secrets.redact_text(red)
        assert again == red and again_hits == []  # idempotent
        assert secrets.redact_text(text)[1][0].fingerprint == hits[0].fingerprint


def test_placeholders_and_low_entropy_values_are_not_secrets():
    for text in (
        'password = "changeme123"',
        'api_key = "YOUR_API_KEY_HERE"',
        'token = "aaaaaaaaaaaa"',
        "password = os.environ['DB_PASSWORD']",
    ):
        assert secrets.scan(text) == [], text


async def test_the_secret_sweep_covers_every_tracked_file_and_never_ignored_ones(repo):
    files = await local.tracked(str(repo))
    res = await scanners.secret_sweep(str(repo), files)
    assert res["files_scanned"] == len(files)
    assert {h["path"] for h in res["hits"]} == {"config.py"}
    assert planted()["env_only_secret"] not in json.dumps(res)
    for value in planted().values():
        assert value not in json.dumps(res)


# ------------------------------------------------------------------ fixes
async def test_a_fix_replaces_one_exact_snippet_atomically_and_never_commits(repo):
    head_before = subprocess.run(  # noqa: ASYNC221
        ["git", "rev-parse", "HEAD"],  # noqa: S607
        cwd=repo,
        capture_output=True,
        text=True,  # noqa: S607
    ).stdout
    old = 'request.args.get("url", "")'
    with pytest.raises(LocalError) as e:
        await local.apply_fix(str(repo), "app.py", "db = sqlite3.connect(DB_PATH)", "x")
    assert e.value.code == "ambiguous_match"
    with pytest.raises(LocalError) as e:
        await local.apply_fix(str(repo), "app.py", "not in the file", "x")
    assert e.value.code == "no_match"
    with pytest.raises(LocalError) as e:
        await local.apply_fix(str(repo), ".env", "STRIPE", "x")
    assert e.value.code == "not_tracked"
    assert _git_status(repo) == ""  # refusals changed nothing
    res = await local.apply_fix(
        str(repo), "app.py", old, 'allowlisted(request.args.get("url", ""))'
    )
    assert res["changed_lines"] == 2 and "+++ b/app.py" in res["diff"]
    assert _git_status(repo).strip() == "M app.py"
    head_after = subprocess.run(  # noqa: ASYNC221
        ["git", "rev-parse", "HEAD"],  # noqa: S607
        cwd=repo,
        capture_output=True,
        text=True,  # noqa: S607
    ).stdout
    assert head_after == head_before  # nothing committed
    assert not [p for p in repo.iterdir() if p.name.startswith(".secaudit-")]


def test_a_fix_must_be_minimal():
    text = "\n".join(f"line {i}" for i in range(200))
    with pytest.raises(LocalError) as e:
        local.plan_fix(text, text, text.replace("line", "LINE"))
    assert e.value.code == "fix_too_large"
