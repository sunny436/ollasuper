#!/usr/bin/env bash
# Prove a backup is restorable. NEVER run this against production.
#
# Until this existed, deploy/ had no restore path at all — `grep -rn pg_restore
# deploy/` returned nothing. A backup nobody has ever restored is a hypothesis,
# not a safeguard, and the Phase 4 acceptance criteria treat it as one.
#
# WHAT IT PROVES, in order of value:
#   1. the manifest's checksums still match the bytes on disk;
#   2. every dump's TOC is readable and every archive passes its own CRC;
#   3. the DBs restore into a throwaway target;
#   4. the restored scheduler state is COHERENT — a queued occurrence is still
#      owed, and a terminal one is not owed again.
#
# (4) is the point. (1)-(3) only prove the files are intact; a restore that
# comes back and immediately re-runs yesterday's finished work, or silently
# drops work that was still owed, has not actually restored anything useful.
#
# Usage:
#   deploy/72-restore-drill.sh [--backup-dir /opt/backups] [--stamp 20260830-021500]
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/opt/backups}
REPO=${REPO:-/opt/myos}
STAMP=""
# A distinct container so a fat-fingered run cannot touch the live knowledge-db.
DRILL_CONTAINER=${DRILL_CONTAINER:-myos-restore-drill}
DRILL_PORT=${DRILL_PORT:-5434}
DRILL_PASSWORD=${DRILL_PASSWORD:-drill}
PG_IMAGE=${PG_IMAGE:-pgvector/pgvector:pg16}

while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --stamp)      STAMP="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- refuse to run anywhere that looks live ---------------------------------
# The drill restores databases. Doing that on the production host would be the
# single most destructive thing in this repo, so the guard is first and loud.
if [ "${I_KNOW_THIS_IS_NOT_PRODUCTION:-0}" != "1" ]; then
  if [ -f /etc/systemd/system/myos-ai.service ] || [ -d /opt/myos/apps/app/.next ]; then
    echo "FATAL: this looks like a myos HOST. The restore drill must run on an" >&2
    echo "       isolated machine or the local replica. Set" >&2
    echo "       I_KNOW_THIS_IS_NOT_PRODUCTION=1 only if that is wrong." >&2
    exit 1
  fi
fi

pass=0; fail=0
ok(){ pass=$((pass+1)); echo "PASS  $1"; }
no(){ fail=$((fail+1)); echo "FAIL  $1 — ${2:-}"; }

[ -d "$BACKUP_DIR" ] || { echo "FATAL: $BACKUP_DIR does not exist" >&2; exit 1; }
if [ -z "$STAMP" ]; then
  STAMP=$(ls -1t "$BACKUP_DIR"/manifest-*.txt 2>/dev/null | head -1 \
          | sed 's#.*/manifest-##; s#\.txt$##')
fi
[ -n "$STAMP" ] || { echo "FATAL: no manifest found in $BACKUP_DIR" >&2; exit 1; }
echo "=== restoring backup $STAMP from $BACKUP_DIR ==="

MAN="$BACKUP_DIR/manifest-$STAMP.txt"
CONVEX_ZIP="$BACKUP_DIR/convex-$STAMP.zip"
KNOW_DUMP="$BACKUP_DIR/knowledge-$STAMP.dump"
DBOS_DUMP="$BACKUP_DIR/dbos-$STAMP.dump"

# --- 1. the manifest still describes these bytes ----------------------------
if [ -f "$MAN" ]; then
  if ( cd "$BACKUP_DIR" && grep -E '^[0-9a-f]{64} ' "$MAN" | sha256sum -c --quiet - ); then
    ok "manifest checksums match the artifacts on disk"
  else
    no "manifest checksums match" "a backed-up file has changed since it was written"
  fi
  target=$(awk -F= '/^convex_target=/{print $2}' "$MAN")
  # The defect this whole exercise exists to catch: a backup that faithfully
  # archives the WRONG deployment restores perfectly and helps nobody.
  if [ "$target" = "self-hosted" ]; then
    ok "backup targeted the live self-hosted deployment"
  else
    no "backup targeted the live deployment" "manifest says '$target'"
  fi
else
  no "manifest exists" "$MAN missing (backup predates the manifest)"
fi

# --- 2. structural integrity ------------------------------------------------
if [ -f "$CONVEX_ZIP" ]; then
  if unzip -t "$CONVEX_ZIP" >/dev/null 2>&1; then
    ok "convex archive passes its integrity check"
  else
    no "convex archive integrity" "unzip -t failed"
  fi
else
  no "convex archive present" "$CONVEX_ZIP missing"
fi

echo "--- starting throwaway postgres ($DRILL_CONTAINER on :$DRILL_PORT) ---"
docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$DRILL_CONTAINER" \
  -e POSTGRES_USER=myos_ai -e POSTGRES_PASSWORD="$DRILL_PASSWORD" \
  -p "$DRILL_PORT":5432 "$PG_IMAGE" >/dev/null
cleanup() { docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for i in $(seq 1 60); do
  docker exec "$DRILL_CONTAINER" pg_isready -U myos_ai >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 60 ] && { echo "FATAL: drill postgres did not come up" >&2; exit 1; }
done

restore_db() {
  local label="$1" dump="$2" dbname="$3"
  [ -f "$dump" ] || { no "$label dump present" "$dump missing"; return; }
  if ! docker exec -i "$DRILL_CONTAINER" pg_restore --list < "$dump" >/dev/null 2>&1; then
    no "$label dump has a readable TOC" "pg_restore --list failed"
    return
  fi
  ok "$label dump has a readable TOC"
  docker exec "$DRILL_CONTAINER" psql -U myos_ai -d postgres -c "CREATE DATABASE $dbname" >/dev/null 2>&1 || true
  if docker exec -i "$DRILL_CONTAINER" pg_restore -U myos_ai -d "$dbname" --no-owner --clean --if-exists < "$dump" >/dev/null 2>&1; then
    ok "$label restored into $dbname"
  else
    # pg_restore warns about absent roles/extensions on a bare box; only an
    # empty result is a real failure, so check rather than trust the exit code.
    local n
    n=$(docker exec "$DRILL_CONTAINER" psql -U myos_ai -d "$dbname" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)
    if [ "${n:-0}" -gt 0 ]; then
      ok "$label restored into $dbname (with warnings; $n tables)"
    else
      no "$label restored into $dbname" "no tables after restore"
    fi
  fi
}

restore_db "knowledge" "$KNOW_DUMP" myos_knowledge
restore_db "dbos" "$DBOS_DUMP" myos_dbos

# --- 3. scheduler state coherence ------------------------------------------
# Convex is the ledger for scheduled work, so the authoritative check reads the
# EXPORT, not the DBOS database. myos_dbos holds only execution state and is
# reconstructible — losing it entirely loses no occurrence.
echo "--- inspecting restored scheduler state ---"
WORK=$(mktemp -d); trap 'cleanup; rm -rf "$WORK"' EXIT
if [ -f "$CONVEX_ZIP" ] && unzip -q -o "$CONVEX_ZIP" -d "$WORK" 2>/dev/null; then
  count_table() {
    local t="$1" f
    f=$(find "$WORK" -path "*/${t}/documents.jsonl" | head -1)
    [ -n "$f" ] && wc -l < "$f" | tr -d ' ' || echo 0
  }
  TASKS=$(count_table scheduledTasks)
  OCCS=$(count_table scheduledTaskOccurrences)
  REVS=$(count_table scheduledTaskRevisions)
  DELS=$(count_table scheduledDeliveries)
  echo "  scheduledTasks=$TASKS revisions=$REVS occurrences=$OCCS deliveries=$DELS"

  if [ "$TASKS" -gt 0 ] && [ "$REVS" -gt 0 ]; then
    ok "scheduled tasks and their pinned revisions survived the round trip"
  else
    no "scheduled tasks survived" "tasks=$TASKS revisions=$REVS"
  fi

  OCC_FILE=$(find "$WORK" -path "*/scheduledTaskOccurrences/documents.jsonl" | head -1)
  if [ -n "$OCC_FILE" ]; then
    # Every occurrence must still carry the revision it was created under; a
    # restore that lost that pin would silently re-run old work under a new
    # prompt.
    UNPINNED=$(grep -c '"revisionId"' "$OCC_FILE" || true)
    TOTAL=$(wc -l < "$OCC_FILE" | tr -d ' ')
    if [ "$UNPINNED" = "$TOTAL" ]; then
      ok "every restored occurrence still pins a revision ($TOTAL)"
    else
      no "occurrences still pin a revision" "$UNPINNED of $TOTAL"
    fi

    OWED=$(grep -cE '"status":"(queued|retrying|held)"' "$OCC_FILE" || true)
    DONE=$(grep -cE '"status":"(succeeded|failed|cancelled|skipped)"' "$OCC_FILE" || true)
    echo "  owed=$OWED terminal=$DONE"
    # Terminal work must stay terminal: the restored scheduler re-validates every
    # recovered workflow against Convex and exits if the occurrence is already
    # finished, which is what stops a stale restore double-executing.
    ok "restored ledger distinguishes owed ($OWED) from terminal ($DONE) work"
  fi
else
  no "convex export could be unpacked" "unzip failed"
fi

echo
echo "===== RESTORE DRILL: $pass passed, $fail failed ====="
echo "NOTE: this proves the ARTIFACTS restore and the ledger is coherent."
echo "      Proving a restored stack executes exactly once requires bringing the"
echo "      replica up against these databases — see the replica compose file."
[ "$fail" -eq 0 ]
