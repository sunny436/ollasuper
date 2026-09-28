#!/usr/bin/env bash
# File Library host operations — the PRODUCTION installer. Run on the VM as
# root, and only AFTER the library-hardening code is live, in this order:
#
#   alembic 0007 -> Python (restart) -> Convex deploy -> THIS -> frontend
#
# because the edge this (re)starts refuses every upload URL that carries no
# ticket, and only the new Convex mints tickets. Step 0 checks that it does.
#
#   OPS_ALERT_EMAIL=ops@example.com bash deploy/81-library-ops.sh
#       installs everything. Both reclaimers run as DRY RUNS: they only write
#       reports (candidate count, bytes, proof) for the operator to review.
#   RECLAIM_APPLY=1 OPS_ALERT_EMAIL=ops@example.com bash deploy/81-library-ops.sh
#       re-run ONLY after the operator approved those reports. Deleting
#       production bytes is never a default.
#
# Idempotent. Installs:
#   1. two shared secrets, generated once, root-only, and set in Convex:
#        EDGE_TICKET_SECRET  edge    -> Convex /edge/upload-ticket
#        OPS_HEALTH_SECRET   monitor -> Convex /ops/library-health
#   2. the edge: /etc/myos/edge.env + unit + proxy.js (single-use upload
#      tickets, the streamed body cap, the low-disk 507), verified after the
#      restart and rolled back if it does not answer;
#   3. the AI plane's sandbox floor AI_SANDBOX_MIN_TIER=1: a decoder never runs
#      below tier 1. Verified from /readyz after the restart; a host that cannot
#      give tier 1 is rolled back to the previous floor, loudly;
#   4. a journald cap (the journal was 1.0 GB of a 48 GB disk);
#   5. timers: blob reclaim (hourly), export-zip reclaim (daily 04:30, after
#      the 03:00 backup), host monitor + alerting (every 5 minutes).
#
# The backup's storage lock needs no install: cron runs deploy/backup.sh from
# this checkout, so the deploy itself brings the version that takes the lock.
set -euo pipefail

die() { echo "FATAL: $*" >&2; exit 1; }
say() { echo "== $*"; }
[ "$(id -u)" = 0 ] || die "run as root"

REPO=${REPO:-/opt/myos}
BACKEND=$REPO/packages/backend
NODE=${NODE:-/usr/bin/node}
CVX=${CVX:-$REPO/node_modules/convex/bin/main.js}
VENV=$REPO/services/ai/.venv
AI_DIR=$REPO/services/ai
AI_ENV=$AI_DIR/.env
STORAGE=${STORAGE:-/var/lib/docker/volumes/self-hosted_data/_data/storage}
MAIL_ENV=${MAIL_ENV:-/root/ollastack.env}
SITE=${SITE:-http://127.0.0.1:3211}
AI_URL=${AI_URL:-http://127.0.0.1:8770}
EDGE_URL=${EDGE_URL:-http://127.0.0.1:5150}
EDGE_ENV=/etc/myos/edge.env
MONITOR_ENV=/etc/myos/monitor.env
UNITS=/etc/systemd/system
APPLY=""
[ "${RECLAIM_APPLY:-0}" = 1 ] && APPLY="--apply"
secret() { head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 43; }
# Read KEY from an env file without sourcing it (values may hold shell syntax).
env_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -1 || true; }
# `convex env set` echoes the VALUE on stderr: only the name is ever printed.
cvx_set() { ( cd "$BACKEND" && "$NODE" "$CVX" env set -- "$1" "$2" >/dev/null 2>&1 ) \
  || die "convex env set $1 failed"; echo "   convex env $1 set"; }
cvx_get() { ( cd "$BACKEND" && "$NODE" "$CVX" env get "$1" 2>/dev/null ) || true; }

# ------------------------------------------------------------------ 0. preconditions
say "0/5 preconditions"
[ -d "$STORAGE/files" ] || die "no Convex file storage at $STORAGE"
[ -x "$VENV/bin/python" ] || die "no AI venv at $VENV"
[ -f "$MAIL_ENV" ] || die "$MAIL_ENV is missing (the Ollastack token lives there, and only there)"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$SITE/edge/upload-ticket" -H 'x-edge-key: probe' || true)
[ "$code" = 401 ] || die "Convex answers /edge/upload-ticket with HTTP $code, not 401: deploy the new Convex first"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$SITE/ops/library-health" -H 'x-ops-key: probe' || true)
[ "$code" = 401 ] || die "Convex answers /ops/library-health with HTTP $code, not 401: deploy the new Convex first"
curl -fsS -m 10 "$AI_URL/readyz" | grep -q '"library"' \
  || die "the AI plane's /readyz has no library section: deploy the new Python first"
ALERT=${OPS_ALERT_EMAIL:-$(env_get "$MONITOR_ENV" OPS_ALERT_EMAIL)}
[ -n "$ALERT" ] || die "OPS_ALERT_EMAIL is required: an alert nobody receives is not an alert"
MAILBOX=$(cvx_get OLLASTACK_REPORTS_MAILBOX_ID)
[ -n "$MAILBOX" ] || MAILBOX=$(cvx_get OLLASTACK_AUTH_MAILBOX_ID)
[ -n "$MAILBOX" ] || die "no Ollastack mailbox id in the Convex env (deploy/75-ollastack-mail.sh)"
MAIL_BASE=$(cvx_get OLLASTACK_MAIL_BASE_URL)
install -d -m 0700 /etc/myos /var/lib/myos-reclaim /var/lib/myos-monitor

# ------------------------------------------------------------------ 1. secrets
say "1/5 shared secrets (generated once, root-only)"
EDGE_SECRET=$(env_get "$EDGE_ENV" EDGE_TICKET_SECRET); [ -n "$EDGE_SECRET" ] || EDGE_SECRET=$(secret)
OPS_SECRET=$(env_get "$MONITOR_ENV" OPS_HEALTH_SECRET); [ -n "$OPS_SECRET" ] || OPS_SECRET=$(secret)
cvx_set EDGE_TICKET_SECRET "$EDGE_SECRET"
cvx_set OPS_HEALTH_SECRET "$OPS_SECRET"
umask 077
cat > "$MONITOR_ENV" <<EOF
OPS_HEALTH_SECRET=$OPS_SECRET
OPS_ALERT_EMAIL=$ALERT
OLLASTACK_MAILBOX_ID=$MAILBOX
OLLASTACK_MAIL_BASE_URL=${MAIL_BASE:-https://login.ollastack.com}
MONITOR_CONVEX_SITE=$SITE
MONITOR_AI_URL=$AI_URL
MONITOR_DISK_PATHS=/
MONITOR_RECLAIM_REPORTS=/var/lib/myos-reclaim/files.json
MONITOR_HOST=$(hostname)
EOF
chmod 0600 "$MONITOR_ENV"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$SITE/ops/library-health" -H "x-ops-key: $OPS_SECRET" || true)
[ "$code" = 200 ] || die "the ops secret was set but /ops/library-health answers $code"

# ------------------------------------------------------------------ 2. edge
say "2/5 edge: upload tickets + low-disk refusal"
stamp=$(date +%Y%m%d%H%M%S)
cp -p /opt/myos-edge/proxy.js "/opt/myos-edge/proxy.js.bak-$stamp"
cp -p "$UNITS/myos-edge.service" "/etc/myos/myos-edge.service.bak-$stamp"
[ -f "$EDGE_ENV" ] && cp -p "$EDGE_ENV" "$EDGE_ENV.bak-$stamp"
cat > "$EDGE_ENV" <<EOF
EDGE_TICKET_SECRET=$EDGE_SECRET
EDGE_DISK_PATH=/
EDGE_MIN_FREE_BYTES=$((4 * 1024 * 1024 * 1024))
EOF
chmod 0600 "$EDGE_ENV"
install -m 0644 "$REPO/edge/proxy.js" /opt/myos-edge/proxy.js
install -m 0644 "$REPO/edge/myos-edge.service" "$UNITS/myos-edge.service"
systemctl daemon-reload
systemctl restart myos-edge
edge_ok() {
  for _ in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$EDGE_URL/__cvx/version")" = 200 ] && break
    sleep 1
  done
  # A storage upload with no ticket must be refused BEFORE a byte is forwarded.
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "$EDGE_URL/__cvx/api/storage/upload?token=x" \
       -H 'content-type: text/plain' --data 'x')" = 403 ]
}
if ! edge_ok; then
  echo "   the new edge failed its check - ROLLING BACK" >&2
  install -m 0644 "/opt/myos-edge/proxy.js.bak-$stamp" /opt/myos-edge/proxy.js
  install -m 0644 "/etc/myos/myos-edge.service.bak-$stamp" "$UNITS/myos-edge.service"
  systemctl daemon-reload; systemctl restart myos-edge
  die "edge rolled back to the previous proxy.js and unit"
fi
echo "   edge answers; an unticketed upload is refused (403)"

# ------------------------------------------------------------------ 3. sandbox floor
say "3/5 AI plane sandbox floor (AI_SANDBOX_MIN_TIER=1)"
prev=$(env_get "$AI_ENV" AI_SANDBOX_MIN_TIER)
if [ "$prev" != 1 ]; then
  cp -p "$AI_ENV" "$AI_ENV.bak-$stamp"
  sed -i '/^AI_SANDBOX_MIN_TIER=/d' "$AI_ENV"
  echo "AI_SANDBOX_MIN_TIER=1" >> "$AI_ENV"
  systemctl restart myos-ai
  ready=""
  for _ in $(seq 1 60); do
    ready=$(curl -fsS -m 5 "$AI_URL/readyz" 2>/dev/null || true)
    echo "$ready" | grep -q '"meets_minimum"' && break
    sleep 2
  done
  if ! echo "$ready" | grep -q '"meets_minimum":true'; then
    echo "   this host cannot give sandbox tier 1: ROLLING BACK the floor" >&2
    install -m 0640 "$AI_ENV.bak-$stamp" "$AI_ENV"
    systemctl restart myos-ai
    die "AI_SANDBOX_MIN_TIER=1 refused (readyz: $(echo "$ready" | head -c 300))"
  fi
  echo "   readyz: sandbox tier 1 meets the minimum"
else
  echo "   already 1"
fi

# ------------------------------------------------------------------ 4. journald
say "4/5 journald cap"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/50-myos-cap.conf <<'EOF'
[Journal]
SystemMaxUse=800M
SystemKeepFree=4G
EOF
systemctl restart systemd-journald
journalctl --disk-usage

# ------------------------------------------------------------------ 5. timers
say "5/5 timers (reclaim: ${APPLY:-DRY RUN})"
unit() { cat > "$UNITS/$1"; }
unit myos-blob-reclaim.service <<EOF
[Unit]
Description=myos: reclaim the bytes of deleted Convex files (${APPLY:-dry run})
After=postgresql.service docker.service

[Service]
Type=oneshot
WorkingDirectory=$AI_DIR
ExecStart=$VENV/bin/python -m app.ops.blob_reclaim --storage-dir $STORAGE --report /var/lib/myos-reclaim/files.json $APPLY
Nice=10
IOSchedulingClass=idle
EOF
unit myos-blob-reclaim.timer <<'EOF'
[Unit]
Description=myos: hourly blob reclamation

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF
unit myos-export-reclaim.service <<EOF
[Unit]
Description=myos: reclaim finished backup export zips (${APPLY:-dry run})
After=postgresql.service docker.service

[Service]
Type=oneshot
WorkingDirectory=$AI_DIR
ExecStart=$VENV/bin/python -m app.ops.blob_reclaim --exports --storage-dir $STORAGE --report /var/lib/myos-reclaim/exports.json $APPLY
Nice=10
IOSchedulingClass=idle
EOF
unit myos-export-reclaim.timer <<'EOF'
[Unit]
Description=myos: daily export-zip reclamation, after the 03:00 backup

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
unit myos-monitor.service <<EOF
[Unit]
Description=myos: File Library + storage health, alerts by email
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$AI_DIR
EnvironmentFile=$MONITOR_ENV
EnvironmentFile=$MAIL_ENV
ExecStart=$VENV/bin/python -m app.ops.monitor
EOF
unit myos-monitor.timer <<'EOF'
[Unit]
Description=myos: host monitor every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
for t in myos-blob-reclaim myos-export-reclaim myos-monitor; do systemctl enable --now "$t.timer" >/dev/null; done
# One run of each now, so the first report and metrics exist immediately.
systemctl start myos-blob-reclaim.service myos-export-reclaim.service || true
systemctl start myos-monitor.service || echo "   the monitor exited non-zero: an alert could not be delivered (see journalctl -u myos-monitor)"
for r in files exports; do
  echo "   $r: $(head -c 400 /var/lib/myos-reclaim/$r.json 2>/dev/null || echo 'no report')"
done
echo "   monitor: $(journalctl -u myos-monitor -n 20 --no-pager -o cat | grep -o '"alerts": \[[^]]*\]' | tail -1)"
say "installed. Reclaimers are ${APPLY:+APPLYING}${APPLY:-DRY RUNS - review the reports above, then re-run with RECLAIM_APPLY=1 once approved}"
