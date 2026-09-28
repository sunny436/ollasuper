#!/usr/bin/env bash
# A THROWAWAY staging / restore-drill stack on this host, isolated from production.
#
# WHY IT LIVES HERE. There is one Linux host (the production VM). Destructive
# end-to-end tests and the restore drill must not run against production, so
# this builds a second, disposable copy of the backend planes beside it:
#
#   own docker network  172.29.0.0/16   (production: 172.18.0.0/16)
#   own Postgres        127.0.0.1:5533  (convex + knowledge + dbos databases)
#   own Convex backend  127.0.0.1:3310/3311, the SAME pinned image digest
#   own AI service      172.29.0.1:8870, run as myos-ai (same sandbox binary)
#
# Nothing binds a public interface. The frontend and the edge proxy run on the
# operator's machine against these ports through an SSH tunnel (see RUNBOOK
# below). Every container and the AI service is memory-capped, so staging is
# the thing the kernel sacrifices, never production.
#
# It holds a FULL COPY OF PRODUCTION DATA after `restore`. It is private to
# this root-only host and `down` destroys every byte of it.
#
# Usage (as root, on the VM):
#   deploy/staging/staging.sh up          # network, postgres, convex (empty)
#   deploy/staging/staging.sh restore     # latest backup set -> staging (verified)
#   deploy/staging/staging.sh deploy      # this branch's code + AI service
#   deploy/staging/staging.sh verify      # restore proofs (see verify-restore.sh)
#   deploy/staging/staging.sh status
#   deploy/staging/staging.sh down        # destroy it all
#
# RUNBOOK (operator machine):
#   ssh -N -L 3310:127.0.0.1:3310 -L 3311:127.0.0.1:3311 root@<vm>
#   EDGE_PORT=3400 EDGE_APP_PORT=3100 EDGE_CVX_PORT=3310 EDGE_SITE_PORT=3311 \
#     EDGE_TICKET_SECRET=<from .staging.env> node edge/proxy.js
#   NEXT_PUBLIC_CONVEX_URL=http://localhost:3400/__cvx bun run build && next start -p 3100
#   E2E_BASE_URL=http://localhost:3400 node e2e/qa-library.js
set -euo pipefail

ROOT=${STAGING_ROOT:-/opt/myos-staging}
BARE=${STAGING_GIT:-/opt/myos.git}
REF=${STAGING_REF:-staging}
NET=myos-staging-net
SUBNET=172.29.0.0/16
GW=172.29.0.1
PG=myos-staging-pg
PG_PORT=5533
CVX=myos-staging-convex
CVX_PORT=3310
SITE_PORT=3311
AI_PORT=8870
UNIT=myos-ai-staging
PUBLIC_ORIGIN=${STAGING_PUBLIC_ORIGIN:-http://localhost:3400}
IMAGE=${STAGING_CONVEX_IMAGE:-ghcr.io/get-convex/convex-backend@sha256:1f2044e3eac463ac78973b136c0baf72d4ada602611d853d6f99f280e29e0a98}
PROD_AI_ENV=/opt/myos/services/ai/.env
PROD_VENV=/opt/myos/services/ai/.venv
BACKUPS=${BACKUP_DIR:-/opt/backups}
SECRETS=$ROOT/.staging.env
SRC=$ROOT/src

die() { echo "FATAL: $*" >&2; exit 1; }
say() { echo "== $*"; }

# ---------------------------------------------------------------- guards
# Every name and port here is checked against production before anything runs.
guard() {
  [ "$(id -u)" = 0 ] || die "run as root"
  case "$ROOT" in /opt/myos|/opt/myos/*) die "STAGING_ROOT must not be production ($ROOT)";; esac
  for p in "$CVX_PORT" "$SITE_PORT" "$PG_PORT" "$AI_PORT"; do
    case "$p" in 3210|3211|5432|5433|8770|3000|5150) die "port $p is production's";; esac
  done
  if docker network inspect "$NET" >/dev/null 2>&1; then
    docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET" | grep -qx "$SUBNET" \
      || die "$NET exists with another subnet"
  fi
}

secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

load_secrets() {
  [ -f "$SECRETS" ] || die "no $SECRETS - run 'up' first"
  # shellcheck disable=SC1090
  . "$SECRETS"
}

pg() { docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -U postgres "$@"; }

cvx() {
  # The Convex CLI against STAGING only: an explicit URL + key, and never a
  # .env.local (which would silently point it somewhere else).
  [ ! -f "$SRC/packages/backend/.env.local" ] || die "refusing: $SRC/packages/backend/.env.local exists"
  ( cd "$SRC/packages/backend" && \
    CONVEX_SELF_HOSTED_URL="http://127.0.0.1:$CVX_PORT" \
    CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
    node "$SRC/node_modules/convex/bin/main.js" "$@" )
}

wait_http() {
  for _ in $(seq 1 90); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 2; done
  die "$1 did not come up"
}

# ---------------------------------------------------------------- up
cmd_up() {
  guard
  install -d -m 0711 "$ROOT"  # traversable: the AI service (myos-ai) runs from $SRC
  if [ ! -f "$SECRETS" ]; then
    umask 077
    cat > "$SECRETS" <<EOF
PG_PASSWORD=$(secret)
KNOW_PASSWORD=$(secret)
INSTANCE_SECRET=$(secret)
AI_SERVICE_KEY=$(secret)
AI_INGRESS_SECRET=$(secret)
EDGE_TICKET_SECRET=$(secret)
OPS_HEALTH_SECRET=$(secret)
EOF
  fi
  load_secrets
  docker network inspect "$NET" >/dev/null 2>&1 || \
    docker network create --subnet "$SUBNET" --gateway "$GW" "$NET" >/dev/null
  local pg_image
  pg_image=$(docker inspect -f '{{.Config.Image}}' ai-knowledge-db-1 2>/dev/null || echo pgvector/pgvector:pg16)
  if ! docker inspect "$PG" >/dev/null 2>&1; then
    say "postgres ($pg_image), 768 MB cap"
    docker run -d --name "$PG" --network "$NET" --memory 768m \
      -e POSTGRES_PASSWORD="$PG_PASSWORD" -v myos-staging-pgdata:/var/lib/postgresql/data \
      -p "127.0.0.1:$PG_PORT:5432" "$pg_image" >/dev/null
  fi
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  pg -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'convex') THEN
    CREATE ROLE convex LOGIN PASSWORD '$PG_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myos_ai') THEN
    -- SUPERUSER in this throwaway copy only: the dumps recreate the vector
    -- extension and must own their objects, exactly as production does.
    CREATE ROLE myos_ai LOGIN SUPERUSER PASSWORD '$KNOW_PASSWORD';
  END IF;
END \$\$;
SQL
  # The backend does not create its own database (CLAUDE.md): name = INSTANCE_NAME, '-' -> '_'.
  for db in myos_staging:convex myos_knowledge:myos_ai myos_dbos:myos_ai; do
    name=${db%%:*}; owner=${db##*:}
    pg -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$name'" | grep -q 1 || \
      pg -d postgres -c "CREATE DATABASE $name OWNER $owner" >/dev/null
  done
  if ! docker inspect "$CVX" >/dev/null 2>&1; then
    say "convex backend (pinned digest), 2 GB cap"
    docker run -d --name "$CVX" --network "$NET" --memory 2g \
      -e INSTANCE_NAME=myos-staging -e INSTANCE_SECRET="$INSTANCE_SECRET" \
      -e POSTGRES_URL="postgresql://convex:$PG_PASSWORD@$PG:5432?sslmode=disable" \
      -e CONVEX_CLOUD_ORIGIN="$PUBLIC_ORIGIN/__cvx" -e CONVEX_SITE_ORIGIN="$PUBLIC_ORIGIN/__cvx-site" \
      -e DOCUMENT_RETENTION_DELAY=172800 -e DISABLE_BEACON=true -e DO_NOT_REQUIRE_SSL=1 \
      -v myos-staging-data:/convex/data \
      -p "127.0.0.1:$CVX_PORT:3210" -p "127.0.0.1:$SITE_PORT:3211" "$IMAGE" >/dev/null
  fi
  wait_http "http://127.0.0.1:$CVX_PORT/version"
  if ! grep -q '^ADMIN_KEY=' "$SECRETS"; then
    key=$(docker exec "$CVX" ./generate_admin_key.sh | tail -1)
    # Quoted: an admin key is `<instance>|<hex>`, and an unquoted `|` would
    # turn sourcing this file into a pipeline.
    echo "ADMIN_KEY='$key'" >> "$SECRETS"
  fi
  say "staging planes up (convex :$CVX_PORT/:$SITE_PORT, postgres :$PG_PORT)"
}

# ---------------------------------------------------------------- code
cmd_code() {
  guard
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" fetch -q origin "$REF" && git -C "$SRC" reset -q --hard FETCH_HEAD
  else
    git clone -q --branch "$REF" "$BARE" "$SRC"
  fi
  chmod -R go+rX "$SRC"
  ( cd "$SRC" && PATH=/root/.bun/bin:$PATH bun install --frozen-lockfile >/dev/null )
  say "code at $(git -C "$SRC" rev-parse --short HEAD) ($REF)"
}

# ---------------------------------------------------------------- restore
cmd_restore() {
  guard; load_secrets
  [ -d "$SRC/.git" ] || cmd_code
  local stamp=${1:-}
  [ -n "$stamp" ] || stamp=$(ls -1t "$BACKUPS"/manifest-*.txt | head -1 | sed 's#.*/manifest-##; s#\.txt$##')
  local man="$BACKUPS/manifest-$stamp.txt"
  [ -f "$man" ] || die "no manifest $man"
  say "verifying the backup set $stamp against its manifest"
  ( cd "$BACKUPS" && grep -E '^[0-9a-f]{64} ' "$man" | sha256sum -c --quiet - ) || die "manifest checksums do not match"
  echo "RESTORED_STAMP=$stamp" > "$ROOT/.restored"
  say "convex snapshot (tables + FILE STORAGE) -> staging, BEFORE any deploy"
  cvx import --replace-all --yes "$BACKUPS/convex-$stamp.zip"
  for part in knowledge:myos_knowledge dbos:myos_dbos; do
    f="$BACKUPS/${part%%:*}-$stamp.dump"; db=${part##*:}
    [ -f "$f" ] || { echo "   (no ${part%%:*} dump in this set)"; continue; }
    say "restoring $f -> $db"
    docker exec -i "$PG" pg_restore -U myos_ai -d "$db" --no-owner --clean --if-exists < "$f" \
      || echo "   pg_restore reported warnings (checked by verify)"
  done
  say "restored $stamp"
}

# ---------------------------------------------------------------- deploy
write_ai_env() {
  # Production's settings, with every address, database and secret replaced,
  # and every outward-acting feature (scheduled mail, MCP) switched off.
  local out=$SRC/services/ai/.env
  umask 077
  grep -vE '^(AI_BIND_HOST|AI_PORT|AI_SERVICE_KEY|AI_INGRESS_SECRET|CONVEX_SITE_URL|CONVEX_INTERNAL_URL|KNOWLEDGE_DATABASE_URL|KNOWLEDGE_DB_PASSWORD|SCHEDULER_DATABASE_URL|SCHEDULER_DB_PASSWORD|MCP_[A-Z_]*|OLLAGRAPH_API_KEY|AI_SCHEDULED_TASKS_ENABLED|SCHEDULED_[A-Z_]*|AI_SECURITY_[A-Z_]*|LANGSMITH_[A-Z_]*|AI_SANDBOX_MIN_TIER)=' "$PROD_AI_ENV" > "$out"
  cat >> "$out" <<EOF
AI_BIND_HOST=$GW
AI_PORT=$AI_PORT
AI_SERVICE_KEY=$AI_SERVICE_KEY
AI_INGRESS_SECRET=$AI_INGRESS_SECRET
CONVEX_SITE_URL=http://127.0.0.1:$SITE_PORT
CONVEX_INTERNAL_URL=http://127.0.0.1:$CVX_PORT
KNOWLEDGE_DATABASE_URL=postgresql://myos_ai:$KNOW_PASSWORD@127.0.0.1:$PG_PORT/myos_knowledge?sslmode=disable
SCHEDULER_DATABASE_URL=postgresql://myos_ai:$KNOW_PASSWORD@127.0.0.1:$PG_PORT/myos_dbos?sslmode=disable
AI_SCHEDULED_TASKS_ENABLED=false
SCHEDULED_DELIVERY_ENABLED=false
MCP_CONNECTIONS_ENABLED=false
MCP_OAUTH_ENABLED=false
AI_SECURITY_ENABLED=false
AI_SANDBOX_MIN_TIER=1
AI_INGEST_STORE_ORIGINAL_COPY=false
EOF
  chown myos-ai "$out"; chmod 0600 "$out"
}

cmd_deploy() {
  guard; load_secrets
  [ -d "$SRC/.git" ] || cmd_code
  write_ai_env
  say "knowledge DB migrations (alembic upgrade head) on STAGING"
  ( cd "$SRC/services/ai" && \
    KNOWLEDGE_DATABASE_URL="postgresql://myos_ai:$KNOW_PASSWORD@127.0.0.1:$PG_PORT/myos_knowledge?sslmode=disable" \
    "$PROD_VENV/bin/python" -m alembic upgrade head )
  say "convex auth keys (fresh, staging-only)"
  if [ ! -f "$ROOT/.jwks" ]; then
    ( cd "$SRC" && node -e '
      const { exportJWK, exportPKCS8, generateKeyPair } = require("jose");
      (async () => {
        const k = await generateKeyPair("RS256", { extractable: true });
        const priv = (await exportPKCS8(k.privateKey)).trimEnd().replace(/\n/g, " ");
        const jwks = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(k.publicKey)) }] });
        require("fs").writeFileSync(process.argv[1], priv, { mode: 0o600 });
        require("fs").writeFileSync(process.argv[2], jwks, { mode: 0o600 });
      })();' "$ROOT/.jwt" "$ROOT/.jwks" )
  fi
  say "convex env (staging values only)"
  cvx env set AI_BASE_URL "http://$GW:$AI_PORT" >/dev/null
  cvx env set AI_SERVICE_KEY "$AI_SERVICE_KEY" >/dev/null
  cvx env set AI_INGRESS_SECRET "$AI_INGRESS_SECRET" >/dev/null
  cvx env set EDGE_TICKET_SECRET "$EDGE_TICKET_SECRET" >/dev/null
  cvx env set OPS_HEALTH_SECRET "$OPS_HEALTH_SECRET" >/dev/null
  cvx env set SITE_URL "$PUBLIC_ORIGIN" >/dev/null
  cvx env set JWT_PRIVATE_KEY -- "$(cat "$ROOT/.jwt")" >/dev/null
  cvx env set JWKS "$(cat "$ROOT/.jwks")" >/dev/null
  cvx env set SCHEDULED_DELIVERY_ENABLED false >/dev/null
  if [ -n "${STAGING_ALLOWED_DOMAINS:-}" ]; then
    cvx env set AUTH_EXTRA_ALLOWED_DOMAINS "$STAGING_ALLOWED_DOMAINS" >/dev/null
  fi
  say "convex deploy (dry run first)"
  cvx deploy --dry-run --yes >/dev/null
  cvx deploy --yes
  say "AI service ($UNIT), 1.5 GB cap, as myos-ai on $GW:$AI_PORT"
  systemctl stop "$UNIT" 2>/dev/null || true
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  systemd-run --unit="$UNIT" --collect \
    -p User=myos-ai -p MemoryMax=1500M -p PrivateTmp=yes \
    -p WorkingDirectory="$SRC/services/ai" -p EnvironmentFile="$SRC/services/ai/.env" \
    --setenv=PATH=/opt/myos-sandbox/bin:/usr/local/bin:/usr/bin:/bin \
    "$PROD_VENV/bin/python" -m uvicorn app.main:app --host "$GW" --port "$AI_PORT" --workers 1 >/dev/null
  ufw status | grep -q "myos-staging convex -> ai" || \
    ufw allow from "$SUBNET" to "$GW" port "$AI_PORT" proto tcp comment 'myos-staging convex -> ai' >/dev/null
  wait_http "http://$GW:$AI_PORT/healthz"
  say "staging deployed at $(git -C "$SRC" rev-parse --short HEAD)"
}

# ---------------------------------------------------------------- verify/status/down
cmd_verify() { guard; load_secrets; ADMIN_KEY=$ADMIN_KEY SRC=$SRC CVX_PORT=$CVX_PORT \
  SITE_PORT=$SITE_PORT PG=$PG AI_URL="http://$GW:$AI_PORT" OPS_HEALTH_SECRET=$OPS_HEALTH_SECRET \
  BACKUPS=$BACKUPS ROOT=$ROOT bash "$(dirname "$0")/verify-restore.sh"; }

cmd_status() {
  docker ps --filter "name=myos-staging" --format '{{.Names}} {{.Status}} {{.Ports}}'
  systemctl is-active "$UNIT" 2>/dev/null || true
  curl -fsS "http://127.0.0.1:$CVX_PORT/version" && echo
  curl -fsS "http://$GW:$AI_PORT/readyz" | head -c 400; echo
  du -sh /var/lib/docker/volumes/myos-staging-* 2>/dev/null || true
}

cmd_down() {
  guard
  systemctl stop "$UNIT" 2>/dev/null || true
  docker rm -f "$CVX" "$PG" >/dev/null 2>&1 || true
  docker volume rm myos-staging-data myos-staging-pgdata >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  while n=$(ufw status numbered | awk -F'[][]' '/myos-staging convex -> ai/{print $2; exit}') && [ -n "$n" ]; do
    ufw --force delete "$n" >/dev/null
  done
  rm -rf "$ROOT"
  say "staging destroyed (containers, volumes, network, firewall rule, $ROOT)"
}

case "${1:-}" in
  up) cmd_up ;;
  code) cmd_code ;;
  restore) shift; cmd_restore "${1:-}" ;;
  deploy) cmd_deploy ;;
  verify) cmd_verify ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) echo "usage: $0 up|code|restore [stamp]|deploy|verify|status|down" >&2; exit 2 ;;
esac
