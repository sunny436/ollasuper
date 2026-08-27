#!/usr/bin/env bash
# Deploy the Convex schema/functions to the self-hosted backend on this VM,
# and set deployment env vars referenced by auth.config.ts / env.ts.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd /opt/myos/packages/backend

echo "=== set deployment env vars ==="
# CONVEX_SITE_URL is a built-in self-hosted var (= CONVEX_SITE_ORIGIN), don't override it.
# SITE_URL is the BROWSER-FACING origin used for the OAuth post-login redirect. Set the
# loopback bootstrap value ONLY when unset — once 57-ollasuper-domain.sh has set the
# public https://app.ollasuper.com, a routine redeploy must NOT clobber it back to the
# internal IP (that makes Google sign-in redirect the user to an unreachable address).
CUR_SITE_URL=$(bunx convex env get SITE_URL 2>/dev/null | tr -d '[:space:]')
if [ -n "$CUR_SITE_URL" ]; then
  echo "SITE_URL already set ($CUR_SITE_URL); preserving"
else
  bunx convex env set SITE_URL "http://172.16.70.25:3000" || echo "(SITE_URL not set; continuing)"
fi

echo "=== deploy functions to self-hosted backend ==="
bunx convex deploy -y

echo "=== deployment env vars ==="
bunx convex env list || true
echo "BACKEND_DEPLOY_DONE"
