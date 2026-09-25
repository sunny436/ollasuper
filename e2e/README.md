# E2E & adversarial suites

These run against a **live deployed stack** (a real Convex backend + the Next app),
so they are intentionally **not** part of the blocking CI in `.github/workflows/ci.yml`.
The fast, in-process equivalents — including the full tenant-isolation/IDOR matrix —
live in `packages/backend/convex/security.test.ts` and **do** run on every PR.

## What's here
| Suite | Layer | What it proves |
|-------|-------|----------------|
| `p2-idor.js` | adversarial / contract | 23 IDOR/RBAC probes as two real authed tenants against the live backend |
| `p2-auth.js` | functional E2E | signup → email-verification → reset → admin regression |
| `p-sidebar.js` | E2E | left nav renders + navigates, workspace switcher, `/` → `/chat` |
| `p-notif.js` | E2E | notifications bell + panel |
| `p-cmdk.js` | E2E | command palette (Ctrl/⌘+K) |
| `p-chat.js` | E2E | the chat UI end-to-end, plus the `/` → `/chat` redirect |
| `p-chat-isolation.js` | adversarial | cross-user chat isolation the in-process tests can't reach |

Every Playwright suite asserts **zero `console.error`** and captures failed network
responses — that assertion catches the class of bug types/units can't see.

## Running
```bash
cd e2e && bun install        # or npm install
npx playwright install chromium

# point at your deployment (defaults target the current dev VM):
export E2E_BASE_URL="https://<your-app-host>"     # the Next app
export CONVEX_URL="http://<your-convex-host>:3210" # the Convex backend (for p2-idor)

node p2-idor.js              # adversarial isolation
node p2-auth.js              # full auth journey
npm run dashboard            # the dashboard E2E set
```

Signing in as the QA account (never type its password into a shell):
```bash
ssh root@172.16.70.25 cat /root/qa-account.json > "$TMP/qa.json"   # 0600 on the VM
node run-as.js "$TMP/qa.json" p-scheduled.js                          # any suite, any args
rm "$TMP/qa.json"
```
Suites that need volume or destroy data run on disposable accounts instead:
`node qa-throwaway.js setup|teardown <file>`.

After every frontend deploy, warm the Indian edges (each deploy mints new chunk URLs):
`node warm-edge.js "$TMP/qa.json"` — prints the Indian HIT ratio before and after.

Notes:
- `p2-idor.js` and `p2-auth.js` complete the **mandatory email-verification** flow by
  reading the code the self-hosted backend streams to its logs — they expect log access
  (dev mode). With Resend configured, swap in a mailbox API instead.
- These are the right thing to wire into a **preview-deploy** CI job (spin up the stack,
  run, tear down) rather than the unit gate.
