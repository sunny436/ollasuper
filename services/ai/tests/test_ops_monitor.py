"""The host monitor: thresholds -> alerts, and the dedupe that keeps email sane."""

from __future__ import annotations

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
    assert _keys(_healthy(library={**lib, "deadLettered": 3})) == {"DEAD_LETTERS"}
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
