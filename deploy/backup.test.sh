#!/usr/bin/env bash
# Exercises deploy/backup.sh's target selection and integrity gates with fake
# `node` and `docker`, so the real code path runs without touching anything.
set -uo pipefail
REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup.sh"
T=$(mktemp -d)
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS  $1"; }
no()  { fail=$((fail+1)); echo "FAIL  $1 — $2"; }

# ── fakes ────────────────────────────────────────────────────────────────────
mkdir -p "$T/bin" "$T/dest" "$T/repo/packages/backend" "$T/repo/services/ai"
cat > "$T/bin/node" <<'EOF'
#!/usr/bin/env bash
# Stands in for `convex export`: writes a real zip at --path, and records argv.
out=""; prev=""
for a in "$@"; do [ "$prev" = "--path" ] && out="$a"; prev="$a"; done
echo "$@" >> "$FAKE_LOG"
[ -n "$out" ] || exit 0
if [ "${FAKE_CORRUPT:-0}" = "1" ]; then head -c 200000 /dev/urandom > "$out"; exit 0; fi
if [ "${FAKE_TINY:-0}" = "1" ]; then echo tiny > "$out"; exit 0; fi
d=$(mktemp -d); head -c 300000 /dev/urandom > "$d/data.bin"
"$FAKE_MKZIP" "$out" "$d/data.bin"
EOF
# A fake that BEHAVES, not one that just exits 0.
#
# The first version of this returned 0 for everything, so the dump path never
# actually ran and `pg_restore --list -` shipped: the trailing dash makes real
# pg_restore look for a FILE named "-" and fail, which only showed up on
# production. A fake that always succeeds tests nothing.
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "compose -f")
    # `ps -q` -> a container id; `ps <svc>` -> a status line, so the dump blocks run.
    for a in "$@"; do [ "$a" = "-q" ] && { echo "fakecid"; exit 0; }; done
    echo "knowledge-db  Up 3 days (healthy)"; exit 0 ;;
esac
if [ "$1" = "exec" ]; then
  shift
  # strip -i / the container id
  while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) break ;; esac; done
  shift 2>/dev/null   # container id
  case "${1:-}" in
    pg_dump)  printf 'PGDMP'; head -c 40000 /dev/zero | tr '\0' 'x'; exit 0 ;;
    pg_restore)
      # Real pg_restore reads STDIN only when given no filename. A literal "-"
      # is treated as a filename and fails — reproduce that exactly.
      for a in "$@"; do
        [ "$a" = "-" ] && { echo 'pg_restore: error: could not open input file "-"' >&2; exit 1; }
      done
      head -c 5 | grep -q 'PGDMP' && exit 0 || exit 1 ;;
    psql) echo 1; exit 0 ;;
  esac
fi
exit 0
EOF
# The fake export needs to CREATE a valid zip. Linux/CI has `zip` or `python3`;
# a Windows dev box may have neither, but does have uv's CPython. (backup.sh's
# own verify_zip only needs to READ one, via unzip or python3.)
cat > "$T/bin/mkzip.py" <<'EOF'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], "w")
z.write(sys.argv[2], "data.bin")
z.close()
EOF
cat > "$T/bin/mkzip" <<EOF
#!/usr/bin/env bash
set -e
if command -v python3 >/dev/null 2>&1 && python3 -c '' >/dev/null 2>&1; then
  exec python3 "$T/bin/mkzip.py" "\$1" "\$2"
elif command -v zip >/dev/null 2>&1; then
  d=\$(dirname "\$2"); ( cd "\$d" && zip -q "\$1" "\$(basename "\$2")" ); exit
elif command -v uv >/dev/null 2>&1; then
  exec uv run --no-project python "$T/bin/mkzip.py" "\$1" "\$2"
fi
echo "no zip/python3/uv available to build a test archive" >&2; exit 1
EOF
chmod +x "$T/bin/node" "$T/bin/docker" "$T/bin/mkzip"
export FAKE_MKZIP="$T/bin/mkzip"
# backup.sh hardcodes /usr/bin/node, so shim that path via a wrapper dir.
mkdir -p "$T/usrbin"; cp "$T/bin/node" "$T/usrbin/node"

run() { # run <label> [env...]
  local label="$1"; shift
  rm -rf "$T/dest"; mkdir -p "$T/dest"
  export FAKE_LOG="$T/argv.log"; : > "$FAKE_LOG"
  sed "s#/usr/bin/node#$T/usrbin/node#" "$REAL" > "$T/backup.sh"
  env PATH="$T/bin:$PATH" BACKUP_DIR="$T/dest" REPO="$T/repo" "$@" \
      bash "$T/backup.sh" > "$T/out.log" 2>&1
  echo $?
}

# ── 1. the defect: a present Cloud keyfile must NOT redirect the backup ──────
touch "$T/cloudkey"
rc=$(run keyfile-present CONVEX_KEY_FILE="$T/cloudkey" CONVEX_EMPTY_ENV="$T/empty")
if [ "$rc" = 0 ] && grep -q 'from self-hosted' "$T/out.log"; then
  ok "a present Cloud keyfile no longer hijacks the backup (B1)"
else
  no "a present Cloud keyfile no longer hijacks the backup (B1)" "rc=$rc $(tail -2 "$T/out.log")"
fi
if grep -q -- '--env-file' "$T/argv.log"; then
  no "self-hosted export passes no --env-file" "cloud args leaked"
else
  ok "self-hosted export passes no --env-file"
fi

# ── 2. cloud is reachable, but only on purpose ───────────────────────────────
rc=$(run cloud-explicit BACKUP_TARGET=cloud CONVEX_KEY_FILE="$T/cloudkey" CONVEX_EMPTY_ENV="$T/empty")
if [ "$rc" = 0 ] && grep -q 'from Convex Cloud' "$T/out.log" && grep -q -- '--env-file' "$T/argv.log"; then
  ok "BACKUP_TARGET=cloud still works and passes --env-file"
else
  no "BACKUP_TARGET=cloud still works" "rc=$rc $(tail -2 "$T/out.log")"
fi

rc=$(run cloud-no-key BACKUP_TARGET=cloud CONVEX_KEY_FILE="$T/missing" CONVEX_EMPTY_ENV="$T/empty")
[ "$rc" != 0 ] && ok "BACKUP_TARGET=cloud without a keyfile fails loudly" \
               || no "BACKUP_TARGET=cloud without a keyfile fails loudly" "rc=$rc"

rc=$(run bad-target BACKUP_TARGET=nonsense)
[ "$rc" != 0 ] && ok "an unknown BACKUP_TARGET is rejected" \
               || no "an unknown BACKUP_TARGET is rejected" "rc=$rc"

# ── 3. integrity gates ───────────────────────────────────────────────────────
rc=$(run corrupt FAKE_CORRUPT=1)
if [ "$rc" != 0 ] && grep -q 'integrity check' "$T/out.log"; then
  ok "a corrupt archive is caught by the structural check (B8)"
else
  no "a corrupt archive is caught (B8)" "rc=$rc $(tail -2 "$T/out.log")"
fi

rc=$(run tiny FAKE_TINY=1)
if [ "$rc" != 0 ] && grep -q 'refusing to prune' "$T/out.log"; then
  ok "a truncated archive is caught by the size floor"
else
  no "a truncated archive is caught" "rc=$rc $(tail -2 "$T/out.log")"
fi

# ── 4. a failed backup must never evict the last good one ────────────────────
rm -rf "$T/dest"; mkdir -p "$T/dest"
export FAKE_LOG="$T/argv.log"
sed "s#/usr/bin/node#$T/usrbin/node#" "$REAL" > "$T/backup.sh"
env PATH="$T/bin:$PATH" BACKUP_DIR="$T/dest" REPO="$T/repo" BACKUP_KEEP=1 \
    bash "$T/backup.sh" >/dev/null 2>&1
good=$(ls -1 "$T/dest"/convex-*.zip 2>/dev/null | head -1)
sleep 1
env PATH="$T/bin:$PATH" BACKUP_DIR="$T/dest" REPO="$T/repo" BACKUP_KEEP=1 FAKE_CORRUPT=1 \
    bash "$T/backup.sh" >/dev/null 2>&1
if [ -n "$good" ] && [ -f "$good" ]; then
  ok "a corrupt run does not prune the last good archive"
else
  no "a corrupt run does not prune the last good archive" "good=$good gone"
fi

# ── 4b. the dump path is actually exercised ─────────────────────────────────
rm -rf "$T/dest"; mkdir -p "$T/dest"
env PATH="$T/bin:$PATH" BACKUP_DIR="$T/dest" REPO="$T/repo" bash "$T/backup.sh" > "$T/out.log" 2>&1
rc=$?
if [ "$rc" = 0 ] && grep -q "knowledge dump written" "$T/out.log"; then
  ok "the knowledge dump is produced and passes pg_restore --list"
else
  no "the knowledge dump verifies" "rc=$rc $(grep -i fatal "$T/out.log" | head -1)"
fi
if grep -q "dbos dump written" "$T/out.log"; then
  ok "the DBOS dump is produced and verified"
else
  no "the DBOS dump is produced" "$(grep -i fatal "$T/out.log" | head -1)"
fi
# ── 5. the manifest is written last and covers the archive ───────────────────
rm -rf "$T/dest"; mkdir -p "$T/dest"
env PATH="$T/bin:$PATH" BACKUP_DIR="$T/dest" REPO="$T/repo" bash "$T/backup.sh" >/dev/null 2>&1
man=$(ls -1 "$T/dest"/manifest-*.txt 2>/dev/null | head -1)
if [ -n "$man" ] && grep -q 'convex_target=self-hosted' "$man" && grep -q 'convex-.*\.zip' "$man"; then
  ok "manifest records the target and checksums the archive"
else
  no "manifest records target + checksum" "man=$man"
fi
if [ -n "$man" ]; then
  # Entries are basenames relative to the backup dir. (MSYS sha256sum prefixes
  # the name with a '*' binary marker; GNU coreutils on the VM does not.)
  name=$(awk '/convex-.*\.zip/{print $2}' "$man" | head -1 | sed 's/^\*//')
  want=$(awk '/convex-.*\.zip/{print $1}' "$man" | head -1)
  case "$name" in */*) no "manifest uses basenames, not absolute paths" "$name"; ;; esac
  got=$(cd "$T/dest" && sha256sum "$name" | awk '{print $1}')
  [ "$want" = "$got" ] && ok "manifest checksum matches the artifact on disk" \
                       || no "manifest checksum matches" "$want != $got"
  # A verifier can re-check the whole manifest in one shot from inside $DEST.
  if ( cd "$T/dest" && grep -E '^[0-9a-f]{64} ' "$man" | sha256sum -c --quiet - ) 2>/dev/null; then
    ok "the manifest verifies as a whole via 'sha256sum -c'"
  else
    no "the manifest verifies via 'sha256sum -c'" "check failed"
  fi
fi

rm -rf "$T"
echo
echo "===== BACKUP: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ]
