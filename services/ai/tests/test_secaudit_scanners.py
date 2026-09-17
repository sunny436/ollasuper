"""The production scanner wrapper: configured scanners only, pinned rules/config,
isolated, bounded — and every way a scanner can fail is reported, never clean."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import anyio
import pytest

from app.secaudit import scanners
from app.secaudit.intent import detect
from app.secaudit.local import LocalAccess
from app.secaudit.report import Read, SecurityTurn
from qa.secaudit_fixture import build, planted

pytestmark = pytest.mark.anyio


def _sarif(tool: str, rule: str, path: str, line: int, text: str) -> dict:
    return {
        "runs": [
            {
                "tool": {"driver": {"name": tool}},
                "results": [
                    {
                        "ruleId": rule,
                        "level": "error",
                        "message": {"text": text},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": path},
                                    "region": {"startLine": line},
                                }
                            }
                        ],
                    }
                ],
            }
        ]
    }


def _fake(bindir: Path, name: str, *, out: str = "", code: int = 0) -> Path:
    """A fake scanner that records its argv + TMPDIR and prints `out`."""
    payload = bindir / f"{name}.out"
    payload.write_text(out)
    argv_file = bindir / f"{name}.argv"
    if sys.platform == "win32":
        exe = bindir / f"{name}.bat"
        exe.write_text(
            f'@echo off\necho %* TMPDIR=%TMPDIR% > "{argv_file}"\n'
            f'type "{payload}"\nexit /b {code}\n'
        )
    else:
        exe = bindir / name
        exe.write_text(
            f"#!/bin/sh\necho \"$@ TMPDIR=$TMPDIR\" > '{argv_file}'\n"
            f"cat '{payload}'\nexit {code}\n"
        )
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return argv_file


@pytest.fixture
def bindir(tmp_path) -> Path:
    d = tmp_path / "bin"
    d.mkdir()
    return d


async def test_configured_scanners_run_with_pinned_rules_and_config(bindir, tmp_path):
    token = planted()["github_token"]
    og_argv = _fake(
        bindir,
        "opengrep",
        out=json.dumps(
            _sarif(
                "Opengrep OSS",
                "opt.myos.rules.py-sql-built-from-strings",
                "app.py",
                15,
                "SQL built from strings",
            )
        ),
    )
    gl_argv = _fake(
        bindir,
        "gitleaks",
        code=1,
        out=json.dumps(
            _sarif(
                "gitleaks",
                "github-pat",
                "config.py",
                2,
                f"github-pat has detected secret {token}",
            )
        ),
    )
    (bindir / "gitleaks.toml").write_text("title = 'pinned default'\n")
    res = await scanners.run_sarif_scanners(
        str(tmp_path),
        30,
        enabled=("opengrep", "gitleaks", "trivy"),
        bin_dir=str(bindir),
    )
    assert res["opengrep"]["status"] == "ran"
    assert res["opengrep"]["findings"][0]["rule"] == "py-sql-built-from-strings"
    assert res["gitleaks"]["status"] == "ran"  # exit 1 = leaks found, not a failure
    assert res["trivy"] == {"status": "not_installed"}
    og = og_argv.read_text()
    assert str(scanners.DEFAULT_RULES) in og and " auto" not in og
    assert "--disable-version-check" in og
    gl = gl_argv.read_text()
    assert str(bindir / "gitleaks.toml") in gl and "--ignore-gitleaks-allow" in gl
    assert "--redact" in gl and "--gitleaks-ignore-path" in gl
    # Scratch files go to a private TMPDIR that is removed after the run.
    scratch = og.rsplit("TMPDIR=", 1)[1].strip()
    assert "secaudit-tmp-" in scratch and not await anyio.Path(scratch).exists()
    assert token not in json.dumps(res)  # SARIF messages are redacted too
    # Only CONFIGURED scanners are attempted.
    only = await scanners.run_sarif_scanners(
        str(tmp_path), 30, enabled=("gitleaks",), bin_dir=str(bindir)
    )
    assert set(only) == {"gitleaks"}


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ("exit2", "exit 2"),
        ("bad-sarif", "unreadable SARIF output"),
        ("no-rules", "ruleset not found"),
        ("no-gitleaks-config", "pinned gitleaks.toml not found next to the binary"),
        ("unknown", "unknown scanner"),
    ],
)
async def test_every_scanner_failure_is_failed_never_clean(
    bindir, tmp_path, case, expected
):
    enabled, rules = ("opengrep",), ""
    if case == "exit2":
        _fake(bindir, "opengrep", out="", code=2)
    elif case == "bad-sarif":
        _fake(bindir, "opengrep", out="not json at all")
    elif case == "no-rules":
        _fake(bindir, "opengrep", out=json.dumps({"runs": []}))
        rules = str(tmp_path / "missing.yaml")
    elif case == "no-gitleaks-config":
        _fake(bindir, "gitleaks", out=json.dumps({"runs": []}))
        enabled = ("gitleaks",)
    else:
        enabled = ("definitely-not-a-scanner",)
    res = await scanners.run_sarif_scanners(
        str(tmp_path), 30, enabled=enabled, bin_dir=str(bindir), rules=rules
    )
    [r] = res.values()
    assert r["status"] == "failed" and expected in r["reason"]


async def test_a_hung_scanner_times_out_as_failed(bindir, tmp_path, monkeypatch):
    _fake(bindir, "opengrep", out=json.dumps({"runs": []}))

    def hang(*a, **k):
        raise subprocess.TimeoutExpired(cmd="opengrep", timeout=1)

    monkeypatch.setattr(scanners.subprocess, "run", hang)
    res = await scanners.run_sarif_scanners(
        str(tmp_path), 1, enabled=("opengrep",), bin_dir=str(bindir)
    )
    assert res["opengrep"] == {"status": "failed", "reason": "timeout"}


def test_a_failed_or_missing_scanner_never_makes_the_report_clean():
    s = SecurityTurn(
        intent=detect("security audit of the fixture repo"),
        user_id="u1",
        local=LocalAccess(),
        read_only=True,
    )
    s.local_access["fixture"] = "verified"
    s.add_read(
        Read(
            source="local",
            repo="fixture",
            path="app.py",
            text="x = 1\n",
            shown=[(1, 1)],
        )
    )
    s.validate({"kind": "local", "repo": "fixture"}, "", [])
    s.set_stage("sast:gitleaks", "not_installed")
    assert s.verdict(deadline=False)[0] == "NO CONFIRMED FINDINGS IN SCANNED SCOPE"
    assert "Not installed on this host (not run): sast:gitleaks" in s.render()
    s.set_stage("sast:opengrep", "failed", reason="timeout")
    verdict, why = s.verdict(deadline=False)
    assert verdict == "INCOMPLETE" and any("sast:opengrep" in w for w in why)


@pytest.mark.skipif(
    not (os.name == "posix" and shutil.which("opengrep", path="/opt/secaudit/bin")),
    reason="the real opengrep binary is installed on the VM only",
)
async def test_the_first_party_rules_find_the_fixture_bugs(tmp_path):
    build(tmp_path / "fixture")
    res = await scanners.run_sarif_scanners(
        str(tmp_path / "fixture"),
        120,
        enabled=("opengrep",),
        bin_dir="/opt/secaudit/bin",
    )
    assert res["opengrep"]["status"] == "ran", res
    rules = {f["rule"] for f in res["opengrep"]["findings"]}
    assert {
        "py-sql-built-from-strings",
        "py-request-data-to-outbound-fetch",
        "py-request-data-to-file-path",
    } <= rules


@pytest.mark.skipif(
    not (os.name == "posix" and shutil.which("gitleaks", path="/opt/secaudit/bin")),
    reason="the real gitleaks binary is installed on the VM only",
)
async def test_real_gitleaks_finds_committed_secrets_and_never_leaks_them(tmp_path):
    secrets_ = build(tmp_path / "fixture")
    res = await scanners.run_sarif_scanners(
        str(tmp_path / "fixture"),
        120,
        enabled=("gitleaks",),
        bin_dir="/opt/secaudit/bin",
    )
    assert res["gitleaks"]["status"] == "ran", res
    assert {f["path"] for f in res["gitleaks"]["findings"]} == {"config.py"}
    assert not any(v in json.dumps(res) for v in secrets_.values())
