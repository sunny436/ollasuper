#!/usr/bin/env bash
# 63-convex-pg-cutover.sh — move the deployment's data onto PostgreSQL.
#
# Run AFTER 62-convex-postgres.sh. Leaves Convex Cloud running and untouched, so
# rollback is repointing NEXT_PUBLIC_CONVEX_URL plus a rebuild.
#
# ORDERING IS LOAD-BEARING. Phase 0 proved that `deploy` before `import` leaves the
# deployment permanently broken:
#   Local dir storage couldn't open /convex/data/storage/modules/<uuid>.blob
#   System error executing job ... in Root: reap stalled chat streams
# `import --replace-all` replaces everything the SQL store holds, including module
# metadata — but compiled module BLOBS live in local file storage, which no snapshot
# can restore. A later `deploy` re-uploads the blobs yet does not rebind crons that
# were registered earlier. The sequence below is the one measured clean (0
# missing-blob errors, 0 cron errors, 0 search-flusher deaths, 0 OCC errors):
#
#      start -> IMPORT -> set env -> DEPLOY -> RESTART -> verify
#
# Env vars come after the import on purpose: Convex deployment env vars live in the
# deployment's own database, so anything set before `--replace-all` risks being
# replaced along with everything else.
set -euo pipefail

REPO=${REPO:-/opt/myos}
SH=$REPO/self-hosted
CVX=$REPO/node_modules/convex/bin/main.js
NODE=/usr/bin/node
EMPTY=/root/.empty-env
HARVEST=/root/env-harvest
BACKUPS=/opt/backups
DB=convex_self_hosted
GW=${GW:-172.18.0.1}
STAMP=$(date +%Y%m%d-%H%M%S)
: > "$EMPTY"

say() { printf '  %s\n' "$*"; }
docs() { sudo -u postgres psql -tAc "select count(*) from documents" "$DB" 2>/dev/null || echo 0; }

echo "=== 63-convex-pg-cutover ==="
[ -f /root/.cvx-cloud-key ] || { echo "FATAL: /root/.cvx-cloud-key missing" >&2; exit 1; }
[ -s "$HARVEST/cloud.env" ] || { echo "FATAL: $HARVEST/cloud.env missing — run harvest first" >&2; exit 1; }
CLOUD_KEY=$(tr -d ' \t\r\n' < /root/.cvx-cloud-key)

# ---------------------------------------------------------------------------
echo "--- 1. fresh snapshot from Convex Cloud (source of truth right now) ---"
SNAP=$BACKUPS/cloud-precutover-$STAMP.zip
cd "$REPO/packages/backend"
# --env-file is mandatory: packages/backend/.env.local outranks CONVEX_DEPLOY_KEY and
# a "Cloud" command would silently act on self-hosted instead.
CONVEX_DEPLOY_KEY="$CLOUD_KEY" timeout 900 "$NODE" "$CVX" export \
  --env-file "$EMPTY" --include-file-storage --path "$SNAP" 2>&1 | tail -3 | sed 's/^/  /'
[ -s "$SNAP" ] || { echo "FATAL: export produced nothing" >&2; exit 1; }
say "snapshot: $SNAP ($(stat -c %s "$SNAP") bytes)"
say "tables inside: $(unzip -Z1 "$SNAP" | grep -c 'documents.jsonl')"

# ---------------------------------------------------------------------------
echo "--- 2. the Postgres database must be virgin before --replace-all ---"
NTBL=$(sudo -u postgres psql -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" "$DB")
say "relations in $DB: $NTBL  (0 = never booted; 5 = booted, Convex's own)"
if [ "${FORCE_WIPE:-0}" = "1" ]; then
  say "FORCE_WIPE=1 -> dropping and recreating $DB"
  cd /
  sudo -u postgres psql -qc "DROP DATABASE IF EXISTS $DB"
  sudo -u postgres psql -qc "CREATE DATABASE $DB OWNER convex"
  sudo -u postgres psql -qc "ALTER SCHEMA public OWNER TO convex" "$DB"
  cd "$REPO/packages/backend"
fi

# ---------------------------------------------------------------------------
echo "--- 3. start the stack on PostgreSQL ---"
cd "$SH"
docker compose up -d 2>&1 | tail -6 | sed 's/^/  /'
say "waiting for the backend..."
up=0
for i in $(seq 1 90); do
  curl -fsS --max-time 3 http://127.0.0.1:3210/version >/dev/null 2>&1 && { up=1; break; }
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "FATAL: backend did not come up. Logs:" >&2
  docker compose logs --tail 40 backend 2>&1 | sed 's/^/    /' >&2
  exit 1
fi
say "backend up on :3210"
say "it is on PostgreSQL if these relations exist: $(sudo -u postgres psql -tAc \
  "select string_agg(table_name,',') from information_schema.tables where table_schema='public'" "$DB")"
say "documents before import: $(docs)"

# The admin key is a pure function of (INSTANCE_NAME, INSTANCE_SECRET), both of which
# persist on the volume — so the key in packages/backend/.env.local stays valid.
ADMIN=$(docker compose exec -T backend ./generate_admin_key.sh 2>/dev/null | tail -1 | tr -d ' \r\n')
[ -n "$ADMIN" ] || { echo "FATAL: could not obtain an admin key" >&2; exit 1; }
export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
export CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN"
say "admin key obtained (${#ADMIN} chars)"

# ---------------------------------------------------------------------------
echo "--- 4. IMPORT the snapshot (before any deploy) ---"
cd "$REPO/packages/backend"
timeout 1800 "$NODE" "$CVX" import --env-file "$EMPTY" -y --replace-all "$SNAP" 2>&1 \
  | grep -E "Imported|Added|error|Error" | tail -12 | sed 's/^/  /'
say "documents after import: $(docs)"

# ---------------------------------------------------------------------------
echo "--- 5. deployment env vars (they live IN the database, so they are set now) ---"
# Carried from Cloud. JWT_PRIVATE_KEY/JWKS must match Cloud so the imported
# authSessions/authRefreshTokens remain meaningful.
set_from_cloud() {
  local k="$1" v
  v=$(grep -m1 "^$k=" "$HARVEST/cloud.env" | cut -d= -f2-)
  if [ -z "$v" ]; then printf '  SKIP  %s (absent on Cloud)\n' "$k"; return; fi
  # A value beginning with '-----BEGIN' parses as a flag, hence the k=v fallback.
  "$NODE" "$CVX" env set --env-file "$EMPTY" -- "$k" "$v" >/dev/null 2>&1 \
    || "$NODE" "$CVX" env set --env-file "$EMPTY" "$k=$v" >/dev/null 2>&1 \
    || { printf '  FAIL  %s\n' "$k"; return 1; }
  local got; got=$("$NODE" "$CVX" env get --env-file "$EMPTY" "$k" 2>/dev/null)
  [ "$got" = "$v" ] && printf '  ok    %s (%d chars, read back)\n' "$k" "${#v}" \
                    || printf '  MISMATCH %s\n' "$k"
}
for k in JWT_PRIVATE_KEY JWKS SITE_URL AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET AI_SERVICE_KEY AI_INGRESS_SECRET; do
  set_from_cloud "$k"
done

# Self-hosted-only vars, which Cloud could not use because they are private addresses.
# The container's route to the host is the compose gateway, NOT 127.0.0.1 (that would
# be the container itself).
set_local() {
  "$NODE" "$CVX" env set --env-file "$EMPTY" -- "$1" "$2" >/dev/null 2>&1 \
    && printf '  ok    %s=%s\n' "$1" "$2" || printf '  FAIL  %s\n' "$1"
}
set_local AI_BASE_URL "http://$GW:8770"
set_local SMTP_HOST   "$GW"
set_local SMTP_PORT   "1025"
set_local SMTP_FROM   "auth@myos.local"
# NOT set, deliberately:
#   CONVEX_SITE_URL — injected by the self-hosted backend from CONVEX_SITE_ORIGIN;
#                     overriding it breaks the JWT issuer in auth.config.ts
#   VALIDATE_ENV    — leaving it unset keeps POLAR_* optional, as on Cloud
say "env names now: $("$NODE" "$CVX" env list --env-file "$EMPTY" 2>/dev/null | sed -E 's/=.*//' | tr '\n' ' ')"

# ---------------------------------------------------------------------------
echo "--- 6. DEPLOY the functions (re-uploads module blobs to local storage) ---"
timeout 1800 "$NODE" "$CVX" deploy --env-file "$EMPTY" -y --typecheck disable 2>&1 \
  | grep -E "Deployed|component|error|Error|✔" | tail -8 | sed 's/^/  /'

# ---------------------------------------------------------------------------
echo "--- 7. RESTART so crons and index workers rebind to the final state ---"
cd "$SH"
docker compose restart backend >/dev/null 2>&1
for i in $(seq 1 90); do
  curl -fsS --max-time 3 http://127.0.0.1:3210/version >/dev/null 2>&1 && break
  sleep 1
done
say "restarted; settling 60s before judging the error counters"
sleep 60

# ---------------------------------------------------------------------------
echo "--- 8. health counters (all must be 0) ---"
L=$(docker compose logs --since 45s backend 2>&1)
printf '  missing module blobs : %s\n' "$(printf '%s' "$L" | grep -c "couldn.t open")"
printf '  cron system errors   : %s\n' "$(printf '%s' "$L" | grep -c 'System error executing job')"
printf '  search flusher deaths: %s\n' "$(printf '%s' "$L" | grep -ci 'flusher died')"
printf '  OCC errors           : %s\n' "$(printf '%s' "$L" | grep -ci 'occ error')"

echo "--- 9. data in PostgreSQL ---"
say "documents: $(docs)"
sudo -u postgres psql -tAc "select pg_size_pretty(pg_database_size('$DB'))" | sed 's/^/  size: /'
sudo -u postgres psql -tAc \
  "select relname||'='||n_live_tup from pg_stat_user_tables order by n_live_tup desc" "$DB" \
  | tr '\n' ' ' | sed 's/^/  /'
echo

echo "--- 10. snapshot the new deployment for the fidelity diff ---"
NEWSNAP=$BACKUPS/selfhosted-postcutover-$STAMP.zip
cd "$REPO/packages/backend"
timeout 900 "$NODE" "$CVX" export --env-file "$EMPTY" --include-file-storage --path "$NEWSNAP" 2>&1 | tail -2 | sed 's/^/  /'
say "cloud snapshot: $SNAP"
say "new snapshot:   $NEWSNAP"
say "compare with: python3 /root/fkcheck.py '$SNAP' '$NEWSNAP'"

echo
echo "63-convex-pg-cutover: DONE (app still points at Cloud; Phase 3 repoints it)"
