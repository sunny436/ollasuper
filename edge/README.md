# edge — Host/path adapter in front of the Cloudflare tunnel

`proxy.js` listens on `127.0.0.1:5150` and fans traffic out to the three planes.
It exists for one reason, and it is meant to be deleted.

## Why it exists

The Cloudflare tunnel on the production VM is **token/dashboard-managed**:

```
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel run --token <REDACTED>
```

There is no `config.yml` on the VM, so its ingress lives in the Cloudflare Zero
Trust dashboard. The API token we hold is **zone-scoped to ollasuper.com**, which
is not enough to edit a tunnel — verified three ways:

| call | result |
|---|---|
| `GET /accounts/{id}/cfd_tunnel` | `success: true`, 0 results |
| `GET /accounts/{id}/cfd_tunnel/{id}/configurations` | `1001 Not authorized` |
| `GET /accounts/{id}` | `9109 Unauthorized` |

The tunnel's existing rule already forwarded `app.ollasuper.com` to
`http://localhost:5150` (the port the retired `copyai-cli` used). That port is
ours, so we terminate there and route onward — no Cloudflare permissions needed.

## Routing

Two modes, both live at once, path checked first:

1. **PATH** — `/__cvx/*` → `:3210`, `/__cvx-site/*` → `:3211`, prefix stripped.
   Rides the one hostname the tunnel already serves, so it needs **no Cloudflare
   change at all**. The `__` prefix cannot collide with a Next.js route.
   `apps/app/.env` sets `NEXT_PUBLIC_CONVEX_URL=https://app.ollasuper.com/__cvx`.

2. **HOST** — `app|convex|convex-site.ollasuper.com` → `:3000|:3210|:3211`.
   The clean form. Inert until those hostnames exist as Public Hostnames on the
   tunnel; DNS records already point at it.

WebSocket `upgrade` is forwarded explicitly. That is load-bearing: the Convex
browser client is a WSS connection, so a proxy handling only `request` would
serve pages perfectly and silently break every chat stream. Verified end to end —
`https://app.ollasuper.com/__cvx/api/1.19.2/sync` returns `101 Switching
Protocols` through Cloudflare, matching a direct call to `:3210`.

## How to retire it

1. In Zero Trust → Networks → Tunnels → `8ad8b94d-…` → Public Hostname, add
   `convex.ollasuper.com` → `http://localhost:3210` and
   `convex-site.ollasuper.com` → `http://localhost:3211`, and repoint
   `app.ollasuper.com` from `:5150` to `http://localhost:3000`.
2. Rebuild the app with `NEXT_PUBLIC_CONVEX_URL=https://convex.ollasuper.com`
   (it is inlined at build time — a restart is not enough).
3. `systemctl disable --now myos-edge` and delete this directory.

Step 2 is the easy one to forget: skip it and the app keeps working through the
path route while looking like it is on the clean hostnames.

## Install

```bash
install -D -m644 edge/proxy.js /opt/myos-edge/proxy.js
install -D -m644 edge/myos-edge.service /etc/systemd/system/myos-edge.service
systemctl daemon-reload && systemctl enable --now myos-edge
```
