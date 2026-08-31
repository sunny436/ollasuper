#!/usr/bin/env bash
# Provision the Scheduled Tasks scheduler: DBOS system database + systemd unit.
#
# ARCHITECTURE, in one paragraph. DBOS Transact is a LIBRARY, not a service —
# it needs a PostgreSQL for its workflow state and nothing else. That database
# goes into the EXISTING knowledge-db container (services/ai/compose.knowledge.yml)
# as a separate database `myos_dbos`, for the same reason the knowledge DB is
# there in the first place: Convex's own cluster (`convex_self_hosted`) is the
# highest-risk surface in this system and is never touched. No new container, no
# new volume, no new port.
#
# NOTHING IN THIS SCRIPT REACHES A CLOUD SERVICE. DBOS Conductor is opt-in via a
# `conductor_key`, which app/scheduler/main.py never sets.
#
# Idempotent: safe to re-run. Existing role, database, .env keys and unit are
# left alone.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
export UV_PYTHON_INSTALL_DIR=${UV_PYTHON_INSTALL_DIR:-/opt/uv-python}

REPO=${REPO:-/opt/myos}
AI="$REPO/services/ai"
COMPOSE="$AI/compose.knowledge.yml"
ENVF="$AI/.env"

[ -f "$ENVF" ]   || { echo "FATAL: $ENVF missing — run deploy/54-ai-service.sh first" >&2; exit 1; }
[ -f "$COMPOSE" ]|| { echo "FATAL: $COMPOSE missing — run deploy/70-knowledge-db.sh first" >&2; exit 1; }

add_env() {
  local key="$1" val="$2"
  if ! grep -q "^${key}=" "$ENVF"; then
    printf '%s=%s\n' "$key" "$val" >> "$ENVF"
    echo "  wrote $key"
  else
    echo "  $key already set — leaving it"
  fi
}

echo "[1/9] the knowledge-db container must be up (it hosts myos_dbos too)"
CID=$(docker compose -f "$COMPOSE" --env-file "$ENVF" ps -q knowledge-db 2>/dev/null || true)
[ -n "$CID" ] || { echo "FATAL: knowledge-db is not running — run deploy/70-knowledge-db.sh" >&2; exit 1; }
echo "  container $CID"

echo "[2/9] role + database (idempotent)"
if ! grep -q '^SCHEDULER_DB_PASSWORD=' "$ENVF"; then
  SPW=$(openssl rand -hex 24)
  add_env SCHEDULER_DB_PASSWORD "$SPW"
else
  SPW=$(grep '^SCHEDULER_DB_PASSWORD=' "$ENVF" | head -1 | cut -d= -f2-)
fi

# Peer auth inside the container, so no password ever appears in argv or in the
# shell history on the host.
docker exec -i "$CID" psql -U myos_ai -d myos_knowledge -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myos_dbos') THEN
    CREATE ROLE myos_dbos LOGIN PASSWORD '${SPW}';
  ELSE
    ALTER ROLE myos_dbos WITH PASSWORD '${SPW}';
  END IF;
END
\$\$;
SQL

# CREATE DATABASE cannot run inside a transaction block, hence the separate call
# and the explicit existence check. DBOS creates its own SCHEMA on first launch
# (run_migrations), but it does NOT create the database — same trap as the
# Convex backend, which exits FATAL "database ... does not exist".
if ! docker exec -i "$CID" psql -U myos_ai -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='myos_dbos'" | grep -q 1; then
  docker exec -i "$CID" psql -U myos_ai -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE myos_dbos OWNER myos_dbos"
  echo "  created database myos_dbos"
else
  echo "  database myos_dbos already exists"
fi

echo "[3/9] connection URL + flag"
# sslmode=disable: loopback needs no TLS, and the host snakeoil cert has no IP
# SAN anyway — the same reasoning as KNOWLEDGE_DATABASE_URL and POSTGRES_URL.
add_env SCHEDULER_DATABASE_URL "postgresql://myos_dbos:${SPW}@127.0.0.1:5433/myos_dbos?sslmode=disable"
add_env AI_SCHEDULED_TASKS_ENABLED "false"
chmod 600 "$ENVF"; chown root:root "$ENVF"

echo "[4/9] deps (dbos + tzdata are in uv.lock)"
cd "$AI"
uv sync --frozen --no-dev

echo "[5/9] HARD GATE: the scheduler must import and resolve IANA zones"
# tzdata is a DECLARED dependency, not an accident of the host OS. If it ever
# stops resolving, every task silently stops producing occurrences — so fail
# the deploy here instead.
uv run python - <<'PY'
from zoneinfo import ZoneInfo
for z in ("Asia/Kolkata", "America/New_York", "Europe/London"):
    ZoneInfo(z)
import app.scheduler.main  # noqa: F401  — import-time DBOS registration
print("  scheduler imports OK; tzdata resolves OK")
PY

echo "[6/9] systemd"
sed "s|/opt/myos|$REPO|g" "$AI/systemd/myos-scheduler.service" \
  > /etc/systemd/system/myos-scheduler.service
systemctl daemon-reload
systemctl enable myos-scheduler.service

# Deliberately NOT started here. AI_SCHEDULED_TASKS_ENABLED defaults to false,
# so a start would be a no-op anyway; flipping the flag is an explicit,
# reviewed step, not a side effect of running a deploy script.
echo "[7/9] resource limits, DERIVED from this box (not guessed)"
# Written as systemd drop-ins rather than baked into the unit files, because the
# right numbers depend on the machine. A hardcoded MemoryMax sized for a
# different VM is worse than none: too low and the kernel OOM-kills a healthy
# service, too high and it protects nothing.
#
# Under MemoryMax the kernel kills the unit; Restart=on-failure brings it back
# and DBOS recovers its workflows, so the failure mode is degraded-and-noisy
# rather than corrupt. MemoryHigh throttles first, which usually avoids the kill.
TOTAL_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
echo "  MemTotal: ${TOTAL_MB}MB"

# The scheduler is one asyncio loop with no rendering and no model I/O; it is
# small and its ceiling is a backstop, not a budget.
SCHED_HIGH=384; SCHED_MAX=512
# myos-ai carries chat plus one PDF pool worker (reportlab+matplotlib is a few
# hundred MB RSS). Scale to the box, clamped to a sane band.
AI_MAX=$(( TOTAL_MB / 2 ))
[ "$AI_MAX" -lt 1536 ] && AI_MAX=1536
[ "$AI_MAX" -gt 3072 ] && AI_MAX=3072
AI_HIGH=$(( AI_MAX * 2 / 3 ))

write_limits() {
  local unit="$1" high="$2" max="$3" cpu="$4" tasks="$5"
  install -d "/etc/systemd/system/${unit}.d"
  cat > "/etc/systemd/system/${unit}.d/limits.conf" <<EOF
# GENERATED by deploy/71-scheduled-tasks.sh from this host's MemTotal
# (${TOTAL_MB}MB). Re-run the script after changing the VM's memory.
[Service]
MemoryHigh=${high}M
MemoryMax=${max}M
CPUQuota=${cpu}
TasksMax=${tasks}
EOF
  echo "  ${unit}: MemoryHigh=${high}M MemoryMax=${max}M CPUQuota=${cpu}"
}
write_limits myos-scheduler.service "$SCHED_HIGH" "$SCHED_MAX" "50%" 256
if [ -f /etc/systemd/system/myos-ai.service ]; then
  write_limits myos-ai.service "$AI_HIGH" "$AI_MAX" "200%" 512
fi
systemctl daemon-reload

echo "[8/9] HARD GATE: headroom, and the email transport"
# Refuse to arm the feature on a box that cannot carry it. Enabling the flag is
# the only irreversible-ish step here (it starts executing real work), so the
# check belongs in front of it rather than in a runbook.
AVAIL_MB=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
NEED_MB=$(( SCHED_MAX + 512 ))
DISK_MB=$(df -Pm /opt | awk 'NR==2{print $4}')
echo "  MemAvailable=${AVAIL_MB}MB (need ${NEED_MB}MB)  disk=/opt ${DISK_MB}MB free (need 5120MB)"

GATE_OK=1
[ "$AVAIL_MB" -ge "$NEED_MB" ] || { echo "  FAIL: not enough free memory" >&2; GATE_OK=0; }
[ "${DISK_MB:-0}" -ge 5120 ] || { echo "  FAIL: not enough free disk on /opt" >&2; GATE_OK=0; }

# The mail transport must be named, never inferred. SMTP on this host points at
# Mailpit, a local catcher — selecting it in production would silently swallow
# every report while the UI reported success.
TRANSPORT=$(grep '^SCHEDULED_EMAIL_TRANSPORT=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- || true)
if [ "$TRANSPORT" = "smtp" ] && [ "${ALLOW_SMTP_TRANSPORT:-0}" != "1" ]; then
  echo "  FAIL: SCHEDULED_EMAIL_TRANSPORT=smtp is refused on this host — SMTP_HOST is Mailpit," >&2
  echo "        so reports would be swallowed locally. Use 'resend', or set" >&2
  echo "        ALLOW_SMTP_TRANSPORT=1 if this really is the replica." >&2
  GATE_OK=0
fi
add_env SCHEDULED_EMAIL_TRANSPORT "disabled"
add_env SCHEDULED_DELIVERY_ENABLED "false"
chmod 600 "$ENVF"; chown root:root "$ENVF"

echo "[9/9] port 3001 stays shut"
# DBOS's admin server is NOT enabled (run_admin_server is false in
# build_dbos_config) — app/scheduler/health.py serves loopback-only health
# instead, precisely because DBOS's hard-binds 0.0.0.0 and exposes workflow
# recovery, garbage collection, global-timeout and deactivate with no auth.
# Deny 3001 anyway: defence in depth costs one rule, and a future flag flip
# should not be one edit away from exposing a control plane.
if command -v ufw >/dev/null 2>&1; then
  ufw deny 3001/tcp >/dev/null 2>&1 || true
  echo "  ufw deny 3001/tcp"
fi
# The health port must not be reachable off-box either.
if command -v ss >/dev/null 2>&1; then
  ss -ltn 2>/dev/null | awk '$4 ~ /:8771$/ {print "  listening: " $4}' || true
fi

if [ "$GATE_OK" != "1" ]; then
  echo
  echo "  GATE FAILED — installed, but do NOT set AI_SCHEDULED_TASKS_ENABLED=true." >&2
  echo "  Fix the items above and re-run this script." >&2
  exit 2
fi

cat <<'NOTE'

  Installed but NOT started. To enable:
    1. set AI_SCHEDULED_TASKS_ENABLED=true in services/ai/.env
    2. systemctl start myos-scheduler
    3. journalctl -u myos-scheduler -f    # expect sched.started, then sched.tick

  Backups: deploy/backup.sh dumps myos_dbos nightly. Note that the AUTHORITATIVE
  recovery path is to recreate myos_dbos EMPTY and let Convex reconciliation
  rebuild — Convex is the ledger. The dump exists for forensics and in-flight
  diagnosis, not because occurrence data lives here.

NOTE
echo "SCHEDULED_TASKS_DONE"
