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

# --- status file + storage lock (File Library operations) --------------------
# STATUS: the host monitor (services/ai/app/ops/monitor.py) alerts on a failed
# or missing backup from this file - written on EVERY exit, success or not, so
# a backup that died half-way is a red alert, not silence.
# LOCK: the blob reclaimer (services/ai/app/ops/blob_reclaim.py) takes the same
# lock and skips its run while it is held, so no blob is removed while an
# export may still be reading it.
STATUS_DIR=${BACKUP_STATUS_DIR:-/var/lib/myos-backup}
STORAGE_LOCK=${STORAGE_LOCK:-/run/lock/myos-storage.lock}
mkdir -p "$STATUS_DIR" 2>/dev/null || STATUS_DIR=""
write_status() {
  [ -n "$STATUS_DIR" ] || return 0
  local rc=$1 now
  now=$(date +%s)
  if [ "$rc" -eq 0 ]; then
    printf '{"ok":true,"at":%s,"stamp":"%s"}
' "$now" "${ts:-}" > "$STATUS_DIR/status.json.tmp"
  else
    printf '{"ok":false,"at":%s,"error":"backup.sh exited %s"}
' "$now" "$rc" > "$STATUS_DIR/status.json.tmp"
  fi
  mv -f "$STATUS_DIR/status.json.tmp" "$STATUS_DIR/status.json"
}
on_exit() {
  local rc=$?
  [ -n "${stage:-}" ] && rm -rf "$stage"
  write_status "$rc"
}
trap on_exit EXIT
if command -v flock >/dev/null 2>&1 && [ -d "$(dirname "$STORAGE_LOCK")" ]; then
  exec 9>"$STORAGE_LOCK"
  flock -w 900 9 || { echo "FATAL: the storage lock stayed busy for 15 minutes" >&2; exit 1; }
fi
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

# PRIVATE BY CONSTRUCTION (audit D-04). These dumps hold every user's data
# and auth state. With the conventional 022 umask a redirected pg_dump and the
# export zip were world-readable, and so was the directory holding them. 077
# makes every file this script creates 0600; the directory is forced to 0700,
# and anything an older run left more open is tightened.
umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"

# DISK PREFLIGHT. The export is written twice on this host (the server-side zip
# under the Convex volume, then the copy here) and a backup that fills the disk
# takes the live stack down with it. Refuse, loudly, below ~3x the last zip
# plus 2 GiB of headroom.
last_zip=$(ls -1t "$DEST"/convex-*.zip 2>/dev/null | head -1 || true)
last_size=0
[ -n "$last_zip" ] && last_size=$(wc -c < "$last_zip")
need=$(( last_size * 3 + 2147483648 ))
free=$(df -P -B1 "$DEST" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${free:-}" ] && [ "$free" -lt "$need" ]; then
  echo "FATAL: only $free bytes free under $DEST; this backup needs about $need" >&2
  exit 1
fi
find "$DEST" -maxdepth 1 -type f -perm /077 -exec chmod 600 {} + 2>/dev/null || true
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

# --- off-host copy (audit D-04), opt-in ---------------------------------------
# A backup that lives only beside the database it protects is lost with that
# disk and readable to whoever holds this host. So, when configured, every
# artifact of this run (and its manifest) is ENCRYPTED to a public key whose
# private half lives OFF this host — the "separate key": a copy of this VM holds
# nothing that can read the copies — and sent to an rsync destination.
#   BACKUP_GPG_RECIPIENT_FILE  an armoured PUBLIC key file
#   BACKUP_OFFHOST_TARGET      rsync destination, e.g. backup@host:/srv/myos/
#   BACKUP_SSH_KEY             optional: the dedicated identity for that host
#                              (deploy/80-backup-offhost.sh --setup makes one);
#                              its host key is pinned on first use in
#                              /etc/myos/backup_known_hosts
# Read from /etc/myos/backup.env (root, 0600) when present, so the cron line
# stays as it is. Both unset = exactly the old behaviour; one without the other
# fails loudly instead of silently not copying.
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/myos/backup.env}
# shellcheck disable=SC1090
[ -f "$BACKUP_ENV_FILE" ] && . "$BACKUP_ENV_FILE"
if [ -n "${BACKUP_GPG_RECIPIENT_FILE:-}${BACKUP_OFFHOST_TARGET:-}" ]; then
  if [ -z "${BACKUP_GPG_RECIPIENT_FILE:-}" ] || [ -z "${BACKUP_OFFHOST_TARGET:-}" ]; then
    echo "FATAL: off-host copy needs BOTH BACKUP_GPG_RECIPIENT_FILE and BACKUP_OFFHOST_TARGET" >&2
    exit 1
  fi
  stage=$(mktemp -d "$DEST/.offhost-XXXXXX")  # removed by on_exit
  for f in "$out" "${kout:-}" "${dout:-}" "$man"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    gpg --batch --yes --trust-model always \
      --recipient-file "$BACKUP_GPG_RECIPIENT_FILE" \
      --output "$stage/$(basename "$f").gpg" --encrypt "$f"
  done
  ssh_cmd="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/etc/myos/backup_known_hosts"
  [ -n "${BACKUP_SSH_KEY:-}" ] && ssh_cmd="$ssh_cmd -o IdentitiesOnly=yes -i $BACKUP_SSH_KEY"
  rsync -a --chmod=F600,D700 -e "$ssh_cmd" "$stage"/ "$BACKUP_OFFHOST_TARGET"
  # What was sent, by ciphertext checksum: deploy/80-backup-offhost.sh --verify
  # pulls these back from the destination and compares.
  ( cd "$stage" && sha256sum -- * ) > "$DEST/offhost-last.sha256"
  echo "off-host copy: $(ls "$stage" | wc -l) encrypted artifact(s) sent to $BACKUP_OFFHOST_TARGET"
fi
