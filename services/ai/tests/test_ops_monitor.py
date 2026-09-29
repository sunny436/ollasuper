"""The host monitor: thresholds -> alerts, and the dedupe that keeps email sane."""

from __future__ import annotations

import json

from app.ops import monitor
from app.ops.monitor import GIB, Alert, Config, Metrics, evaluate, plan

NOW = 2_000_000_000.0
CFG = Config()


def _healthy(**over) -> Metrics:
    m = Metrics(
        at=NOW,
        disk={"/": 20 * GIB},
        library={
            "uploadBytes": 10,
            "uploadCeilingBytes": 1000,
            "failedLastHour": 0,
            "retryOverdue": 0,
            "oldestProcessingAgeMs": 0,
            "deadLettered": 0,
            "deadLetteredLastDay": 0,
        },
        ai={
            "ready": True,
            "library": {"sandbox": {"meets_minimum": True}, "index_dimension_ok": True},
        },
        reclaim={"/r.json": {"at": NOW - 60, "status": "ok", "candidate_bytes": 0}},
        backup_age_h=3,
        backup_status={"ok": True},
        restore={"ok": True, "at": NOW - 86400},
    )
    for k, v in over.items():
        setattr(m, k, v)
    return m


def _keys(m: Metrics) -> set[str]:
    return {a.key.split(":")[0] for a in evaluate(CFG, m)}


def test_a_healthy_host_raises_nothing():
    assert evaluate(CFG, _healthy()) == []


def test_every_failure_mode_has_its_own_stable_alert():
    assert _keys(_healthy(disk={"/": 5 * GIB})) == {"DISK_LOW"}
    assert [a.severity for a in evaluate(CFG, _healthy(disk={"/": 1 * GIB}))] == [
        "critical"
    ]
    assert _keys(_healthy(library=None, library_error="URLError")) == {
        "CONVEX_UNREACHABLE"
    }
    lib = _healthy().library
    assert _keys(_healthy(library={**lib, "uploadBytes": 950})) == {"UPLOAD_CEILING"}
    assert _keys(_healthy(library={**lib, "failedLastHour": 12})) == {
        "PROCESSING_FAILURE_SPIKE"
    }
    assert _keys(_healthy(library={**lib, "retryOverdue": 2})) == {"RETRY_STALLED"}
    assert _keys(_healthy(library={**lib, "deadLetteredLastDay": 3})) == {
        "DEAD_LETTERS"
    }
    assert _keys(_healthy(library={**lib, "oldestProcessingAgeMs": 3_600_000})) == {
        "PROCESSING_STALE"
    }
    assert _keys(_healthy(ai=None, ai_error="ConnectionRefused")) == {"AI_DOWN"}
    below = {
        "ready": False,
        "library": {"sandbox": {"meets_minimum": False, "tier": 2, "min_tier": 1}},
    }
    assert _keys(_healthy(ai=below)) == {"SANDBOX_BELOW_MINIMUM", "AI_NOT_READY"}
    assert _keys(_healthy(reclaim={"/r.json": {}})) == {"RECLAIM_NOT_RUNNING"}
    stopped = {"at": NOW, "status": "stopped", "message": "ceiling"}
    assert _keys(_healthy(reclaim={"/r.json": stopped})) == {"RECLAIM_STOPPED"}
    big = {"at": NOW, "status": "ok", "candidates": 900, "candidate_bytes": 3 * GIB}
    assert _keys(_healthy(reclaim={"/r.json": big})) == {"ORPHANS"}
    assert _keys(_healthy(backup_age_h=40)) == {"BACKUP_STALE"}
    assert _keys(_healthy(backup_age_h=None)) == {"BACKUP_MISSING"}
    assert _keys(_healthy(backup_status={"ok": False, "error": "x"})) == {
        "BACKUP_FAILED"
    }
    assert _keys(_healthy(restore=None)) == {"RESTORE_DRILL_MISSING"}
    assert _keys(_healthy(restore={"ok": False, "at": NOW})) == {"RESTORE_DRILL_FAILED"}
    assert _keys(_healthy(restore={"ok": True, "at": NOW - 40 * 86400})) == {
        "RESTORE_DRILL_STALE"
    }


def test_dedupe_sends_new_escalated_and_stale_alerts_once_and_resolves():
    warn = Alert("DISK_LOW:/", "warning", "low")
    crit = Alert("DISK_LOW:/", "critical", "very low")
    send, resolved, state = plan({}, [warn], NOW, realert_h=6)
    assert send == [warn] and resolved == []
    # Still firing, same severity, within the re-alert window: silent.
    send, _, state = plan(state, [warn], NOW + 60, realert_h=6)
    assert send == []
    # Escalation is sent at once.
    send, _, state = plan(state, [crit], NOW + 120, realert_h=6)
    assert send == [crit]
    # Still firing past the window: re-sent.
    send, _, state = plan(state, [crit], NOW + 7 * 3600, realert_h=6)
    assert send == [crit]
    # Cleared: one RESOLVED, and the state forgets it.
    send, resolved, state = plan(state, [], NOW + 8 * 3600, realert_h=6)
    assert send == [] and resolved == ["DISK_LOW:/"] and state == {}


def test_the_config_reads_its_environment():
    cfg = Config.from_env(
        {
            "OPS_ALERT_EMAIL": "ops@example.com",
            "MONITOR_DISK_PATHS": "/, /opt",
            "MONITOR_DISK_CRIT_BYTES": "123",
        }
    )
    assert cfg.alert_email == "ops@example.com"
    assert cfg.disk_paths == ("/", "/opt")
    assert cfg.disk_crit_bytes == 123


def test_each_sandbox_layer_that_regresses_is_named():
    full = {"meets_minimum": True, "pid_namespace": "shared", "readonly_fs": True,
            "proc_isolated": True}
    ok = {"ready": True, "library": {"sandbox": full, "index_dimension_ok": True}}
    assert _keys(_healthy(ai=ok)) == set()
    for layer, bad in (("readonly_fs", False), ("proc_isolated", False),
                       ("pid_namespace", "")):
        ai = {"ready": True, "library": {"sandbox": {**full, layer: bad},
                                         "index_dimension_ok": True}}
        alerts = evaluate(CFG, _healthy(ai=ai))
        assert [a.key for a in alerts] == ["SANDBOX_DEGRADED"]
        assert layer in alerts[0].summary and alerts[0].severity == "critical"


def test_a_sandbox_that_cannot_start_now_is_critical_while_the_probes_read_green():
    """Production 29-09-2026: every boot-time probe true, every decode refused.
    Only the live start tells, and it must name the step that failed."""
    full = {"meets_minimum": True, "pid_namespace": "shared", "readonly_fs": True,
            "proc_isolated": True}
    live_ok = {**full, "live": {"ok": True, "rc": 0, "ms": 40}}
    ok = {"ready": True, "library": {"sandbox": live_ok, "index_dimension_ok": True}}
    assert _keys(_healthy(ai=ok)) == set()
    broken = {**full, "live": {"ok": False, "rc": 97, "step": "mask /srv/.env"}}
    ai = {"ready": False, "library": {"sandbox": broken, "index_dimension_ok": True}}
    alerts = {a.key: a for a in evaluate(CFG, _healthy(ai=ai))}
    assert set(alerts) == {"SANDBOX_BROKEN", "AI_NOT_READY"}
    assert alerts["SANDBOX_BROKEN"].severity == "critical"
    assert "mask /srv/.env" in alerts["SANDBOX_BROKEN"].summary
    # A spawn that timed out names no step: the exit is reported instead.
    hung = {**full, "live": {"ok": False, "rc": None, "step": "timeout"}}
    ai = {"ready": False, "library": {"sandbox": hung, "index_dimension_ok": True}}
    assert "timeout" in {a.key: a for a in evaluate(CFG, _healthy(ai=ai))}[
        "SANDBOX_BROKEN"
    ].summary


def test_old_dead_letters_and_corrupt_files_do_not_page_anyone():
    """A dead letter older than a day (already alerted) and a user's corrupt
    file (a non-retryable code, counted apart as failedFinal) raise nothing."""
    lib = _healthy().library
    quiet = {**lib, "deadLettered": 4, "deadLetteredLastDay": 0, "failedFinal": 9}
    assert _keys(_healthy(library=quiet)) == set()


# ------------------------------------------------------------------ delivery


class _Resp:
    def __init__(self, status: int, body: dict) -> None:
        self.status = status
        self._body = json.dumps(body).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a) -> None:
        return None


MAIL = Config(alert_email="ops@example.com", mail_token="t", mailbox_id="m")


def test_an_alert_counts_as_sent_only_when_the_provider_took_custody(monkeypatch):
    seen = []

    def fake(req, timeout):
        seen.append(req)
        return _Resp(200, {"data": {"deliveryStatus": status}})

    monkeypatch.setattr(monitor.urllib.request, "urlopen", fake)
    cases = (("sent", True), ("sending", True), ("dry_run", False), ("failed", False))
    for status, want in cases:
        assert monitor.send_mail(MAIL, "s", "t") is want, status
    # Cloudflare refuses urllib's default signature (error 1010): a real UA is sent.
    assert all(r.get_header("User-agent") == monitor.USER_AGENT for r in seen)


def test_a_refused_or_unreachable_provider_is_undeliverable(monkeypatch):
    def refused(req, timeout):
        raise monitor.urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr(monitor.urllib.request, "urlopen", refused)
    assert monitor.send_mail(MAIL, "s", "t") is False
    def down(req, timeout):
        raise OSError("down")

    monkeypatch.setattr(monitor.urllib.request, "urlopen", down)
    assert monitor.send_mail(MAIL, "s", "t") is False
    # No address, token or mailbox: nothing is attempted, and it is not "sent".
    assert monitor.send_mail(Config(), "s", "t") is False
