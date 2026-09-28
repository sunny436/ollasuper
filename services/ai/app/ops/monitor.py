"""The host monitor: File Library + storage health, alerting by email.

Runs as root from a systemd timer (deploy/66-library-ops.sh, every 5 minutes),
OUTSIDE the services it watches - so it still reports when one of them is the
thing that is down. Each run:

  1. collects metrics: disk free, the Library snapshot from Convex
     (/ops/library-health, its own secret), the AI plane's /readyz, the last
     blob-reclaim report, the newest backup manifest and backup status, and the
     last restore-drill result;
  2. prints one machine-readable `OPS_METRICS` line (journald keeps the
     history) and writes it to a JSON file;
  3. evaluates thresholds into alerts with STABLE keys;
  4. emails each NEW or ESCALATED alert, re-alerts a still-firing one after
     `realert_h`, and sends one RESOLVED notice when it clears (state file).

Nothing here depends on anyone looking at production. If the alert address or
the mail transport is missing, the run exits non-zero - systemd then shows the
unit as failed, which is the last line of defence.

Stdlib only. Thresholds and endpoints come from the environment
(/etc/myos/monitor.env).
"""

from __future__ import annotations

import glob
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

GIB = 1024**3


@dataclass(frozen=True)
class Config:
    convex_site: str = "http://127.0.0.1:3211"
    ops_secret: str = ""
    ai_url: str = "http://127.0.0.1:8770"
    disk_paths: tuple[str, ...] = ("/",)
    disk_warn_bytes: int = 6 * GIB
    disk_crit_bytes: int = 4 * GIB
    reclaim_reports: tuple[str, ...] = ("/var/lib/myos-reclaim/files.json",)
    reclaim_max_age_s: float = 2 * 3600
    orphan_warn_bytes: int = 1 * GIB
    backup_dir: str = "/opt/backups"
    backup_max_age_h: float = 26
    backup_status: str = "/var/lib/myos-backup/status.json"
    restore_status: str = "/var/lib/myos-backup/restore-drill.json"
    restore_max_age_d: float = 35
    failures_per_hour: int = 10
    processing_stale_ms: int = 30 * 60_000
    state_file: str = "/var/lib/myos-monitor/state.json"
    last_file: str = "/var/lib/myos-monitor/last.json"
    realert_h: float = 6
    alert_email: str = ""
    mail_base: str = "https://login.ollastack.com"
    mail_token: str = ""
    mailbox_id: str = ""
    host: str = "ollasuper-vm"

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> Config:
        e = os.environ if env is None else env

        def num(name: str, default: float) -> float:
            try:
                return float(e.get(name, default))
            except ValueError:
                return default

        def lst(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
            raw = e.get(name, "")
            return tuple(x.strip() for x in raw.split(",") if x.strip()) or default

        d = Config()
        return Config(
            convex_site=e.get("MONITOR_CONVEX_SITE", d.convex_site),
            ops_secret=e.get("OPS_HEALTH_SECRET", ""),
            ai_url=e.get("MONITOR_AI_URL", d.ai_url),
            disk_paths=lst("MONITOR_DISK_PATHS", d.disk_paths),
            disk_warn_bytes=int(num("MONITOR_DISK_WARN_BYTES", d.disk_warn_bytes)),
            disk_crit_bytes=int(num("MONITOR_DISK_CRIT_BYTES", d.disk_crit_bytes)),
            reclaim_reports=lst("MONITOR_RECLAIM_REPORTS", d.reclaim_reports),
            reclaim_max_age_s=num("MONITOR_RECLAIM_MAX_AGE_S", d.reclaim_max_age_s),
            orphan_warn_bytes=int(
                num("MONITOR_ORPHAN_WARN_BYTES", d.orphan_warn_bytes)
            ),
            backup_dir=e.get("MONITOR_BACKUP_DIR", d.backup_dir),
            backup_max_age_h=num("MONITOR_BACKUP_MAX_AGE_H", d.backup_max_age_h),
            backup_status=e.get("MONITOR_BACKUP_STATUS", d.backup_status),
            restore_status=e.get("MONITOR_RESTORE_STATUS", d.restore_status),
            restore_max_age_d=num("MONITOR_RESTORE_MAX_AGE_D", d.restore_max_age_d),
            failures_per_hour=int(
                num("MONITOR_FAILURES_PER_HOUR", d.failures_per_hour)
            ),
            processing_stale_ms=int(
                num("MONITOR_PROCESSING_STALE_MS", d.processing_stale_ms)
            ),
            state_file=e.get("MONITOR_STATE", d.state_file),
            last_file=e.get("MONITOR_LAST", d.last_file),
            realert_h=num("MONITOR_REALERT_H", d.realert_h),
            alert_email=e.get("OPS_ALERT_EMAIL", ""),
            mail_base=e.get("OLLASTACK_MAIL_BASE_URL", d.mail_base).rstrip("/"),
            mail_token=e.get("OLLASTACK_MAIL_TOKEN", ""),
            mailbox_id=e.get("OLLASTACK_MAILBOX_ID", ""),
            host=e.get("MONITOR_HOST", d.host),
        )


@dataclass(frozen=True)
class Alert:
    key: str
    severity: str  # "warning" | "critical"
    summary: str

    def rank(self) -> int:
        return 2 if self.severity == "critical" else 1


@dataclass
class Metrics:
    at: float
    disk: dict[str, int | None] = field(default_factory=dict)
    library: dict[str, Any] | None = None
    library_error: str | None = None
    ai: dict[str, Any] | None = None
    ai_error: str | None = None
    reclaim: dict[str, Any] = field(default_factory=dict)
    backup_age_h: float | None = None
    backup_status: dict[str, Any] | None = None
    restore: dict[str, Any] | None = None


# ------------------------------------------------------------------ collect


def _get_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers or {})  # noqa: S310 — fixed hosts
    try:
        with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return {"_status": e.code, **json.loads(body)}
        except ValueError:
            return {"_status": e.code}


def _read_json(path: str) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.loads(fh.read() or "null")
    except (OSError, ValueError):
        return None


def collect(cfg: Config, now: float | None = None) -> Metrics:
    now = time.time() if now is None else now
    m = Metrics(at=now)
    for p in cfg.disk_paths:
        try:
            st = os.statvfs(p)
            m.disk[p] = st.f_bavail * st.f_frsize
        except (AttributeError, OSError):
            m.disk[p] = None
    try:
        m.library = _get_json(
            f"{cfg.convex_site}/ops/library-health", {"x-ops-key": cfg.ops_secret}
        )
        if m.library.get("_status"):
            m.library_error = f"HTTP {m.library['_status']}"
    except (OSError, ValueError) as e:
        m.library_error = type(e).__name__
    try:
        m.ai = _get_json(f"{cfg.ai_url}/readyz")
    except (OSError, ValueError) as e:
        m.ai_error = type(e).__name__
    for path in cfg.reclaim_reports:
        m.reclaim[path] = _read_json(path) or {}
    manifests = sorted(glob.glob(os.path.join(cfg.backup_dir, "manifest-*.txt")))
    if manifests:
        newest = max(manifests, key=os.path.getmtime)
        m.backup_age_h = (now - os.path.getmtime(newest)) / 3600
    m.backup_status = _read_json(cfg.backup_status)
    m.restore = _read_json(cfg.restore_status)
    return m


# ------------------------------------------------------------------ evaluate


def _mb(n: float) -> str:
    return f"{n / (1024 * 1024):.0f} MB"


def evaluate(cfg: Config, m: Metrics) -> list[Alert]:
    out: list[Alert] = []
    for path, free in m.disk.items():
        if free is None:
            continue
        if free < cfg.disk_crit_bytes:
            out.append(
                Alert(
                    f"DISK_LOW:{path}",
                    "critical",
                    f"Disk {path} has {_mb(free)} free (critical floor "
                    f"{_mb(cfg.disk_crit_bytes)}); uploads are being refused.",
                )
            )
        elif free < cfg.disk_warn_bytes:
            out.append(
                Alert(
                    f"DISK_LOW:{path}",
                    "warning",
                    f"Disk {path} has {_mb(free)} free (warning floor "
                    f"{_mb(cfg.disk_warn_bytes)}).",
                )
            )
    if m.library_error or m.library is None:
        out.append(
            Alert(
                "CONVEX_UNREACHABLE",
                "critical",
                f"Convex Library health unreadable: {m.library_error}",
            )
        )
    else:
        lib = m.library
        ceiling = float(lib.get("uploadCeilingBytes") or 0)
        used = float(lib.get("uploadBytes") or 0)
        if ceiling and used >= ceiling:
            out.append(
                Alert(
                    "UPLOAD_CEILING",
                    "critical",
                    f"Upload ceiling reached: {_mb(used)} of {_mb(ceiling)}.",
                )
            )
        elif ceiling and used >= 0.9 * ceiling:
            out.append(
                Alert(
                    "UPLOAD_CEILING",
                    "warning",
                    f"Uploads at {used / ceiling:.0%} of the {_mb(ceiling)} ceiling.",
                )
            )
        if int(lib.get("failedLastHour") or 0) >= cfg.failures_per_hour:
            out.append(
                Alert(
                    "PROCESSING_FAILURE_SPIKE",
                    "warning",
                    f"{lib['failedLastHour']} files failed processing "
                    "in the last hour.",
                )
            )
        if int(lib.get("retryOverdue") or 0) > 0:
            out.append(
                Alert(
                    "RETRY_STALLED",
                    "warning",
                    f"{lib['retryOverdue']} automatic retries are overdue "
                    "(the retry cron is not running).",
                )
            )
        if int(lib.get("oldestProcessingAgeMs") or 0) > cfg.processing_stale_ms:
            mins = int(lib["oldestProcessingAgeMs"]) // 60_000
            out.append(
                Alert(
                    "PROCESSING_STALE",
                    "warning",
                    f"A file has been processing for {mins} minutes.",
                )
            )
        dead = int(lib.get("deadLettered") or 0)
        if dead > 0:
            out.append(
                Alert(
                    "DEAD_LETTERS",
                    "warning",
                    f"{dead} files are dead-lettered (failed for good; "
                    "users can retry them by hand).",
                )
            )
    if m.ai_error or m.ai is None:
        out.append(
            Alert(
                "AI_DOWN",
                "critical",
                f"The AI plane /readyz is unreachable: {m.ai_error}",
            )
        )
    else:
        lib_ai = m.ai.get("library") or {}
        sandbox = lib_ai.get("sandbox") or {}
        if sandbox and not sandbox.get("meets_minimum", True):
            out.append(
                Alert(
                    "SANDBOX_BELOW_MINIMUM",
                    "critical",
                    f"Decoders refuse to run: sandbox tier {sandbox.get('tier')} "
                    f"is below the required {sandbox.get('min_tier')}.",
                )
            )
        if lib_ai and lib_ai.get("index_dimension_ok") is False:
            out.append(
                Alert(
                    "INDEX_DIMENSION",
                    "critical",
                    "The embedding dimension does not fit the index column; "
                    "ingestion is refusing every file.",
                )
            )
        if not m.ai.get("ready", False):
            out.append(
                Alert("AI_NOT_READY", "warning", "The AI plane reports not ready.")
            )
    for path, rep in m.reclaim.items():
        at = float(rep.get("at") or 0)
        if not rep or m.at - at > cfg.reclaim_max_age_s:
            out.append(
                Alert(
                    f"RECLAIM_NOT_RUNNING:{path}",
                    "warning",
                    f"Blob reclamation has not reported recently ({path}).",
                )
            )
        elif rep.get("status") == "stopped":
            out.append(
                Alert(
                    f"RECLAIM_STOPPED:{path}",
                    "critical",
                    f"Blob reclamation stopped itself: {rep.get('message')}",
                )
            )
        elif int(rep.get("candidate_bytes") or 0) > cfg.orphan_warn_bytes:
            out.append(
                Alert(
                    f"ORPHANS:{path}",
                    "warning",
                    f"{rep.get('candidates')} orphaned blobs "
                    f"({_mb(int(rep['candidate_bytes']))}) are waiting "
                    "for reclamation.",
                )
            )
    if m.backup_age_h is None:
        out.append(Alert("BACKUP_MISSING", "critical", "No backup manifest found."))
    elif m.backup_age_h > cfg.backup_max_age_h:
        out.append(
            Alert(
                "BACKUP_STALE",
                "critical",
                f"The newest backup is {m.backup_age_h:.0f} hours old.",
            )
        )
    if m.backup_status and m.backup_status.get("ok") is False:
        out.append(
            Alert(
                "BACKUP_FAILED",
                "critical",
                f"The last backup failed: {m.backup_status.get('error', '')}",
            )
        )
    if not m.restore:
        out.append(
            Alert(
                "RESTORE_DRILL_MISSING",
                "warning",
                "No restore drill has been recorded.",
            )
        )
    else:
        age_d = (m.at - float(m.restore.get("at") or 0)) / 86400
        if m.restore.get("ok") is False:
            out.append(
                Alert(
                    "RESTORE_DRILL_FAILED",
                    "critical",
                    f"The last restore drill FAILED: {m.restore.get('summary', '')}",
                )
            )
        elif age_d > cfg.restore_max_age_d:
            out.append(
                Alert(
                    "RESTORE_DRILL_STALE",
                    "warning",
                    f"The last successful restore drill was {age_d:.0f} days ago.",
                )
            )
    return out


# ------------------------------------------------------------------ dedupe


def plan(
    state: dict[str, Any], alerts: list[Alert], now: float, realert_h: float
) -> tuple[list[Alert], list[str], dict[str, Any]]:
    """(alerts to send now, keys resolved since last run, the next state)."""
    send: list[Alert] = []
    nxt: dict[str, Any] = {}
    for a in alerts:
        prev = state.get(a.key)
        escalated = prev is not None and a.rank() > int(prev.get("rank", 0))
        stale = prev is not None and now - float(prev.get("sent", 0)) > realert_h * 3600
        if prev is None or escalated or stale:
            send.append(a)
            nxt[a.key] = {
                "rank": a.rank(),
                "sent": now,
                "since": prev["since"] if prev else now,
            }
        else:
            nxt[a.key] = prev
    resolved = [k for k in state if k not in nxt]
    return send, resolved, nxt


# ------------------------------------------------------------------ deliver


def send_mail(cfg: Config, subject: str, text: str) -> bool:
    if not (cfg.alert_email and cfg.mail_token and cfg.mailbox_id):
        return False
    body = json.dumps(
        {"to": cfg.alert_email, "subject": subject, "text": text}
    ).encode()
    req = urllib.request.Request(  # noqa: S310 — the configured provider
        f"{cfg.mail_base}/api/mailboxes/{cfg.mailbox_id}/send",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {cfg.mail_token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
            return 200 <= r.status < 300
    except (OSError, urllib.error.HTTPError):
        return False


def _write_json(path: str, value: Any) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, sort_keys=True)
    os.replace(tmp, path)


def run(cfg: Config, now: float | None = None) -> int:
    now = time.time() if now is None else now
    m = collect(cfg, now)
    alerts = evaluate(cfg, m)
    line = {"event": "OPS_METRICS", **m.__dict__, "alerts": [a.key for a in alerts]}
    print(json.dumps(line, sort_keys=True, default=str))
    _write_json(cfg.last_file, line)
    state = _read_json(cfg.state_file) or {}
    send, resolved, nxt = plan(state, alerts, now, cfg.realert_h)
    undeliverable = False
    for a in send:
        ok = send_mail(
            cfg,
            f"[{a.severity.upper()}] OllaSuper {a.key.split(':')[0]} on {cfg.host}",
            f"{a.summary}\n\nAlert key: {a.key}\nHost: {cfg.host}\n"
            f"Re-sent every {cfg.realert_h:.0f} h while it lasts; a RESOLVED notice "
            "follows when it clears.",
        )
        if not ok:
            undeliverable = True
            nxt.pop(a.key, None)  # try again next run
    for key in resolved:
        send_mail(
            cfg,
            f"[RESOLVED] OllaSuper {key.split(':')[0]} on {cfg.host}",
            f"{key} is no longer firing.\nHost: {cfg.host}",
        )
    _write_json(cfg.state_file, nxt)
    if undeliverable:
        print(
            json.dumps(
                {"event": "OPS_ALERT_UNDELIVERABLE", "alerts": [a.key for a in send]}
            )
        )
        return 2
    return 0


def main() -> int:
    return run(Config.from_env())


if __name__ == "__main__":
    raise SystemExit(main())
