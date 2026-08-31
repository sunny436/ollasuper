#!/usr/bin/env bash
# Deploy the section removal: Dashboard, Sessions, Jobs and Platform are gone and
# `/` now redirects to `/chat`. Remaining surfaces: Chat, Files, Settings, Billing.
#
# TWO-PHASE, because this is the one deploy in this repo that DROPS a table.
# `jobs` is removed from schema.ts, and Convex will not accept a schema that omits
# a table still holding documents. The drain therefore has to run against the OLD
# schema — the one currently on disk, where `jobs` still exists — BEFORE the pull.
# If the table is already empty the drain deletes 0 and phase 1 is a no-op, so this
# script is safe to re-run.
#
# Idempotent. Run as root on the VM, from anywhere.
set -uo pipefail
N=/usr/bin/node
C=/opt/myos/node_modules/convex/bin/main.js
NEXT=/opt/myos/node_modules/next/dist/bin/next
BE=/opt/myos/packages/backend
DRAIN="$BE/convex/_drainJobs.ts"

cleanup() { rm -f "$DRAIN"; }
trap cleanup EXIT

# ---------------------------------------------------------------- phase 1: drain
# Skipped when the checkout has already been updated (schema no longer has `jobs`),
# which is what happens on a re-run after a successful pull.
if grep -q 'jobs: defineTable' "$BE/convex/schema.ts" 2>/dev/null; then
  echo "=== [1/4] draining the jobs table under the OLD schema ==="

  # Temporary, deleted by the EXIT trap below. internalMutation is not callable
  # from any client — only via `convex run` with the admin key — so this is not a
  # publicly reachable surface for the ~30s it exists.
  cat > "$DRAIN" <<'EOF'
import { internalMutation } from "./_generated/server";

/** TEMPORARY one-shot: batch-delete every jobs row so the table can be dropped. */
export const batch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("jobs").take(500);
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
EOF

  cd "$BE"
  "$N" "$C" deploy -y 2>&1 | tail -2 || { echo "PHASE1_DEPLOY_FAILED"; exit 1; }

  TOTAL=0
  for i in $(seq 1 200); do
    D=$("$N" "$C" run _drainJobs:batch 2>/dev/null | tail -1 | tr -d '"[:space:]')
    case "$D" in ''|*[!0-9]*) echo "drain returned non-numeric: '$D'"; exit 1;; esac
    TOTAL=$((TOTAL + D))
    echo "  batch $i deleted: $D (total $TOTAL)"
    [ "$D" = "0" ] && break
  done
  echo "jobs rows deleted: $TOTAL"
  cleanup
else
  echo "=== [1/4] schema has no jobs table — drain not needed, skipping ==="
fi

# ---------------------------------------------------------------- phase 2: pull
echo "=== [2/4] pull ==="
cd /opt/myos
git pull --ff-only 2>&1 | tail -3 || { echo "PULL_FAILED"; exit 1; }

# ---------------------------------------------------------- phase 3: convex push
echo "=== [3/4] deploy Convex (schema without jobs; jobs/dashboard/sessions removed) ==="
cd "$BE"
set -e
"$N" "$C" deploy -y 2>&1 | tail -3
set +e

# ------------------------------------------------------- phase 4: rebuild + serve
echo "=== [4/4] rebuild + restart the Next app ==="
cd /opt/myos/apps/app
set -e
"$NEXT" build 2>&1 | tail -6
set +e
systemctl restart myos-app; sleep 8
echo "app=$(systemctl is-active myos-app)"

echo "=== verify ==="
curl -fsSL -o /dev/null -w "/en          -> %{http_code} (expect 307 -> /chat or /login)\n" http://127.0.0.1:3000/en
curl -s    -o /dev/null -w "/en/jobs     -> %{http_code} (expect 404 or auth redirect)\n"   http://127.0.0.1:3000/en/jobs
curl -s    -o /dev/null -w "/en/platform -> %{http_code} (expect 404 or auth redirect)\n"   http://127.0.0.1:3000/en/platform
curl -fsSL -o /dev/null -w "/en/chat     -> %{http_code}\n"                                 http://127.0.0.1:3000/en/chat
echo REMOVE_SECTIONS_DONE
