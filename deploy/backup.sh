#!/usr/bin/env bash
# Daily snapshot backup of the LIVE Convex deployment. Keeps the last 7.
#
# TARGET SELECTION — READ THIS BEFORE CHANGING IT.
#
# This script used to choose its target by asking "does /root/.cvx-cloud-key
# exist?", back when production data lived on Convex Cloud (2026-08-18). It no
# longer does: production moved to self-hosted Convex on PostgreSQL, and Cloud
# was left running as the rollback of record. But nothing ever DELETED that
# keyfile — deploy/63-convex-pg-cutover.sh actually requires it — so the old
# test kept selecting Cloud and this job quietly archived the frozen rollback
# copy while the live deployment went unprotected. Exactly the failure the
# original comment warned about, with the two targets swapped.
#
# So the target is now EXPLICIT and defaults to the live deployment. Presence of
# a credential file is not evidence of intent, and inferring intent from it is
# what caused the bug: BACKUP_TARGET=cloud is opt-in, for a deliberate rollback
# snapshot, and nothing else.
#
# --env-file is NOT optional on the Cloud path. packages/backend/.env.local
# holds CONVEX_SELF_HOSTED_URL and takes precedence over CONVEX_DEPLOY_KEY, so
# without it the export silently targets self-hosted instead.
#
# THREE OTHER THINGS ARE DELIBERATE:
#  1. --include-file-storage. Without it the archive holds rows whose
#     users.imageId / files.storageId / chatAttachments.storageId blobs are
#     absent, i.e. stored files are unrestorable.
#  2. `set -e` is on, but the retention pipeline is explicitly tolerated: on a
#     first run the glob matches nothing, ls exits non-zero, and pipefail would
#     abort the script AFTER a perfectly good export.
#  3. Pruning happens only after the new archive is confirmed to exist and be
#     non-trivial, so a failed export can never delete the last good backup.
set -euo pipefail

DEST=${BACKUP_DIR:-/opt/backups}
REPO=${REPO:-/opt/myos}
KEEP=${BACKUP_KEEP:-7}
# The old blanket 1KB floor only ever proved "not empty". Real archives are
# orders of magnitude larger, and the structural checks below are what actually
# prove a backup is restorable — but a per-artifact floor still catches a
# truncated write instantly and for free.
MIN_CONVEX_BYTES=${BACKUP_MIN_CONVEX_BYTES:-65536}
MIN_DUMP_BYTES=${BACKUP_MIN_DUMP_BYTES:-16384}
# "self-hosted" (the live deployment) or "cloud" (the rollback of record).
BACKUP_TARGET=${BACKUP_TARGET:-self-hosted}
KEYFILE=${CONVEX_KEY_FILE:-/root/.cvx-cloud-key}
EMPTY=${CONVEX_EMPTY_ENV:-/root/.empty-env}

# Structural integrity, not just size. A truncated custom-format dump has an
# unreadable TOC and a truncated zip fails its own CRC table, and both sail past
# any byte-count check. Verified BEFORE pruning, so a corrupt new artifact can
# never evict the last good one.
#
# The host is not guaranteed to carry `unzip` or `pg_restore`, and a check that
# silently skips itself when a tool is missing is how you get a green log over an
# unrestorable backup — the same shape of bug as the target selection above. So
# each verifier has a fallback, and NOT being able to verify is a hard failure.
verify_zip() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -t "$1" >/dev/null 2>&1 && return 0
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PY' && return 0
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.exit(1 if z.testzip() is not None else 0)
PY
  else
    echo "FATAL: neither unzip nor python3 available to verify $1" >&2; exit 1
  fi
  echo "FATAL: $1 failed its archive integrity check; refusing to prune" >&2; exit 1
}

# Run inside the container that produced the dump — it always has the matching
# pg_restore, and the host may have none or a mismatched major version.
verify_dump() {
  local cid="$1" f="$2"
  docker exec -i "$cid" pg_restore --list < "$f" >/dev/null 2>&1 \
    || { echo "FATAL: $f has an unreadable pg_restore TOC; refusing to prune" >&2; exit 1; }
}
# Sets $SIZE rather than echoing it. Deliberate: `size=$(verify_size ...)` would
# run the function in a subshell, where `exit 1` kills only that subshell — the
# FATAL would print and the script would sail on with an empty size. set -e does
# catch it today, but a backup script should not depend on reading that subtlety
# correctly.
verify_size() {
  SIZE=$(wc -c < "$1")
  if [ "$SIZE" -lt "$2" ]; then
    echo "FATAL: $1 is only ${SIZE}B (< ${2}B); refusing to prune" >&2
    exit 1
  fi
}

mkdir -p "$DEST"
cd "$REPO/packages/backend"

ts=$(date +%Y%m%d-%H%M%S)
out="$DEST/convex-$ts.zip"

# Node, never Bun: Bun's WebSocket client breaks against self-hosted Convex.
CVX=("/usr/bin/node" "$REPO/node_modules/convex/bin/main.js")

case "$BACKUP_TARGET" in
  cloud)
    # Deliberate rollback snapshot only. --env-file is NOT optional here:
    # packages/backend/.env.local holds CONVEX_SELF_HOSTED_URL and takes
    # precedence over CONVEX_DEPLOY_KEY, so without it this silently exports
    # self-hosted while claiming to be Cloud.
    [ -f "$KEYFILE" ] || { echo "FATAL: BACKUP_TARGET=cloud but $KEYFILE is missing" >&2; exit 1; }
    : > "$EMPTY"
    target="Convex Cloud"
    CONVEX_DEPLOY_KEY=$(tr -d ' \t\r\n' < "$KEYFILE") \
      "${CVX[@]}" export --env-file "$EMPTY" --include-file-storage --path "$out"
    ;;
  self-hosted)
    target="self-hosted"
    "${CVX[@]}" export --include-file-storage --path "$out"
    ;;
  *)
    echo "FATAL: BACKUP_TARGET must be 'self-hosted' or 'cloud', got '$BACKUP_TARGET'" >&2
    exit 1
    ;;
esac

if [ ! -f "$out" ]; then
  echo "FATAL: export of $target reported success but $out does not exist" >&2
  exit 1
fi

verify_size "$out" "$MIN_CONVEX_BYTES"; size=$SIZE
verify_zip "$out"

ls -1t "$DEST"/convex-*.zip 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true

echo "backup written: $out (${size} bytes, from $target, kept last $KEEP)"

# --- File Knowledge System pgvector DB (separate container) -----------------
# The knowledge DB holds user files + embeddings and is in NO other backup.
# Custom format (-Fc) so pg_restore recreates `CREATE EXTENSION vector` and can
# restore selectively. Its own glob + retention so a Convex-export failure can
# never delete the last good DB dump, and vice-versa. Skipped if the container
# is not running (e.g. a box where deploy/70 has not run).
if docker compose -f "$REPO/services/ai/compose.knowledge.yml" ps knowledge-db 2>/dev/null | grep -q "Up\|running"; then
  kout="$DEST/knowledge-$ts.dump"
  KN_CID=$(docker compose -f "$REPO/services/ai/compose.knowledge.yml" ps -q knowledge-db)
  # Peer auth inside the container — no password in argv.
  docker exec "$KN_CID" pg_dump -Fc -U myos_ai myos_knowledge > "$kout"
  verify_size "$kout" "$MIN_DUMP_BYTES"; ksize=$SIZE
  verify_dump "$KN_CID" "$kout"
  ls -1t "$DEST"/knowledge-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true
  echo "knowledge dump written: $kout (${ksize} bytes, kept last $KEEP)"
fi

# --- DBOS scheduler system database (Scheduled Tasks) -----------------------
# Lives in the SAME knowledge-db container as a separate database, so this
# reuses the container lookup above. Its own glob + retention so one dump
# failing can never delete another's last good copy.
#
# IMPORTANT — WHAT THIS DUMP IS FOR. Convex is the authoritative ledger for
# scheduled work: tasks, revisions, occurrence identity and outcome all live
# there and are covered by the Convex export above. myos_dbos holds only DBOS
# workflow EXECUTION state, which is reconstructible — reconciliation flows
# Convex -> DBOS, so losing this database entirely loses NO occurrence.
#
# So the CORRECT recovery is to recreate myos_dbos empty (deploy/71) and let the
# scheduler re-derive from Convex. Restoring an old dump is safe but never
# preferable: every recovered workflow re-validates against Convex before any
# side effect and exits if the occurrence is already terminal, so a stale
# restore cannot double-execute — it is just slower and noisier than starting
# clean. Keep the dump for forensics and in-flight diagnosis.
SCHED_CID=$(docker compose -f "$REPO/services/ai/compose.knowledge.yml" ps -q knowledge-db 2>/dev/null || true)
if [ -n "$SCHED_CID" ] && docker exec "$SCHED_CID" psql -U myos_ai -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='myos_dbos'" 2>/dev/null | grep -q 1; then
  dout="$DEST/dbos-$ts.dump"
  docker exec "$SCHED_CID" pg_dump -Fc -U myos_ai myos_dbos > "$dout"
  verify_size "$dout" "$MIN_DUMP_BYTES"; dsize=$SIZE
  verify_dump "$SCHED_CID" "$dout"
  ls -1t "$DEST"/dbos-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true
  echo "dbos dump written: $dout (${dsize} bytes, kept last $KEEP)"
fi

# --- manifest ---------------------------------------------------------------
# Written LAST, so its existence means every artifact above passed both its size
# floor and its structural check. The restore drill (deploy/72) verifies these
# checksums before restoring anything, which is what turns "a file exists" into
# "these exact bytes are what we backed up".
man="$DEST/manifest-$ts.txt"
{
  echo "timestamp=$ts"
  echo "convex_target=$target"
  # Basenames, checksummed from inside $DEST: the manifest has to stay valid
  # after the artifacts are copied somewhere else to be restored, and an
  # absolute path baked in here would not survive that.
  for f in "$out" "${kout:-}" "${dout:-}"; do
    [ -n "$f" ] && [ -f "$f" ] && ( cd "$DEST" && sha256sum "$(basename "$f")" )
  done
} > "$man"
ls -1t "$DEST"/manifest-*.txt 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true
echo "manifest written: $man"
