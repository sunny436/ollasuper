// D.1 — /share/file must never hand a browser something it will EXECUTE.
//
// This RUNS THE ATTACK against production and asserts it is now blocked, then
// asserts the legitimate image path still works. Both halves matter: a fix that
// closes the hole by breaking inline images is not a fix.
//
// THE ATTACK (all of it is a real, authenticated user doing ordinary API calls):
//   1. generateUploadUrl, then upload HTML bytes declared `text/plain` — which
//      is what satisfies the register()-time guard, because that guard inspects
//      the BLOB's stored type, not the row's.
//   2. register({ contentType: "text/html" }) — `args.contentType` is never
//      validated, so the ROW now claims text/html over a text/plain blob.
//   3. Attach to a message, share the thread.
//   4. GET /share/file. Before the fix this answered `Content-Type: text/html`
//      with no nosniff and no disposition, on app.ollasuper.com's OWN origin —
//      same-origin script execution against anyone who opened the file chip.
//
// Usage (the password never enters a file or the terminal history if you set it
// in the environment first):
//   $env:ADMIN_PASSWORD = "..."      # PowerShell
//   node e2e/p-share-file-xss.js
//   HEADED=1 node e2e/p-share-file-xss.js   # watch it
const { chromium } = require("playwright");
const { adminEmail, adminPassword } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CVX = process.env.E2E_CONVEX_URL || `${BASE}/__cvx`;
const SITE = process.env.E2E_CONVEX_SITE_URL || `${BASE}/__cvx-site`;

const out = [];
const rec = (ok, what, extra = "") => {
  out.push([ok, what, extra]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -- ${extra}` : ""}`);
};

/** Convex HTTP API. Same functions the browser calls, same token. */
async function cvx(kind, path, args, token) {
  const res = await fetch(`${CVX}/api/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await res.json();
  if (body.status !== "success") {
    throw new Error(`${path} failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.value;
}

(async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    slowMo: process.env.HEADED === "1" ? 60 : 0,
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();

  // ---- sign in as a real user, in a real browser -------------------------
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(adminEmail());
  await page.locator('input[type="password"]').first().fill(adminPassword());
  await page.click('button[type="submit"]');
  await page.waitForTimeout(8000);

  // The access token the browser itself is using.
  const token = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /JWT/i.test(k)) {
        const v = localStorage.getItem(k);
        if (v && v.split(".").length === 3) return v;
      }
    }
    return null;
  });
  rec(!!token, "signed in and hold a session token");
  if (!token) {
    await browser.close();
    process.exit(1);
  }

  const workspaces = await cvx("query", "orgs:myWorkspaces", {}, token);
  const workspaceId = workspaces?.[0]?._id ?? workspaces?.[0]?.workspaceId;
  rec(!!workspaceId, "resolved a workspace", String(workspaceId));

  const threadId = await cvx(
    "mutation",
    "chat/threads:create",
    { workspaceId, title: "SEC D.1 verification" },
    token,
  );

  /** Upload bytes under `blobType`, then register the row as `declared`. */
  async function makeAttachment(bytes, blobType, declared, name) {
    const url = await cvx(
      "mutation",
      "chat/attachments:generateUploadUrl",
      { workspaceId },
      token,
    );
    const up = await fetch(url, {
      method: "POST",
      headers: { "content-type": blobType },
      body: bytes,
    });
    const { storageId } = await up.json();
    return cvx(
      "mutation",
      "chat/attachments:register",
      {
        workspaceId,
        storageId,
        name,
        size: bytes.length,
        contentType: declared, // <-- unvalidated; this is the attack
        threadId,
      },
      token,
    );
  }

  const PAYLOAD = "<script>window.__XSS_FIRED__=document.domain</script>";
  const evil = await makeAttachment(
    PAYLOAD,
    "text/plain", // satisfies the blob guard
    "text/html", // what the row will claim
    "harmless-notes.txt",
  );
  rec(!!evil, "registered a blob declared text/html over a text/plain blob");

  // A 1x1 PNG, declared honestly — the regression half.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const good = await makeAttachment(png, "image/png", "image/png", "pixel.png");
  rec(!!good, "registered a legitimate png");

  const sent = await cvx(
    "mutation",
    "chat/messages:send",
    {
      threadId,
      content: "security verification — please ignore",
      clientId: `sec-d1-${token.slice(-12)}`,
      attachmentIds: [evil, good],
    },
    token,
  );
  // Do not leave a generation running or pay for one. stop() takes the
  // ASSISTANT message id, which send() hands back.
  if (sent?.assistantMessageId) {
    await cvx(
      "mutation",
      "chat/stream:stop",
      { messageId: sent.assistantMessageId },
      token,
    ).catch(() => {});
  }
  await page.waitForTimeout(2500);

  const share = await cvx(
    "mutation",
    "chat/shares:create",
    { shareType: "full_chat", threadId, forceNew: true },
    token,
  );
  const shareToken = share?.token ?? share;
  rec(!!shareToken, "created a share link");

  // Which snapshot slot each attachment landed in.
  const view = await cvx("query", "chat/shares:getByToken", { token: shareToken }, token);
  let mi = -1;
  let evilIdx = -1;
  let goodIdx = -1;
  (view?.share?.messages ?? []).forEach((m, i) => {
    (m.attachments ?? []).forEach((a, j) => {
      if (a.name === "harmless-notes.txt") {
        mi = i;
        evilIdx = j;
      }
      if (a.name === "pixel.png") {
        mi = i;
        goodIdx = j;
      }
    });
  });
  rec(evilIdx >= 0 && goodIdx >= 0, "both attachments are in the shared snapshot");

  const hdrs = async (m, a) => {
    const r = await fetch(`${SITE}/share/file?t=${shareToken}&m=${m}&a=${a}`);
    return {
      status: r.status,
      ct: r.headers.get("content-type") ?? "",
      cd: r.headers.get("content-disposition") ?? "",
      nosniff: r.headers.get("x-content-type-options") ?? "",
      body: await r.text(),
    };
  };

  // ---- THE ASSERTIONS ----------------------------------------------------
  const bad = await hdrs(mi, evilIdx);
  rec(bad.status === 200, "the malicious attachment is still served", `status=${bad.status}`);
  rec(!/text\/html/i.test(bad.ct), "it is NOT served as text/html", `ct=${bad.ct}`);
  rec(bad.ct.startsWith("application/octet-stream"), "it is neutralised", `ct=${bad.ct}`);
  rec(/^attachment;/.test(bad.cd), "it is forced to download", `cd=${bad.cd}`);
  rec(bad.nosniff === "nosniff", "nosniff is set", `x-content-type-options=${bad.nosniff}`);
  rec(bad.body === PAYLOAD, "the bytes are intact — neutralised, not censored");

  const okImg = await hdrs(mi, goodIdx);
  rec(okImg.ct === "image/png", "a real png KEEPS its type", `ct=${okImg.ct}`);
  rec(okImg.cd === "", "a real png is NOT forced to download — inline still works");
  rec(okImg.nosniff === "nosniff", "nosniff is set on the image too");

  // ---- and prove it in a REAL browser ------------------------------------
  const victim = await ctx.newPage();
  let fired = null;
  await victim.goto(`${SITE}/share/file?t=${shareToken}&m=${mi}&a=${evilIdx}`, {
    waitUntil: "domcontentloaded",
  }).catch(() => {});
  await victim.waitForTimeout(1500);
  fired = await victim
    .evaluate(() => window.__XSS_FIRED__ ?? null)
    .catch(() => null);
  rec(fired === null, "navigating to it executes NO script", `__XSS_FIRED__=${fired}`);

  // ---- cleanup: revoke the share we just published -----------------------
  // revoke() takes the ROW id, not the token — look it up through listMine,
  // which is the only surface that returns both.
  const mine = await cvx(
    "query",
    "chat/shares:listMine",
    { workspaceId, paginationOpts: { numItems: 50, cursor: null } },
    token,
  );
  const row = (mine?.page ?? []).find((s) => s.token === shareToken);
  if (row?._id) {
    await cvx("mutation", "chat/shares:revoke", { shareId: row._id }, token).catch(
      () => {},
    );
  }
  const after = await fetch(`${SITE}/share/file?t=${shareToken}&m=${mi}&a=${evilIdx}`);
  rec(after.status === 404, "the share was revoked and now 404s", `status=${after.status}`);

  const passed = out.filter(([o]) => o).length;
  console.log(`\nRESULT ${passed}/${out.length}`);
  for (const [o, w, e] of out) if (!o) console.log(`  FAILED: ${w}${e ? ` -- ${e}` : ""}`);
  console.log(`\nTest thread left behind: ${threadId} (delete from the UI if you like)`);
  await browser.close();
  process.exit(passed === out.length ? 0 : 1);
})().catch((e) => {
  console.error("\nSCRIPT ERROR:", e.message);
  process.exit(1);
});
