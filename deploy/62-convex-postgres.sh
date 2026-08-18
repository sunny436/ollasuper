#!/usr/bin/env bash
# 62-convex-postgres.sh — make PostgreSQL the persistent store for self-hosted Convex.
#
# Idempotent. Safe to re-run. Changes ONLY what Convex needs; every pre-existing
# role, database, pg_hba line and ufw rule is left alone.
#
# WHY THIS EXISTS
# The self-hosted Convex backend selects its storage engine at startup
# (`--db postgres-v5`). Pointing it at PostgreSQL replaces the database layer while
# every Convex function, auth flow, subscription, scheduler and the whole frontend
# stay byte-identical. No application code changes.
#
# FACTS ESTABLISHED BY THE PHASE 0 PROBE — do not "simplify" these away:
#   1. POSTGRES_URL MUST carry ?sslmode=disable. DO_NOT_REQUIRE_SSL only makes TLS
#      optional, not unverified: the driver still prefers TLS and then dies with
#      "invalid peer certificate: UnknownIssuer" against this host's snakeoil cert.
#      Trusting that cert cannot help either — it carries only DNS:ollasuper-vm,
#      no IP SAN, so a connection by IP can never validate. Traffic stays on a
#      host-local docker bridge.
#   2. The backend does NOT create its own database. It connects straight to the
#      name derived from INSTANCE_NAME and exits "FATAL: database ... does not
#      exist". CREATEDB on the role is not sufficient; the db is pre-created here.
#   3. The backend opens a pool of "max size 128", so max_connections=60 is a
#      hard blocker.
#   4. Convex stores all 25 logical tables as rows inside 5 generic relations
#      (documents, indexes, leases, persistence_globals, read_only). Seeing exactly
#      those 5 is correct, not a failed migration.
#
# NETWORKING — the subtle part.
# The compose stack runs on network `self-hosted_default`, which is NOT the default
# docker0 bridge. Its gateway IS the host, so the container reaches Postgres at that
# gateway and its packets carry a source address from that subnet. Scoping pg_hba or
# ufw to docker0's 172.17.0.0/16 therefore silently fails. The subnet is pinned in
# docker-compose.override.yml so it cannot drift when the network is recreated, and
# every rule below is derived from the same two variables.
set -euo pipefail

REPO=${REPO:-/opt/myos}
PGMAJOR=${PGMAJOR:-16}
PGCONF_DIR=/etc/postgresql/$PGMAJOR/main
HBA=$PGCONF_DIR/pg_hba.conf
ROLE=convex
# INSTANCE_NAME is convex-self-hosted and Convex derives the db name by turning
# '-' into '_'. Keep these in lockstep or the backend cannot find its database.
INSTANCE_NAME=convex-self-hosted
DB=convex_self_hosted
PWFILE=/root/.convex-pg-pw
SH_ENV=$REPO/self-hosted/.env
MARK="# added by deploy/62-convex-postgres.sh"

# Must match the `networks:` block pinned in self-hosted/docker-compose.override.yml
NET=${NET:-self-hosted_default}
SUBNET=${SUBNET:-172.18.0.0/16}
GW=${GW:-172.18.0.1}
# A stale rule from an earlier revision of this script that used docker0 by mistake.
STALE_CIDR=172.17.0.0/16

say() { printf '  %s\n' "$*"; }

echo "=== 62-convex-postgres: make PostgreSQL the Convex store ==="
[ -d "$PGCONF_DIR" ] || { echo "FATAL: $PGCONF_DIR not found (PostgreSQL $PGMAJOR expected)" >&2; exit 1; }
[ -f "$SH_ENV" ]     || { echo "FATAL: $SH_ENV not found" >&2; exit 1; }

# ---------------------------------------------------------------------------
echo "--- 0. confirm the compose network subnet matches what we scope to ---"
if docker network inspect "$NET" >/dev/null 2>&1; then
  ACTUAL=$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
  if [ "$ACTUAL" != "$SUBNET" ]; then
    echo "FATAL: network $NET has subnet $ACTUAL but this script scopes to $SUBNET." >&2
    echo "       Pin it in self-hosted/docker-compose.override.yml, recreate the" >&2
    echo "       network (docker compose down), then re-run. Refusing to guess." >&2
    exit 1
  fi
  say "network $NET subnet=$ACTUAL gateway=$GW (matches)"
else
  say "network $NET does not exist yet; the pinned override will create it as $SUBNET"
fi

# ---------------------------------------------------------------------------
echo "--- 1. password for the Convex role (generated once, never echoed) ---"
if [ -s "$PWFILE" ]; then
  say "reusing existing $PWFILE"
else
  # hex only: URL-reserved characters would corrupt POSTGRES_URL.
  ( umask 077; openssl rand -hex 24 > "$PWFILE" )
  say "generated new password -> $PWFILE"
fi
chmod 600 "$PWFILE"
PW=$(tr -d ' \t\r\n' < "$PWFILE")

# ---------------------------------------------------------------------------
echo "--- 2. role and database (pre-created; the backend will not create them) ---"
if [ "$(sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='$ROLE'")" = "1" ]; then
  sudo -u postgres psql -qc "ALTER ROLE $ROLE LOGIN PASSWORD '$PW'"
  say "role '$ROLE' existed — password re-synced to $PWFILE"
else
  sudo -u postgres psql -qc "CREATE ROLE $ROLE LOGIN PASSWORD '$PW'"
  say "role '$ROLE' created"
fi

if [ "$(sudo -u postgres psql -tAc "select 1 from pg_database where datname='$DB'")" = "1" ]; then
  say "database '$DB' already exists — left as is"
else
  sudo -u postgres psql -qc "CREATE DATABASE $DB OWNER $ROLE"
  say "database '$DB' created (owner $ROLE)"
fi
# Convex creates its own relations, so it must own the schema it creates them in.
sudo -u postgres psql -qc "ALTER SCHEMA public OWNER TO $ROLE" "$DB"
say "public schema owned by $ROLE"

# ---------------------------------------------------------------------------
echo "--- 3. server settings (ALTER SYSTEM, so postgresql.conf stays pristine) ---"
# The backend's observed pool ceiling is 128; leave room for psql and backups.
sudo -u postgres psql -qc "ALTER SYSTEM SET max_connections = 200"
# Was 2GB on a 7GB box. The Convex database is ~15MB, so 2GB was pure waste and
# the RAM is needed by the Rust backend + V8 isolates + Next + the Python AI plane.
sudo -u postgres psql -qc "ALTER SYSTEM SET shared_buffers = '512MB'"
# Listen on loopback plus the compose network's gateway — host-local only.
sudo -u postgres psql -qc "ALTER SYSTEM SET listen_addresses = 'localhost,$GW'"
say "max_connections=200  shared_buffers=512MB  listen_addresses=localhost,$GW"

# ---------------------------------------------------------------------------
echo "--- 4. pg_hba: ONE line, scoped to this role AND this database ---"
HBA_LINE="host    $DB    $ROLE    $SUBNET    scram-sha-256    $MARK"
if grep -qF "$MARK" "$HBA"; then
  sed -i "\|$MARK|c\\$HBA_LINE" "$HBA"   # replace only our own line
  say "managed pg_hba line updated"
else
  cp -a "$HBA" "$HBA.bak-$(date +%Y%m%d-%H%M%S)"
  printf '%s\n' "$HBA_LINE" >> "$HBA"
  say "pg_hba line appended (backup taken)"
fi
say "scope: db=$DB role=$ROLE from=$SUBNET"

# ---------------------------------------------------------------------------
echo "--- 4b. ufw: allow the compose network to reach 5432 ---"
# ufw's INPUT policy is DROP with only 22/tcp allowed, so container packets to the
# host gateway are dropped even when Postgres listens there and pg_hba permits it.
# The symptom is a HANG, not a refusal — easy to misdiagnose as a Postgres fault.
# $SUBNET is not routable from outside this host, so this is not public exposure.
if ufw status | grep -q "5432.*$STALE_CIDR"; then
  ufw --force delete allow from "$STALE_CIDR" to any port 5432 proto tcp >/dev/null 2>&1 || true
  say "removed stale rule for $STALE_CIDR (wrong bridge in an earlier revision)"
fi
if ufw status | grep -q "5432.*$SUBNET"; then
  say "ufw rule already present for $SUBNET"
else
  ufw allow from "$SUBNET" to any port 5432 proto tcp comment 'convex container -> postgres' >/dev/null
  say "ufw rule added: $SUBNET -> 5432/tcp"
fi
ufw status | grep -E "^Status|5432" | sed 's/^/    /'

# ---------------------------------------------------------------------------
echo "--- 5. restart PostgreSQL (max_connections/shared_buffers/listen need it) ---"
say "other sessions connected: $(sudo -u postgres psql -tAc \
  "select count(*) from pg_stat_activity where datname is not null and pid <> pg_backend_pid()")"
systemctl restart postgresql
for i in $(seq 1 30); do sudo -u postgres psql -tAc "select 1" >/dev/null 2>&1 && break; sleep 1; done
say "postgresql: $(systemctl is-active postgresql)"
sudo -u postgres psql -tAc \
  "select name||'='||setting from pg_settings where name in ('max_connections','shared_buffers','listen_addresses')" \
  | sed 's/^/    /'

# ---------------------------------------------------------------------------
echo "--- 6. prove a container ON THE COMPOSE NETWORK can reach Postgres ---"
# Testing from the real network is the whole point: a container on the default
# bridge would have a different source address and prove nothing.
NETFLAG=()
if docker network inspect "$NET" >/dev/null 2>&1; then
  NETFLAG=(--network "$NET")
  say "verifying from inside $NET"
else
  say "network absent; verifying from a temporary network with the same subnet"
  docker network create --subnet "$SUBNET" --gateway "$GW" cvxpgverify >/dev/null 2>&1 || true
  NETFLAG=(--network cvxpgverify)
fi
# PGPASSWORD is exported so docker inherits it by NAME; passing -e VAR=value would
# put the secret in argv where `ps` exposes it to every local user.
export PGPASSWORD="$PW"
if timeout 40 docker run --rm "${NETFLAG[@]}" -e PGPASSWORD postgres:16-alpine \
     psql "postgresql://$ROLE@$GW:5432/$DB?sslmode=disable&connect_timeout=8" \
     -tAc "select 'bridge-ok'" 2>&1 | grep -q bridge-ok; then
  say "container -> Postgres at $GW:5432 : OK"
else
  echo "FATAL: a container on $SUBNET cannot reach Postgres at $GW:5432." >&2
  ss -tln | grep 5432 | sed 's/^/         /' >&2
  ufw status | grep -E "5432" | sed 's/^/         /' >&2
  grep -F "$MARK" "$HBA" | sed 's/^/         /' >&2
  unset PGPASSWORD; docker network rm cvxpgverify >/dev/null 2>&1 || true
  exit 1
fi
unset PGPASSWORD
docker network rm cvxpgverify >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
echo "--- 7. write POSTGRES_URL into self-hosted/.env (0600) ---"
# ?sslmode=disable is REQUIRED — see fact 1. Host is the compose gateway, so no
# host.docker.internal / host-gateway indirection is involved.
URL="postgresql://$ROLE:$PW@$GW:5432?sslmode=disable"
cp -a "$SH_ENV" "$SH_ENV.bak-$(date +%Y%m%d-%H%M%S)"
set_env() {
  local k="$1" v="$2"
  if grep -qE "^$k=" "$SH_ENV"; then
    sed -i "s#^$k=.*#$k=$v#" "$SH_ENV"   # '#' delimiter: value contains '/' and ':'
  else
    printf '%s=%s\n' "$k" "$v" >> "$SH_ENV"
  fi
}
set_env POSTGRES_URL "$URL"
set_env DO_NOT_REQUIRE_SSL 1
set_env INSTANCE_NAME "$INSTANCE_NAME"
chmod 600 "$SH_ENV"
say "POSTGRES_URL set (value not printed); DO_NOT_REQUIRE_SSL=1; INSTANCE_NAME=$INSTANCE_NAME"
say "keys now: $(grep -oE '^[A-Z_]+' "$SH_ENV" | tr '\n' ' ')"

echo
echo "62-convex-postgres: DONE"
echo "  The backend is deliberately NOT started here: migration ordering is"
echo "  load-bearing (IMPORT before DEPLOY) — see 63-convex-pg-cutover.sh."
