#!/usr/bin/env bash
# Deploy Phase 2 backend modules (audit, usage, apiKeys, orgs) + verify-key route.
set -euo pipefail
NODE=/usr/bin/node
CVX=/opt/myos/node_modules/convex/bin/main.js

echo "=== place files ==="
cp /tmp/schema.ts  /opt/myos/packages/backend/convex/schema.ts
cp /tmp/audit.ts   /opt/myos/packages/backend/convex/audit.ts
cp /tmp/usage.ts   /opt/myos/packages/backend/convex/usage.ts
cp /tmp/apiKeys.ts /opt/myos/packages/backend/convex/apiKeys.ts
cp /tmp/orgs.ts    /opt/myos/packages/backend/convex/orgs.ts
cp /tmp/http.ts    /opt/myos/packages/backend/convex/http.ts
echo ok

echo "=== redeploy Convex (Node) ==="
cd /opt/myos/packages/backend
"$NODE" "$CVX" deploy -y
echo "PLATFORM_DEPLOY_DONE"
