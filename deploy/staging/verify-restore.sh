#!/usr/bin/env bash
# THE RESTORE DRILL'S PROOF — run by `deploy/staging/staging.sh verify` after
# `restore` + `deploy`, against the STAGING copy only.
#
# A backup nobody has restored is a hypothesis. This proves, for the restored
# set, that:
#   1. every Convex table came back with exactly the documents the backup holds
#      (the backup zip vs a fresh export of staging, table by table);
#   2. every stored blob came back and hashes to its record (file storage);
#   3. every Library row's blob exists (metadata <-> physical consistency);
#   4. the knowledge DB came back, and every file in it is owned by a Convex
#      file (the two planes agree);
#   5. the DBOS scheduler database came back;
#   6. the application planes start: Convex answers, the AI plane is ready.
# Library retrieval, deletion and RAG are then exercised end to end by the e2e
# suites against staging (qa-library*.js, qa-library-delete.js).
#
# Writes /var/lib/myos-backup/restore-drill.json {ok, at, stamp, summary}: the
# host monitor alerts when it is missing, failed or older than 35 days.
#
# TWO PHASES, because check 1 is only exact before any code runs:
#   verify-restore.sh tables   run by `staging.sh restore`, straight after the
#                              import and BEFORE the deploy. No functions are
#                              deployed yet, so no cron has touched a row; the
#                              result goes to $ROOT/.restore-tables.
#   verify-restore.sh          the full drill after `deploy` (checks 2-6 need
#                              the deployed functions); it reports check 1 from
#                              that recorded result. Exporting again here would
#                              compare the backup with rows the crons have since
#                              expired or patched.
set -uo pipefail
MODE=${1:-full}
if [ "$MODE" = tables ]; then
  : "${ROOT:?}" "${SRC:?}" "${ADMIN_KEY:?}" "${CVX_PORT:?}" "${BACKUPS:?}"
else
  : "${ROOT:?}" "${SRC:?}" "${ADMIN_KEY:?}" "${CVX_PORT:?}" "${PG:?}" "${AI_URL:?}" "${BACKUPS:?}"
fi
STATUS_DIR=${RESTORE_STATUS_DIR:-/var/lib/myos-backup}
pass=0; fail=0; notes=()
ok() { pass=$((pass+1)); echo "PASS  $1"; }
no() { fail=$((fail+1)); echo "FAIL  $1 — $2"; notes+=("$1: $2"); }

stamp=$(sed -n 's/^RESTORED_STAMP=//p' "$ROOT/.restored" 2>/dev/null)
[ -n "$stamp" ] || { echo "FATAL: nothing restored yet" >&2; exit 1; }
ZIP="$BACKUPS/convex-$stamp.zip"
echo "=== restore drill: backup set $stamp ==="

# --- 1. tables: the backup vs an export taken BEFORE the deploy --------------
count_tables() {
  unzip -Z1 "$1" | grep '/documents.jsonl$' | grep -v '^_' | while read -r entry; do
    printf '%s %s\n' "${entry%/documents.jsonl}" "$(unzip -p "$1" "$entry" | grep -c .)"
  done | sort
}
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
if [ "$MODE" = tables ]; then
  ( cd "$SRC/packages/backend" && CONVEX_SELF_HOSTED_URL="http://127.0.0.1:$CVX_PORT" \
    CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" node "$SRC/node_modules/convex/bin/main.js" \
    export --path "$WORK/staging.zip" >/dev/null 2>&1 )
  if [ ! -f "$WORK/staging.zip" ]; then
    printf 'FAIL\tstaging export failed\n' > "$ROOT/.restore-tables"
  else
    count_tables "$ZIP" > "$WORK/backup.txt"
    count_tables "$WORK/staging.zip" > "$WORK/staging.txt"
    tables=$(wc -l < "$WORK/backup.txt")
    docs=$(awk '{s+=$2} END {print s+0}' "$WORK/backup.txt")
    if diff -q "$WORK/backup.txt" "$WORK/staging.txt" >/dev/null; then
      printf 'PASS\tall %s tables restored with identical document counts (%s documents), checked before any deploy\n' \
        "$tables" "$docs" > "$ROOT/.restore-tables"
    else
      printf 'FAIL\t%s\n' "$(diff "$WORK/backup.txt" "$WORK/staging.txt" | head -5 | tr '\n\t' '  ')" \
        > "$ROOT/.restore-tables"
    fi
  fi
  cut -f1,2 "$ROOT/.restore-tables" | tr '\t' ' '
  grep -q '^PASS' "$ROOT/.restore-tables"
  exit
fi
if [ -f "$ROOT/.restore-tables" ]; then
  IFS=$'\t' read -r verdict detail < "$ROOT/.restore-tables"
  if [ "$verdict" = PASS ]; then ok "$detail"; else no "table document counts" "$detail"; fi
else
  no "table document counts" "no pre-deploy check recorded - run 'staging.sh restore' on a fresh 'up'"
fi
backup_blobs=$(unzip -p "$ZIP" '_storage/documents.jsonl' 2>/dev/null | grep -c . || echo 0)

# --- 2-4. blobs, rows, knowledge ownership (Convex functions) ---------------
know_ids=$(docker exec "$PG" psql -U myos_ai -d myos_knowledge -At -c "SELECT id FROM files" 2>/dev/null)
know_files=$(printf '%s\n' "$know_ids" | grep -c . || true)
know_chunks=$(docker exec "$PG" psql -U myos_ai -d myos_knowledge -At -c "SELECT count(*) FROM file_chunks" 2>/dev/null || echo 0)
result=$(printf '%s\n' "$know_ids" | SRC=$SRC ADMIN_KEY=$ADMIN_KEY CVX_PORT=$CVX_PORT \
  node "$(dirname "$0")/verify-restore.mjs" 2>"$WORK/verify.err") || true
if [ -z "$result" ]; then
  no "convex verification" "$(tail -c 300 "$WORK/verify.err")"
else
  checked=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.blobs.checked)' "$result")
  good=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.blobs.ok)' "$result")
  bad=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.blobs.mismatch.length+r.blobs.unreadable.length)' "$result")
  bytes=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.blobs.bytes)' "$result")
  if [ "$bad" = 0 ] && [ "$checked" = "$good" ] && [ "$checked" -ge "$backup_blobs" ]; then
    ok "all $checked stored blobs restored and hash-verified ($bytes bytes; backup listed $backup_blobs)"
  else
    no "blob integrity" "checked=$checked ok=$good bad=$bad backup=$backup_blobs"
  fi
  rows=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.rows.rows)' "$result")
  missing=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.rows.missing.length)' "$result")
  [ "$missing" = 0 ] && ok "all $rows Library rows have their blob" || no "library rows" "$missing of $rows missing their blob"
  unowned=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.knowledge.unowned.length)' "$result")
  if [ "$know_files" -gt 0 ] && [ "$unowned" = 0 ]; then
    ok "knowledge DB restored: $know_files files, $know_chunks chunks, every file owned by a Convex file"
  else
    no "knowledge DB" "files=$know_files unowned=$unowned"
  fi
fi

# --- 5. DBOS ------------------------------------------------------------------
dbos_tables=$(docker exec "$PG" psql -U myos_ai -d myos_dbos -At -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')" 2>/dev/null || echo 0)
[ "${dbos_tables:-0}" -gt 0 ] && ok "DBOS scheduler database restored ($dbos_tables tables)" || no "DBOS" "no tables"

# --- 6. the planes start -------------------------------------------------------
curl -fsS "http://127.0.0.1:$CVX_PORT/version" >/dev/null && ok "Convex backend answers" || no "Convex" "no /version"
if curl -fsS "$AI_URL/readyz" | grep -q '"ready":true'; then ok "AI plane ready"; else no "AI plane" "not ready"; fi

echo "===== RESTORE DRILL: $pass passed, $fail failed ====="
mkdir -p "$STATUS_DIR"
summary=$(printf '%s; ' "${notes[@]:-}")
printf '{"ok":%s,"at":%s,"stamp":"%s","passed":%s,"failed":%s,"summary":"%s"}\n' \
  "$([ "$fail" -eq 0 ] && echo true || echo false)" "$(date +%s)" "$stamp" "$pass" "$fail" \
  "$(printf '%s' "$summary" | tr '"\\' "''" | head -c 400)" > "$STATUS_DIR/restore-drill.json"
[ "$fail" -eq 0 ]
