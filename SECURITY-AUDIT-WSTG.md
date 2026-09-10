# OllaSuper — OWASP WSTG Security Audit

**Scope:** entire OllaSuper codebase (Convex data plane, Python inference plane, Next.js frontend, edge proxy, deploy scripts)
**Methodology:** OWASP Web Security Testing Guide — stable **4.2** IDs where the scenario exists in 4.2; **5.0-dev (master)** section numbers where the content is master-only, named as such.
**Mode:** read-only. No code, config, dependency or deployment change was made. Runtime evidence was gathered only by passive, non-mutating HTTP reads of the public production endpoint.
**Date:** 2026-09-10

---

## Remediation log (2026-09-10)

Every finding below has now been addressed in code. Status here is the source of truth; the finding sections keep their original analysis.

| # | Finding | Status | Where |
|---|---|---|---|
| D.1 | Stored XSS via `/share/file` | **Fixed** — serving side *and* root cause (`register` now rejects an executable declared type) | `f324d3a` + this change |
| D.2a | No security headers on the Convex origin | **Fixed** for the routes that stream user-influenced bytes (`nosniff` on `/share/file`, `/artifact/file`) | `http.ts` |
| D.2b | No HSTS | **Fixed** at the app layer, deliberately **not** at the Cloudflare edge | `next.config.mjs` |
| D.3 | Anonymous service-key proxies | **Fixed** — both now require an active signed-in caller | `chat/capabilities.ts`, `skillCapabilities.ts` |
| D.4 | `web.subscribe` unvalidated + oracle | **Fixed** — email validated, `userGroup` allowlisted, provider body no longer echoed. Rate limit still **open** (see below) | `web.ts` |
| D.5 | Reset timing oracle | **Fixed** — the send is enqueued, so the action no longer branches on the request path | `authSessions.ts` |
| D.6 | 24 callables skipped account status | **Fixed** — new leaf helper `activeUserId` / `activeCallerId` | `accountState.ts` + 10 files |
| D.7 | Shared throttle map + spoofable key | **Fixed** — separate maps, trusted key everywhere, LRU instead of `.clear()` | `middleware.ts` |
| D.8 | Reset had no rate limit | **Fixed** — 5/hour per account, in the same transaction as the lookup | `authSessions.ts` |

**Still open, and honestly so:**
- **The G.2 root cause is NOT fixed.** `consumeWindow` is keyed on `userId`, so unauthenticated paths still cannot be rate-limited in the application. D.8 was closeable only because the *expensive* branch has a userId; `web.subscribe` genuinely has none. That needs a Cloudflare rule spanning `/__cvx` and `/api/auth`, which is infrastructure, not code.
- **HSTS is app-layer only.** It covers the `app.ollasuper.com` host (and therefore `/__cvx*` on it, since HSTS is per-host), but the zone-wide edge setting was deliberately avoided: the apex, `www` and `tokens.` belong to other properties and the zone carries live mail records.
- **Account deletion was deliberately left ungated** (`users.deletionFactor`, `requestAccountDeletionCode`, `deleteCurrentUserAccount`). Blocking a suspended user from erasing their own account is a product/legal call, not a security one — flagged rather than decided.

---

## A. Executive summary

OllaSuper is **substantially more hardened than a typical application of its size**, and this audit says so plainly because the evidence says so. A prior four-tranche remediation programme closed the enumeration oracles, the blob-execution surface, the SSRF surface, the DuckDB sandbox escape, the webhook comparison weaknesses and the auth-lifecycle gaps — and this audit re-verified each of those and found them **still closed**. Twelve such regression confirmations are listed in §D.0 and are not counted as findings.

The audit deliberately targeted the **complement** of the prior programme. That programme was finding-driven and scoped to functions taking a user-owned `v.id()`; a function taking **no id at all**, or a route whose response *headers* rather than body carried the untrusted value, was structurally outside it. That is where this audit's material findings sit.

**One HIGH-severity confirmed vulnerability was found:** `GET /share/file` reflects a **client-controlled `Content-Type`** onto attacker-supplied bytes, on **the app's own origin**, with **no `nosniff` and no `Content-Disposition`**. The prior blob-execution remediation neutralised the *blob's* stored type but this one route re-attaches the *row's* declared type on top of it — so the remediation is bypassed by the single serving path that does not use `ctx.storage.getUrl()`. This yields stored XSS against any logged-in user who opens the link, in the same origin as the application.

Two MEDIUM findings are structural rather than incidental: the **Convex HTTP origin serves no security headers at all** (the Next.js `headers()` config covers only `:3000`, never `/__cvx*`, though both are `app.ollasuper.com`), and **production serves no HSTS**. Both were confirmed at runtime.

The remaining findings cluster into two root causes (§G): **authorization is applied per-function rather than by construction**, and **the only rate-limit primitive is keyed on `userId`, so no unauthenticated path can be covered by it at all**.

**No BOLA / cross-tenant data-access vulnerability was found.** Every ownership check examined was present and correct, including the ones the classifier initially flagged. The two coexisting trust models that CLAUDE.md names as the codebase's main hazard are, on the evidence, applied correctly.

| | Count |
|---|---|
| Confirmed vulnerabilities | **1 High · 3 Medium · 2 Low** |
| Needs runtime validation | 3 |
| Hardening gaps | 6 |
| Already-known open (labelled, not re-discovered) | 2 |
| Regression confirmations (verified still closed) | 12 |
| False positives eliminated during triage | 5 |

---

## B. Attack-surface map

### B.1 Convex data plane — 132 internet-reachable public callables

Classified by what each actually enforces (full classification run over every `export const … = query|mutation|action`):

| Posture | Count | Meaning |
|---|---|---|
| Strong helper (`requireUserId` / `getUserIdOrNull` / `requireMember` / `requireRole` / `requireProfileUserId` / `requireThreadAccess` / `requireAttachmentAccess`) | **101** | authenticated **and** account-status enforced |
| Bare `getAuthUserId`, ownership checked inline, **no account-status check** | **24** | see finding D.6 |
| No auth reference at all | **7** | see below |

The 7 with no auth reference, individually triaged:

| Function | Verdict |
|---|---|
| `scheduled/parse.ts:parse` | **False positive** — delegates to `gate`, which calls `requireUserId` + `requireMember` + `consumeWindow`. Convex actions cannot touch the DB, so delegation is architecturally required, not a gap. |
| `chat/shares.ts:getByToken` | **Intentionally public**, token-gated. Projection verified to strip `storageId`. |
| `authSessions.ts:requestPasswordReset` | Intentionally anonymous. **Already-known** rate-limit gap (D.8) + **new** timing oracle (D.5). |
| `web.ts:subscribe` | Intentionally anonymous (newsletter). Finding is missing validation/rate-limit (D.4), **not** missing auth. |
| `chat/capabilities.ts:list` | **Confused deputy** — D.3 |
| `skillCapabilities.ts:list` | **Confused deputy** — D.3 |
| `chat/models.ts:list` | Low — anonymous catalogue disclosure (F.5) |

Also present: 111 internal callables (not internet-reachable).

### B.2 Convex HTTP routes — 9

| Route | Auth | Verdict |
|---|---|---|
| `POST /backend/webhook` | `BACKEND_WEBHOOK_SECRET`, constant-time | OK |
| `POST /ai/ingress` | `AI_INGRESS_SECRET` constant-time **+ `streamId` capability scoping** | OK — exemplary |
| `POST /ai/file` | ingress secret + `attachmentInStream` ownership | OK |
| `POST /ai/ingest-file` | ingress secret | OK |
| `POST /ai/artifact` | ingress secret + `neutralizedBlobType` | OK |
| `GET /artifact/file` | one-time expiring token; **forces `Content-Disposition: attachment`** | OK |
| `POST /api/verify-key` | none (it *is* the verifier) | F.4 — unbounded oracle, `...found` spread |
| `GET /share/file` | unguessable token + snapshot membership | **D.1 — HIGH** |
| `POST /mail/webhook` | Svix HMAC, replay window, constant-time | OK — exemplary |

### B.3 Python inference plane — 15 FastAPI routes across 6 routers

Router-level `dependencies=[Depends(require_service_key)]` on **all five** application routers (`files`, `generate`, `tools`, `schedule`, `report`). Only `health` is unguarded (`/healthz`, `/readyz`) — correct. `require_service_key` uses `hmac.compare_digest`, accumulates with `|=` rather than early-returning (so it does not leak *which* key matched), and **fails closed with 503** when unconfigured. Bound to `127.0.0.1:8770`.

### B.4 Other surfaces

`edge/proxy.js` (`127.0.0.1:5150`) — path routing `/__cvx`→`:3210`, `/__cvx-site`→`:3211` wins over host routing; strips `x-middleware-subrequest` on **both** the request and upgrade paths (CVE-2025-29927 mitigation). `apps/app/src/middleware.ts` — auth gate, i18n, three per-IP throttles. DBOS scheduler; `backend-echo` on `:4000`; 79 deploy scripts; four stores with different isolation models (Convex documents, pgvector, DBOS, blob storage).

**Critical topology fact:** `app.ollasuper.com`, `app.ollasuper.com/__cvx` and `app.ollasuper.com/__cvx-site` are **one browser origin** but **three different servers**, and only the first passes through Next.js. This single fact underlies D.1 and D.2.

---

## C. WSTG coverage matrix

| WSTG | Area | Result | Evidence |
|---|---|---|---|
| INFO-02 | Fingerprint web server | **PARTIAL** | `x-powered-by: Next.js` present (F.6) |
| INFO-08 | Fingerprint framework | PARTIAL | as above |
| CONF-01 | Network infrastructure | PASS | AI plane loopback-bound; ufw DROP default; pg_hba subnet-scoped |
| CONF-02 | Application platform | PASS | routers guarded at construction, not per-handler |
| CONF-06 | HTTP methods | PASS | routes declare exact methods |
| CONF-07 | **HSTS** | **FAIL** | **D.2b** — runtime-confirmed absent |
| CONF-08 | RIA cross-domain policy | N/A | no crossdomain.xml |
| CONF-11 | Cloud storage | PASS | `getUrl()` never returned from a public fn; minted post-ownership only |
| IDNT-04 | **Account enumeration** | **PARTIAL** | content oracle closed; **timing oracle open — D.5** |
| IDNT-05 | Weak/unenforced username policy | PASS | `assertPasswordNotIdentity`, normalized email |
| ATHN-01 | Credentials over encrypted channel | PASS | TLS via Cloudflare |
| ATHN-02 | Default credentials | PASS | `OPENROUTER_API_KEY` never defaulted; script hard-fails |
| ATHN-03 | Lock-out mechanism | PASS | `signIn: { maxFailedAttempsPerHour: 5 }` per identifier, covers password **and** OTP/reset |
| ATHN-04 | Bypass authentication schema | PASS | no bypass found across 132 callables |
| ATHN-07 | Password reset | **PARTIAL** | rate limit absent (**D.8**, known); timing oracle (**D.5**) |
| ATHN-09 | Weak password policy | PASS | `assertPasswordRequirements` |
| ATHN-10 | Weaker auth in alt channel | **FAIL** | **D.7** — Convex-direct path bypasses every Next throttle |
| ATHZ-01 | Directory traversal | PASS | no filesystem path built from user input on a serving path |
| ATHZ-02 | **Bypass authorization schema** | **PASS** | 101/132 strong; the 24 bare-`getAuthUserId` all carry correct inline ownership checks |
| ATHZ-03 | Privilege escalation | **PARTIAL** | `acceptInvite` fail-open (**F.1**), not practically reachable |
| ATHZ-04 | IDOR | PASS | `normalizeId` + owner comparison; non-owner gets `"Not found"`, never an oracle |
| SESS-01 | Session management schema | PASS | single active session/account enforced in the sign-in transaction |
| SESS-02 | Cookie attributes | PASS | `SameSite=strict` observed at runtime |
| SESS-03 | Session fixation | PASS | session replaced on sign-in |
| SESS-06 | Session timeout | PASS | 2d inactivity / 30d absolute ceiling |
| SESS-07 | Session puzzling | PASS | no cross-purpose session reuse found |
| **SESS-08** | **Logout / revocation** | **PARTIAL** | password change revokes sessions **and refresh tokens**; but 24 callables miss account-status → **D.6** |
| INPV/07 (5.0 Injection) | SQL injection | **PASS** | pgvector fully parameterized; f-strings carry only `int()`-coerced type sizes and allowlisted GUCs |
| 5.0 §07 | NoSQL/ORM injection | PASS | Convex validators; ids via `normalizeId` |
| INPV-12 | Command injection | PASS | LibreOffice sandboxed via `unshare -rn` + `prlimit` |
| **CLNT-01** | **DOM/stored XSS** | **FAIL** | **D.1** — `/share/file` reflected content-type |
| CLNT-09 | Clickjacking | PASS (app) / **FAIL (Convex origin)** | `X-Frame-Options: SAMEORIGIN` on `:3000` only — **D.2a** |
| BUSL-01 | Business logic data validation | PARTIAL | `web.subscribe` passes email/userGroup through unvalidated (**D.4**) |
| BUSL-02 | Ability to forge requests | PASS | `userId` never from args; `streamId` capability-scoped |
| BUSL-03 | Integrity checks | PASS | `by_storage` uniqueness defeats claim-squatting |
| BUSL-05 | Process timing | **FAIL** | **D.5** |
| BUSL-06 | Function use limits | **PARTIAL** | only 5 quota kinds; `consumeWindow` is userId-keyed (**G.2**) |
| BUSL-07 | Defenses against misuse | PARTIAL | `authHits` keyspace pollution — **D.7** |
| BUSL-09 | Upload of malicious files | **PARTIAL** | blob guard at all 5 chokepoints, but the **row's** declared type is unvalidated → D.1 |
| 5.0 §12.2 | API — BOLA | PASS | no cross-tenant access found |
| 5.0 §12.3 | API — **Excessive data exposure** | **PARTIAL** | `getByToken` correct; `/api/verify-key` spreads `...found` (**F.4**) |
| 5.0 §12.4 | API — Broken function-level authz | PASS | see ATHZ-02 |
| 5.0 §12.99 | GraphQL | **N/A** | no GraphQL in this stack |
| CRYP-04 | Weak encryption | PASS | scrypt via library; HMAC-SHA256 webhooks; constant-time compares throughout |
| ERRH-01 | Error handling | PASS | `"Not found"` for every non-owner; reset failure swallowed deliberately |

---

## D. Confirmed vulnerabilities

### D.0 — Regression confirmations (closed, re-verified; **not** findings)

1. `app/ssrf.py` — comprehensive default-closed SSRF boundary (scheme, credentials, port, **resolved-IP** checks for loopback/private/link-local/CGNAT/multicast/reserved/metadata, v4 + v6 + IPv4-mapped), applied at the only outbound model-influenced site. Honest residual (DNS rebinding against Ollagraph) documented in-file rather than hidden. **The sweep I had recorded as "abandoned" was in fact completed.**
2. DuckDB sandbox — parser-based single-statement check (`extract_statements` + `StatementType.SELECT`, replacing a regex that `SELECT 1; …` defeated), `enable_external_access: False`, `lock_configuration: True`, 256MB/1-thread, 20s interrupt deadline.
3. pgvector — every value bound; `user_id = :uid` scoping; empty `file_ids` returns before touching SQL specifically to avoid a silent leak.
4. `blobSafety` — `isExecutableContentType` / `assertNonExecutableBlob` applied at **all five** registration chokepoints (chat attachments, `files`, `userFiles`, avatar, artifact ingestion). No chokepoint missed.
5. `changePassword` — rate-limited **before** the scrypt compare, revokes other sessions **including refresh tokens** (`revokeOtherSessions`, not the library's `invalidateSessions`), audited.
6. `accountExists` — moved `query` → `internalQuery`; enumeration oracle closed.
7. `/ai/ingress` — constant-time secret **plus** `streamId` capability scoping; a leaked secret alone cannot target a conversation.
8. `/mail/webhook` — Svix HMAC with a 5-minute replay window and constant-time comparison over every `v1,` entry.
9. `getByToken` — explicit projection; `storageId` stripped.
10. CSP `img-src` — closes the prompt-injection image-exfiltration channel; deliberately narrow so `connect-src` cannot break the Convex WebSocket.
11. `edge/proxy.js` — strips `x-middleware-subrequest` (CVE-2025-29927) on **both** request and upgrade paths.
12. Auth — single active session per account enforced inside the sign-in transaction; 5 failed attempts/hour per identifier covering password **and** OTP/reset.

---

### D.1 — HIGH · Stored XSS via client-controlled `Content-Type` on `GET /share/file`

> **STATUS: REMEDIATED** — fixed in `f324d3a`, deployed to production 2026-09-10.
> The new code is confirmed present in the deployed Convex module bundle on the
> VM. End-to-end behavioural verification against production is **PENDING** —
> see the note at the end of this finding.

**WSTG:** WSTG-CLNT-01 (4.2), WSTG-BUSL-09 (4.2), 5.0 §12.3
**Layer:** cross-layer (backend route + deployment topology)
**Confidence:** High — every link verified in source; origin and header absence verified at runtime.

**Location:** `packages/backend/convex/http.ts:1049-1074` (`GET /share/file`), with `chat/attachments.ts:206-217` (register) and `chat/shares.ts:60-78` (`snapAttachments`).

**The defect.** `/share/file` sets the response content-type from the **share snapshot**, which carries the **row's** `contentType` — a client-supplied value stored verbatim:

```ts
// chat/attachments.ts — the guard inspects the BLOB…
if (isExecutableContentType(meta?.contentType)) { throw … }   // meta = ctx.db.system.get(storageId)
// …but the ROW stores the CLIENT's declared value, unchecked:
contentType: args.contentType.slice(0, 128),
```

```ts
// chat/shares.ts — copied verbatim into the snapshot
out.push({ name: a.name, contentType: a.contentType, … });
```

```ts
// http.ts — and emitted as a response header, with no nosniff and no disposition
return new Response(blob, {
  headers: { "content-type": allowed.contentType, "cache-control": "private, max-age=300" },
});
```

**Why the existing control fails.** `blobSafety.ts` is explicit that the blob's own type is what `ctx.storage.getUrl()` serves, and neutralises accordingly — *"validating the row's `contentType` protects nothing; the blob's own type is the one that reaches the browser."* That reasoning is correct **for `getUrl()`**. `/share/file` is the one serving path that does **not** use `getUrl()`: it streams the blob itself and re-attaches the row's declared type on top of the neutralised blob. The remediation is therefore bypassed by the single route it did not consider. Its sibling `/artifact/file` **does** force `Content-Disposition: attachment` — the two routes are inconsistent, and that inconsistency is the bug.

**Attack path.**
1. Any authenticated member calls `chat.attachments.generateUploadUrl`.
2. POSTs HTML/JS bytes with header `Content-Type: text/plain` → blob stored as `text/plain`, so `isExecutableContentType(meta)` **passes**.
3. Calls `chat.attachments.register({ contentType: "text/html", … })` — `args.contentType` is never validated; row stores `text/html`.
4. Attaches it to a message and calls `chat.shares.create`.
5. Sends a victim `https://app.ollasuper.com/__cvx-site/share/file?t=<token>&m=<i>&a=<j>`.
6. The browser receives `Content-Type: text/html` with no `nosniff` and no `Content-Disposition`, and **executes**.

**Runtime evidence gathered (passive).**
```
$ curl -sSI "https://app.ollasuper.com/__cvx-site/share/file"
HTTP/1.1 404 Not Found
Content-Type: text/plain;charset=UTF-8
Server: cloudflare
# NO x-content-type-options, NO content-security-policy, NO x-frame-options
```
The route is reachable **on the app's own origin**, and the Convex site origin adds no protective headers of its own.

**Impact.** Script execution in `app.ollasuper.com`'s origin — the same origin as the application. The document is served with **no CSP of its own** (the Next.js CSP applies only to `:3000` responses), so the script is unrestricted: it can read the Convex auth token from browser storage and call any Convex function as the victim. Full account takeover of any logged-in user who opens the link. The share token bounds *who can be sent a working link*, but the attacker creates the share, so the attacker holds the token.

**Escalation found while remediating (worse than first written).** The original write-up assumed the attacker must send the victim a direct `/share/file` URL. That understates it. `share-attachment.tsx` renders an attachment as an inline `<img>` **only when `att.kind === "image"`**; every other attachment is rendered as:

```tsx
<a href={url} target="_blank" rel="noopener noreferrer"> … {att.name} …
```

— a **navigation**. So the victim does not need a crafted link at all: opening an ordinary-looking file chip inside a normally-shared conversation is the trigger. `kind` is itself derived from the same unvalidated `args.contentType`, so the attacker controls which branch renders. This raises likelihood substantially and is the reason the fix forces a download rather than merely relabelling the type.

**The codebase's own supporting measurement.** `blobSafety.ts` records: *"Measured on this deployment — a blob uploaded as `application/json` and registered as `text/plain` is served as `application/json`."* That confirms step 2 (the client chooses the blob's stored type) directly from in-repo measurement.

**Remediation shipped (`f324d3a`).** `/share/file` now always sets `x-content-type-options: nosniff`; serves an **allowlisted** image type inline (so the `<img>` path is unchanged); and serves everything else as `application/octet-stream` with `Content-Disposition: attachment` — the posture `/artifact/file` already took. `nosniff` was added to `/artifact/file` too, since neither route receives headers from `next.config.mjs`.

An **allowlist, not the existing denylist**, deliberately: against a caller-chosen value a denylist must be exhaustive to be correct, and `EXECUTABLE_TYPES` was not — `text/xml` carrying `<?xml-stylesheet type="text/xsl" href="…">` is transformed by the browser into same-origin HTML and no entry covered it. That case is now in the regression test.

**Regression test:** `packages/backend/convex/share.file.security.test.ts` — 16 cases asserting **response headers**, which no existing blob-safety test did (they all assert stored/returned *types*, which is precisely why this survived). Verified to be a real regression test rather than a tautology: **12 of the 16 fail against the pre-fix code**, including `expected 'image/svg+xml' to be 'application/octet-stream'`.

**Not fixed here (deliberate, and still open):** `register` still accepts an arbitrary `args.contentType`. The serving fix closes the vulnerability completely, and validating at `register` is a separate, larger change that risks rejecting legitimate existing flows. It remains P1.

**Verification status — stated precisely.**
- ✅ Unit/regression: 16/16 pass; 12/16 fail against the vulnerable code; full backend suite 888 passed / 56 files; typecheck and lint clean.
- ✅ Deployed: VM at `f324d3a`, `convex deploy` succeeded, and the new code is confirmed **inside the deployed module bundle** (`x-content-type-options`, `isInlineSafeImageType`, `image/avif` all present in the blob written at deploy time).
- ✅ Production smoke: app serves 200, both routes still 404 correctly on a bad token.
- ⏳ **PENDING — end-to-end behavioural proof on production.** `e2e/p-share-file-xss.js` runs the real attack (upload `text/plain`, register as `text/html`, share, fetch) and asserts it is neutralised, that a real PNG still renders inline, and that navigating to the payload in a real browser executes no script. It needs `ADMIN_PASSWORD`, which was not present in the audit environment. **Until that script passes, D.1 is fixed-and-deployed but not production-verified, and is not claimed as such.**

---

### D.2 — MEDIUM · The Convex origin serves no security headers, and production serves no HSTS

**WSTG:** WSTG-CONF-07 (4.2), WSTG-CLNT-09 (4.2)
**Layer:** config / architectural
**Confidence:** High — both runtime-confirmed.

**D.2a — Next.js security headers do not cover `/__cvx*`.** `apps/app/next.config.mjs` sets CSP / `nosniff` / `Referrer-Policy` / `X-Frame-Options` via `headers()`, which Next applies **only to responses Next serves**. `edge/proxy.js` routes `/__cvx`→`:3210` and `/__cvx-site`→`:3211` **before** host routing, so those responses never traverse Next. Confirmed at runtime: `/login` carries all four headers; `/__cvx-site/share/file` carries **none**. Because all three share one browser origin, an attacker-influenced response on the Convex origin is unprotected *and* same-origin with the app — this is the enabling condition for D.1, and it stands independently for every current and future Convex HTTP route.

**D.2b — No HSTS.** Confirmed at runtime on `https://app.ollasuper.com/login`: no `Strict-Transport-Security`. Cloudflare fronts the deployment (`Server: cloudflare`) and is not supplying one either. Without HSTS, a first-visit or coffee-shop downgrade permits session-cookie interception.

**Remediation:** set HSTS at the Cloudflare edge (covers every hostname and both origins at once, and is the only place that can cover `/__cvx*` without touching Convex). Add `nosniff` explicitly on Convex HTTP responses that stream user-influenced bytes.

---

### D.3 — MEDIUM · Unauthenticated confused deputy: anonymous callers spend `AI_SERVICE_KEY`

**WSTG:** WSTG-ATHZ-02 (4.2), 5.0 §12.4
**Layer:** backend
**Confidence:** High.

`chat/capabilities.ts:list` and `skillCapabilities.ts:list` are public `action`s with **no auth, no gate, no rate limit**. Both read `AI_SERVICE_KEY` from the environment and call the Python plane with it:

```ts
export const list = action({
  args: {},
  handler: async (): Promise<string[] | null> => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    …
    headers: { "x-service-key": key },
```

The Python side is correctly guarded — but the guard is satisfied by *Convex's* credential, on behalf of an anonymous internet caller. That is the confused-deputy shape.

**Honest severity calibration.** I initially ranked this highest and then downgraded it on evidence. Both Python handlers are **pure and cheap** — `capability_catalog(settings)` and `user_capability_catalog(settings)` read in-memory flags, with *no model call and no I/O*. So this does **not** leak the key and does **not** trigger expensive work. What it actually yields:
- **Information disclosure** — the deployment's enabled capability set (`seo`, `blog`, `research`, `finance`, `hr`, `sales`, `marketing`, `operations`, `documents`, …) to any anonymous caller. Competitive/recon value, not credentials.
- **Unbounded cost** — each call is a Convex **`"use node"` action** (the most expensive Convex runtime) plus an outbound HTTP, invocable by anyone, without limit.

**Remediation:** require `requireUserId` on both. Neither has an anonymous use case — the Explore menu and the custom-skill form are both authenticated surfaces.

---

### D.4 — MEDIUM · `web.subscribe`: unauthenticated third-party outbound POST, no validation, no rate limit

**WSTG:** WSTG-BUSL-01 (4.2), WSTG-BUSL-06 (4.2)
**Layer:** backend
**Confidence:** High on the code; severity contingent on one runtime fact.

```ts
export const subscribe = action({
  args: { email: v.string(), userGroup: v.string() },
  handler: async (ctx, args) => {
    const res = await fetch(`https://app.loops.so/api/newsletter-form/${env.LOOPS_FORM_ID}`, {
      method: "POST", …
      body: JSON.stringify({ email: args.email, userGroup: args.userGroup }),
    });
    return await res.json();   // provider response returned verbatim to the caller
```

Anonymous, unlimited, `email` unvalidated (`v.string()`, no format check), `userGroup` attacker-chosen, and the **provider's raw response is returned to the caller**. An attacker can drive OllaSuper's Loops form to sign arbitrary third-party addresses up to the newsletter (mail abuse attributed to OllaSuper's domain reputation), pollute `userGroup` segmentation, and use the returned provider JSON as an oracle.

**Honesty guard:** the finding is **missing validation and rate-limiting**, *not* "missing authentication" — a newsletter form is meant to be anonymous. Inflating it would be exactly the failure mode this audit was told to avoid.

**Runtime evidence required:** `LOOPS_FORM_ID` is **optional** in `convex/env.ts`. If unset on production, the URL degrades to `…/newsletter-form/undefined` and the impact collapses to a wasted outbound request. Confirm with `npx convex env get LOOPS_FORM_ID` against the self-hosted deployment. **Severity is Medium if set, Low if not.**

---

### D.5 — MEDIUM · Account enumeration via response timing in `requestPasswordReset`

**WSTG:** WSTG-IDNT-04 (4.2), WSTG-ATHN-07 (4.2), WSTG-BUSL-05 (4.2)
**Layer:** backend
**Confidence:** High on the asymmetry (code-proven); exploitability needs measurement.

The function goes to real trouble to make the *content* identical for known and unknown addresses — and succeeds. But the two branches do **grossly asymmetric work**:

```ts
const exists = await ctx.runQuery(internal.authSessions.accountExists, { email });
if (exists) {
  try { await ctx.runAction(api.auth.signIn, { provider: "password", params: { email, flow: "reset" } }); }
  catch { /* swallowed deliberately */ }
}
return { ok: true };
```

- **Unknown address:** one indexed query, then return.
- **Known address:** the same query **plus** a full `signIn` action **plus** OTP generation **plus** an outbound SMTP send.

There is no artificial delay, no jitter, and no deferral of the send. The response-time difference is the oracle the content-symmetry work was meant to eliminate. This is a **new** finding, distinct from the known rate-limit gap (D.8) — and note that D.8 makes it *cheap to sample*, since an attacker can issue unlimited probes.

**Runtime evidence required:** measure P50/P95 wall-clock for a known-good versus known-absent address over ≥50 samples each. I did not gather this: it sends real mail on a metered tier and writes reset state to production. If the distributions do not separate, the finding downgrades to Low.

**Remediation:** dispatch the mail via the scheduler (`ctx.scheduler.runAfter(0, …)`) so both branches return on the same path, and add the D.8 rate limit.

---

### D.6 — LOW · 24 public callables skip the account-status check, so a suspended user retains access

**WSTG:** WSTG-SESS-08 (4.2), WSTG-ATHZ-02 (4.2)
**Layer:** backend
**Confidence:** High.

`requireUserId` / `getUserIdOrNull` both call `isActive(ctx, userId)`; **bare `getAuthUserId` does not** — and `getAuthUserId` is, per CLAUDE.md, *"a bare cast on the JWT `sub` with no DB lookup."* 24 public callables use the bare form:

`apiKeys.create` · `authPassword.changePassword` · `authSessions.heartbeat` · `backend.callBackend` · `chat/artifacts.{mintDownload,previewUrls}` · `notifications.{myNotifications,unreadCount,markRead,markAllRead}` · `orgs.{createWorkspace,ensureWorkspace,myWorkspaces,myInvites,acceptInvite}` · `seoMutations.{listMyMutations,getMutation}` · `users.{getUser,generateUploadUrl,updateUserImage,removeUserImage,deletionFactor,requestAccountDeletionCode,deleteCurrentUserAccount}`

**Deliberately not overstated.** These are **not** BOLA. Every one I inspected carries a correct inline ownership check — e.g. `chat/artifacts.mintDownload` does `if (!art || art.userId !== userId) throw new ConvexError("Not found")`, and `previewUrls` mints `getUrl()` strictly *after* the owner comparison. The gap is narrowly **account status**, nothing more.

**Impact and its bound.** Suspension calls `revokeOtherSessions(ctx, userId, null)`, which kills all sessions and refresh tokens immediately — so the residual is only the **unexpired access token**, which cannot be refreshed. During that window a suspended user can still mint upload URLs, mint artifact download tokens, create workspaces and API keys, and delete their account. The ~101 callables using the strong helpers cut them off instantly.

**Runtime evidence required** to state the window precisely: the access-token JWT lifetime. `auth.ts` sets `inactiveDurationMs` (2d) and `totalDurationMs` (30d) — these are **session** durations, not the JWT lifetime, and no `jwtDurationMs` override is present, so the Convex Auth default applies. Confirm by decoding the `exp` claim of a live token.

**Remediation:** replace bare `getAuthUserId` with `requireUserId` in all 24. This is mechanical and behaviour-preserving for active users.

---

### D.7 — LOW/MEDIUM · Shared rate-limit Map lets a spoofable key flood reset the trusted counters

**WSTG:** WSTG-ATHN-10 (4.2), WSTG-BUSL-07 (4.2)
**Layer:** frontend/middleware
**Confidence:** High on the mechanism; low-to-moderate on marginal impact.

`apps/app/src/middleware.ts` has **one** `authHits` Map serving **two throttles with different key trust levels**:

```ts
const authHits = new Map<string, { start: number; count: number }>();
function authRateLimited(ip: string, max = AUTH_MAX): boolean {
  …
  if (!e || now - e.start >= AUTH_WINDOW_MS) {
    if (authHits.size > 5000) authHits.clear();     // ← wipes BOTH keyspaces
```

- `/login` page loads → keyed on `x-forwarded-for`, which the file itself calls *"client-supplied and spoofable."*
- `/api/auth` POSTs → keyed on `trustedIp()` = `cf-connecting-ip`, which Cloudflare sets and strips.

An attacker rotating `X-Forwarded-For` across 5,001 GET `/login` requests inserts 5,001 distinct keys, trips `authHits.clear()`, and thereby **wipes the trusted `cf-connecting-ip` counters for every IP**, including their own `/api/auth` bucket. The `AUTH_API_MAX = 60`/min limit becomes unbounded at will.

**Honest marginal impact — deliberately not inflated.** Two facts limit this materially, and both are already documented in the file itself:
1. `NEXT_PUBLIC_CONVEX_URL` is public, so an attacker can call `auth:signIn` **directly on Convex** and never touch Next at all. A simpler bypass already exists and is a known open item.
2. Convex Auth enforces `maxFailedAttempsPerHour: 5` **per identifier**, covering password and OTP/reset. Credential *stuffing* against one account is still bounded.

What remains genuinely enabled is **password spraying** — one attempt each across many identifiers — which the per-identifier limit does not constrain and the per-IP limit was the only control against. The same `.clear()` pattern exists in `shareHits`, and both `/login` and `/share` throttles use the spoofable key while the correct primitive (`trustedIp`) already exists in the file.

**Remediation:** use `trustedIp()` for all three throttles, and give each throttle its own Map (or evict LRU rather than clearing wholesale).

---

### D.8 — Already-known open · `requestPasswordReset` has no rate limit

Labelled as **already known**, not a new discovery — it was open before this audit and is recorded as such. Re-confirmed unchanged: `authSessions.ts:125-144` calls no `consumeWindow`, and `consumeWindow` could not cover it anyway (see G.2 — it requires a `userId`).

**One escalation this audit adds:** the impact is not merely "spam." Outbound mail runs on a metered tier (~1500/month). An attacker with a single valid address can drain the monthly quota, and the *same* transport delivers OTP, email-verification and reset codes. Quota exhaustion is therefore a **denial of service against authentication itself**, not just nuisance mail. It also makes D.5's timing oracle cheap to sample.

---

## E. Potential issues — need runtime validation

Stated as unproven, with the exact evidence required. None of these is presented as confirmed.

| # | Issue | Evidence required |
|---|---|---|
| E.1 | `web.subscribe` real impact (D.4) | `convex env get LOOPS_FORM_ID` on the self-hosted deployment. Set → Medium; unset → Low. |
| E.2 | `requestPasswordReset` timing separation (D.5) | P50/P95 over ≥50 samples per branch, known vs absent address. Requires sending real mail. |
| E.3 | Suspended-user residual window (D.6) | Decode `exp` on a live access token to get the JWT lifetime. |
| E.4 | D.1 end-to-end execution | Upload `text/plain` bytes containing `<script>`, register as `text/html`, share, fetch `/share/file`, confirm header + execution. Requires writing production data. |
| E.5 | Whether Cloudflare supplies HSTS on other paths | `curl -I` across several paths/hostnames; check the zone's SSL/TLS → Edge Certificates → HSTS setting. |

---

## F. Hardening gaps (not vulnerabilities)

**F.1 — `acceptInvite` fail-open binding check.** `orgs.ts:305`:
```ts
if (inv.email && u?.email && inv.email.toLowerCase() !== u.email.toLowerCase()) throw …
```
If **either** side is falsy the identity check is skipped entirely. `users.email` is `v.optional(v.string())` (a user row *can* lack it) and `invites.email` is `v.string()` but `""` is permitted and unvalidated at `orgs.invite`. **Downgraded to hardening after checking preconditions:** the anonymous provider is *not* enabled (`providers: [PasswordWithFlows, ResendOTP, GoogleVerified]` — all three set an email), and an attacker would additionally need to know an opaque `inviteId`. No practical exploitation path was demonstrated, so it is reported as defensive-coding weakness, not a confirmed privilege escalation. Fix: require both values, and reject `""` at creation.

**F.2 — No rate limit on expensive authenticated paths.** `generateUploadUrl` (×3), `userFiles.saveFile`, `chat.shares.create`, `apiKeys.create`, `orgs.createWorkspace`, `chat.artifacts.mintDownload` carry no `consumeWindow`. A single authenticated user can mint unlimited upload URLs and store unlimited 20MB blobs — storage exhaustion with no quota.

**F.3 — `authHits`/`shareHits` clear-on-overflow.** Even keyed correctly, `.clear()` at 5,000 entries is a global reset. Prefer LRU eviction.

**F.4 — `/api/verify-key` spreads the whole record and is unbounded.** `json({ valid: !!found, ...found }, …)` returns every field of the resolved API-key row to anyone presenting a key, and the route has no rate limit — a clean, unthrottled verification oracle. Brute force is infeasible against a long random key, so this is hardening, not a vulnerability. Fix: project explicit fields; add a limit.

**F.5 — `chat/models.list` is anonymous.** Returns the curated catalogue (model ids, names, descriptions, measured context lengths) to unauthenticated callers. Low value to an attacker; still unnecessary exposure.

**F.6 — `x-powered-by: Next.js`.** Runtime-confirmed. WSTG-INFO-02. Set `poweredByHeader: false`.

---

## G. Root-cause clusters

**G.1 — Authorization is applied per-function, not by construction.** The Python plane got this right: `APIRouter(prefix="/v1", dependencies=[Depends(require_service_key)])` makes a route guarded *by existing*, so a new endpoint cannot be born unguarded. Convex has no equivalent, so each of 132 callables re-decides — and 7 decided "nothing." Note the contrast *within* Convex: `chat/stream.ts` (2 public / 3 checks), `scheduled/parse.ts` (1 / 4) and `userFiles.ts` (5 / 10) apply the convention correctly. **This is inconsistent application of an existing convention, not a missing one** — which is why D.3 and D.6 are clusters, not unrelated bugs.

**G.2 — The only rate-limit primitive structurally cannot cover unauthenticated paths.** `consumeWindow(ctx, userId, kind, limit, windowMs)` is keyed on `userId` and requires a `MutationCtx`. Therefore **no unauthenticated callable can ever be rate-limited by it** — not `requestPasswordReset`, not `web.subscribe`, not the two capability proxies. Coverage today is 5 quota kinds (`passwordChange`, chat generation, scheduled occurrences, `parse`, `accountDelete`) against 132 callables. The per-IP throttles that *could* cover anonymous traffic live in Next middleware, which `/__cvx*` bypasses by design. **The result is a structural hole: anonymous Convex traffic is rate-limited by nothing, anywhere.** Only a Cloudflare rule spanning `/__cvx` and `/api/auth` can close it — which the middleware's own comments already identify.

**G.3 — Origin unification without header unification.** Three servers share one browser origin; only one is behind Next.js, and only Next.js sets security headers. Every protection in `next.config.mjs` silently stops at the `/__cvx*` boundary. D.1 exists because a *response header* — not a body — carried the untrusted value, and the prior blob remediation reasoned about bodies and `getUrl()`.

---

## H. Missing test coverage

The existing suite is strong (17 Convex security test files, 7 Python, 17 adversarial e2e scripts). The gaps are the shapes it does not have:

1. **No test asserts response *headers*.** Every blob-safety test asserts stored/returned *types*; none asserts what `/share/file` puts in `Content-Type`, or that `nosniff` is present. D.1 lives exactly in that blind spot.
2. **No auth-posture invariant test.** Nothing fails CI when a new public callable ships with no auth helper. A test enumerating `api` and asserting every public callable is either on an explicit anonymous allowlist or calls a known helper would have caught D.3 at authorship — and would keep catching it.
3. **No account-status test on the bare-`getAuthUserId` paths.** No test suspends a user and asserts each of the 24 callables refuses.
4. **No rate-limit coverage test.** Nothing asserts which callables carry `consumeWindow`; drift is invisible.
5. **No timing-oracle test.** D.5 is invisible to assertions that only compare response bodies.
6. **No cross-keyspace test for the middleware throttles** (D.7), and no frontend component-test infrastructure at all.

---

## I. Remediation plan

**P0 — do first**
1. **D.1** — add `nosniff` + allowlist-or-`Content-Disposition: attachment` to `/share/file`, mirroring `/artifact/file`. Smallest safe fix; no schema change, no deploy-order implication (Convex-only).
2. **D.2b** — enable HSTS at the Cloudflare edge (covers both origins at once).

**P1**
3. **D.3** — add `requireUserId` to `chat/capabilities.list` and `skillCapabilities.list`.
4. **D.8 + D.5** — rate-limit `requestPasswordReset` (needs an identifier-keyed limiter, since `consumeWindow` cannot serve it) and move the mail send to the scheduler so both branches return identically.
5. **D.4** — validate `email`, constrain `userGroup`, stop returning the provider's raw response, add a limit.
6. **D.2a** — set explicit security headers on Convex HTTP responses that stream user-influenced bytes.

**P2**
7. **D.6** — mechanical swap of bare `getAuthUserId` → `requireUserId` across the 24.
8. **D.7** — `trustedIp()` for all three throttles; separate Maps; LRU eviction.
9. **F.2** — `consumeWindow` on the expensive authenticated paths.
10. **H.2** — the auth-posture invariant test, so G.1 stops recurring.

**P3**
11. F.1, F.4, F.5, F.6.
12. A Cloudflare rate-limiting rule spanning `/__cvx` and `/api/auth` — the only control that can close G.2.

**Deploy-order note:** none of P0–P2 adds a field to `dispatchPayload`, so the Python→Convex→frontend ordering constraint does not bind here. P0.1 is Convex-only.

---

## J. Final risk assessment

**Overall posture: good, with one urgent defect.**

The evidence does not support a narrative of systemic weakness, and this report will not manufacture one. Authorization is correct on all 132 public callables — no BOLA, no cross-tenant read, no privilege escalation with a demonstrated path. The controls that are present are unusually well-built: constant-time comparisons everywhere secrets are checked, capability scoping layered *on top of* secret checks, a default-closed SSRF boundary that documents its own residual, a DuckDB sandbox hardened at the connection rather than by keyword regex, and rate-limiting placed *before* the expensive scrypt comparison rather than after. Several in-code comments record a previous wrong answer and why it was replaced — which is why the prior remediations held up under re-verification.

**The one urgent item is D.1.** It matters not because the code is careless but because it sits precisely where a careful remediation's reasoning stopped: the blob-execution work correctly concluded that the *blob's* type is what reaches the browser, and one route violates that premise by re-attaching the row's declared type. The result is same-origin script execution against any logged-in user. It should be fixed before anything else in this report.

**The two structural items — G.2 and G.3 — deserve attention as architecture, not as bugs.** Anonymous Convex traffic is rate-limited by nothing, anywhere, and no application-level change can fix that; it requires an edge rule. And every security header the application sets stops at the `/__cvx*` boundary while the browser treats both as one origin. Both will keep generating findings until they are addressed at the layer where they are actually solvable.

**Residual risk after P0+P1: low.** After P2, the auth-posture invariant test (H.2) is what prevents G.1 from re-accumulating — of everything in this report, that test has the highest long-term value per line of code.

**Audit limitations, stated plainly.** This was static analysis plus passive runtime header reads. I did not execute exploits, write production data, or send mail. Five findings (E.1–E.5) therefore carry named runtime evidence requirements rather than confirmation, and I have not represented any of them as proven. Five candidates were eliminated as false positives during triage (`users.updateName`, `users.updateUsername`, `scheduled/parse.parse`, and two proxy-layer misreadings including an initially-inverted reading of `edge/proxy.js:54`, which on closer reading *defends* against CVE-2025-29927 rather than enabling a bypass).
