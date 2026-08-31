#!/usr/bin/env bash
# Deploy the multi-tenant UI: workspace hook + nav tab.
set -euo pipefail
NODE=/usr/bin/node
NEXT=/opt/myos/node_modules/next/dist/bin/next

echo "=== place UI files ==="
cp /tmp/useWorkspace.ts /opt/myos/apps/app/src/lib/useWorkspace.ts
cp /tmp/navigation.tsx    "/opt/myos/apps/app/src/app/[locale]/(dashboard)/_components/navigation.tsx"
echo ok

echo "=== rebuild dashboard (Node) ==="
cd /opt/myos/apps/app
"$NODE" "$NEXT" build

echo "=== restart ==="
systemctl restart myos-app.service
sleep 6
echo "app: $(systemctl is-active myos-app.service)"
curl -fsSL -o /dev/null -w "/en/files -> %{http_code}\n" http://127.0.0.1:3000/en/files || echo "/en/files (auth redirect)"
echo "UI_MT_DONE"
