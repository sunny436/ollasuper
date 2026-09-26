// Production acceptance for the SECURITY-AUDIT-FINAL findings the first prod
// pass (qa-security-remediation.js) did not reach: F-01 avatar upload, F-04
// spreadsheet limits, F-11 invitations, F-08 removed-member access, F-13 file
// deletion mid-ingest, F-03 private data -> web egress approval, and F-12
// account deletion.
//
// Two real accounts, both through the product's own authorized API/UI:
//   A = the QA account (owner of its workspace; only invites/removes B).
//   B = a THROWAWAY signed up here through the real UI + the e2e inbox, and
//       deleted at the end through Settings -> Delete Account. Everything
//       destructive happens to B's own synthetic data.
//
//   QA_EMAIL=… QA_PASSWORD=… OLLASTACK_MAIL_TOKEN=… OLLASTACK_E2E_MAILBOX_ID=… \
//   XLSX_DIR=<dir holding bomb.xlsx + ok.xlsx> OUT=<ids.json> node qa-security-remaining.js
//
// bomb.xlsx: openpyxl, cells A1 + XFD1000 (~16M logical cells, <5 KB on disk).
// ok.xlsx:   a 3-row table. OUT receives B's ids for the read-only VM checks
// (no secrets: B's password is generated here and never printed or written).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = `${BASE}/__cvx`;
const SITE = `${BASE}/__cvx-site`;
const XLSX_DIR = process.env.XLSX_DIR;
const OUT = process.env.OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const results = [];
const consoleErrors = [];
// ONLY=F-03,F-04 re-runs just those checks; sign-up, deletion and the console
// gate always run, so a partial run still leaves nothing behind.
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);

async function step(name, fn) {
  if (ONLY.length && !/^(B:|F-12|zero)/.test(name) && !ONLY.some((k) => name.startsWith(k))) {
    console.log(`SKIP  ${name}`);
    return;
  }
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} — ${String(e.message || e).slice(0, 400)}`);
  }
}

async function call(kind, jwt, fn, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") {
    const msg = j.errorData ? JSON.stringify(j.errorData) : j.errorMessage || String(r.status);
    throw new Error(`${fn}: ${msg}`);
  }
  return j.value;
}

async function expectRejected(promise, re) {
  try {
    await promise;
  } catch (e) {
    if (re.test(e.message)) return e.message.replace(/^[^:]*: /, "");
    throw new Error(`rejected with the wrong error: ${e.message}`);
  }
  throw new Error("was ALLOWED");
}

async function verifyKey(key) {
  const r = await fetch(`${SITE}/api/verify-key`, { method: "POST", headers: { "x-api-key": key } });
  return (await r.json()).valid === true;
}

async function jwtOf(ctx) {
  const c = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name));
  if (!c) throw new Error("no auth cookie");
  return c.value;
}

async function uploadKnowledge(jwt, workspaceId, name, contentType, bytes) {
  const url = await call("mutation", jwt, "userFiles:generateUploadUrl", { workspaceId });
  const up = await fetch(url, { method: "POST", headers: { "content-type": contentType }, body: bytes });
  const { storageId } = await up.json();
  return call("mutation", jwt, "userFiles:saveFile", {
    workspaceId,
    storageId,
    name,
    size: bytes.length,
    contentType,
    contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}

async function fileRows(jwt, workspaceId) {
  const res = await call("query", jwt, "userFiles:list", {
    workspaceId,
    paginationOpts: { numItems: 50, cursor: null },
  });
  return res.page;
}

async function waitFiles(jwt, workspaceId, names, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await fileRows(jwt, workspaceId)).filter((f) => names.includes(f.name));
    const done = rows.filter((f) => f.status === "ready" || f.status === "failed");
    if (done.length === names.length) return rows;
    if (Date.now() > deadline) {
      throw new Error(`not terminal: ${rows.map((f) => `${f.name}=${f.status}`).join(", ")}`);
    }
    await sleep(2000);
  }
}

async function waitForForm(page) {
  await page.waitForFunction(
    () => {
      const f = document.querySelector("form");
      return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
    },
    null,
    { timeout: 30000 },
  );
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await waitForForm(page);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.keyboard.press("Enter");
}

async function sendChat(page, text, files) {
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  if (files) {
    await page.locator('input[type="file"]').first().setInputFiles(files);
    await sleep(5000);
    if (await page.getByText(/Couldn't upload/i).count()) throw new Error("attachment upload failed");
  }
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/, { timeout: 30000 });
}

(async () => {
  if (!XLSX_DIR || !OUT) throw new Error("XLSX_DIR and OUT are required");
  if (!ollastack.enabled()) throw new Error("OLLASTACK_MAIL_TOKEN / OLLASTACK_E2E_MAILBOX_ID not set");
  const A = account();
  const signInA = await fetch(`${CONVEX}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "auth:signIn",
      args: { provider: "password", params: { email: A.email, password: A.password, flow: "signIn" } },
      format: "json",
    }),
  }).then((r) => r.json());
  const jwtA = signInA.value?.tokens?.token;
  if (!jwtA) throw new Error("QA account sign-in failed");
  const wsA = (await call("query", jwtA, "orgs:myWorkspaces", {})).find((w) =>
    ["owner", "admin"].includes(w.role),
  );
  if (!wsA) throw new Error("QA account administers no workspace");
  const membersBefore = (await call("query", jwtA, "orgs:members", { workspaceId: wsA._id })).length;

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  const B = {};
  const J = () => jwtOf(ctx);

  await step("B: throwaway signs up through the real UI + inbox", async () => {
    const tag = ollastack.newTag();
    B.email = ollastack.taggedAddress(await ollastack.mailboxAddress(), tag);
    B.password = `Qa${crypto.randomBytes(12).toString("base64url")}!7z`;
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await waitForForm(page);
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "QA Security Throwaway");
    await page.fill('input[type="email"]', B.email);
    await page.fill('input[type="password"]', B.password);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    const code = await ollastack.codeFromOllastack(tag, "email verification", 120000);
    if (!code) throw new Error("no verification code arrived");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    B.userId = (await call("query", await J(), "users:getUser", {}))._id;
    B.ws = (await call("query", await J(), "orgs:myWorkspaces", {}))[0]._id;
    return B.email;
  });
  if (!B.userId) {
    await browser.close();
    process.exit(1);
  }

  // ---------------------------------------------------------------- F-01
  await step("F-01 avatar: upload in Settings registers, blob served inert", async () => {
    await page.goto(`${BASE}/en/settings`, { waitUntil: "domcontentloaded" });
    await page.locator("#avatar_field").waitFor({ state: "attached", timeout: 30000 });
    await page.locator("#avatar_field").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG_1PX });
    const deadline = Date.now() + 30000;
    while (!B.avatarUrl && Date.now() < deadline) {
      await sleep(1000);
      B.avatarUrl = (await call("query", await J(), "users:getUser", {})).avatarUrl;
    }
    if (!B.avatarUrl) throw new Error("avatar never registered");
    await page.locator('img[src*="/api/storage/"]').first().waitFor({ timeout: 20000 });
    const r = await fetch(B.avatarUrl);
    const h = r.headers;
    if (r.status !== 200 || h.get("x-content-type-options") !== "nosniff") {
      throw new Error(`avatar fetch ${r.status} nosniff=${h.get("x-content-type-options")}`);
    }
    return `rendered; ${h.get("content-type")} ${h.get("content-disposition") || "inline"}`;
  });

  // ---------------------------------------------------------------- F-04
  await step("F-04 spreadsheet: a sparse bomb is refused, an ordinary workbook ingests", async () => {
    const bomb = fs.readFileSync(path.join(XLSX_DIR, "bomb.xlsx"));
    const ok = fs.readFileSync(path.join(XLSX_DIR, "ok.xlsx"));
    const X = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    // One at a time: two back-to-back dispatches hit the ingest service's
    // admission limit (429) — a known, separate issue this run does not test.
    await uploadKnowledge(await J(), B.ws, "bomb.xlsx", X, bomb);
    const [b] = await waitFiles(await J(), B.ws, ["bomb.xlsx"], 180000);
    await uploadKnowledge(await J(), B.ws, "ok.xlsx", X, ok);
    const [o] = await waitFiles(await J(), B.ws, ["ok.xlsx"], 180000);
    if (b.status !== "failed" || !/too large/i.test(b.error || "")) {
      throw new Error(`bomb: ${b.status} ${b.error}`);
    }
    if (o.status !== "ready") throw new Error(`ok.xlsx: ${o.status} ${o.error}`);
    return `bomb.xlsx (${bomb.length} B) failed: "${b.error}"; ok.xlsx ready (${o.chunkCount} chunks)`;
  });

  await step("F-04 spreadsheet: the bomb as a chat attachment does not break the turn", async () => {
    const bomb = fs.readFileSync(path.join(XLSX_DIR, "bomb.xlsx"));
    await sendChat(page, "In one sentence, what does the attached spreadsheet contain?", [
      {
        name: "chat-bomb.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: bomb,
      },
    ]);
    const stop = page.getByRole("button", { name: "Stop generating" });
    await stop.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await stop.waitFor({ state: "detached", timeout: 180000 });
    const reply = await page.locator("[data-role='assistant'], .prose").last().innerText().catch(() => "");
    return `turn completed; reply: "${reply.replace(/\s+/g, " ").slice(0, 140)}"`;
  });

  // ------------------------------------------------------- F-11 + F-08
  B.thread = null;
  await step("F-11 invite: re-invite refreshes ONE grant; B accepts; a member cannot be re-invited", async () => {
    const i1 = await call("mutation", jwtA, "orgs:invite", { workspaceId: wsA._id, email: B.email, role: "member" });
    const i2 = await call("mutation", jwtA, "orgs:invite", { workspaceId: wsA._id, email: B.email.toUpperCase(), role: "member" });
    if (i1 !== i2) throw new Error("a second pending grant was stacked");
    const mine = await call("query", await J(), "orgs:myInvites", {});
    if (mine.filter((i) => i.workspaceId === wsA._id).length !== 1) throw new Error("B does not see exactly one invite");
    await call("mutation", await J(), "orgs:acceptInvite", { inviteId: i1 });
    B.invite = i1;
    const err = await expectRejected(
      call("mutation", jwtA, "orgs:invite", { workspaceId: wsA._id, email: B.email, role: "member" }),
      /Already a member/,
    );
    return `one grant (${i1.slice(0, 8)}…), accepted; re-invite refused: "${err}"`;
  });

  await step("F-08 removed member: every standing grant dies with the membership", async () => {
    const jwt = await J();
    const workspaces = await call("query", jwt, "orgs:myWorkspaces", {});
    if (!workspaces.some((w) => w._id === wsA._id)) throw new Error("B is not a member after accepting");
    B.thread = await call("mutation", jwt, "chat/threads:create", { workspaceId: wsA._id, title: "removed-member probe" });
    const { key } = await call("action", jwt, "apiKeys:create", { workspaceId: wsA._id, name: "removed-member probe" });
    B.key = key;
    B.task = await call("mutation", jwt, "scheduled/tasks:create", {
      workspaceId: wsA._id,
      title: "removed-member probe",
      prompt: "noop",
      spec: { kind: "once", timezone: "UTC", runAt: Date.now() + 30 * 86400e3 },
    });
    const tasksBefore = await call("query", jwt, "scheduled/tasks:list", {});
    if (!(await verifyKey(key))) throw new Error("the key was not valid while B was a member");
    if (!tasksBefore.some((t) => t._id === B.task)) throw new Error("task not listed while a member");

    const mem = (await call("query", jwtA, "orgs:members", { workspaceId: wsA._id })).find(
      (m) => (m.email || "").toLowerCase() === B.email.toLowerCase(),
    );
    if (!mem) throw new Error("B not in A's member list");
    await call("mutation", jwtA, "orgs:removeMember", { workspaceId: wsA._id, memberId: mem._id });

    const after = await J();
    const checks = [];
    if (await verifyKey(key)) throw new Error("API key still valid after removal");
    checks.push("api key invalid");
    const tasksAfter = await call("query", after, "scheduled/tasks:list", {});
    if (tasksAfter.some((t) => t._id === B.task)) throw new Error("task still listed after removal");
    if (await call("query", after, "scheduled/tasks:get", { taskId: B.task })) throw new Error("task detail readable");
    checks.push("task hidden");
    const ws2 = await call("query", after, "orgs:myWorkspaces", {});
    if (ws2.some((w) => w._id === wsA._id)) throw new Error("workspace still listed");
    checks.push("workspace gone");
    const m2 = await call("query", after, "orgs:members", { workspaceId: wsA._id }).catch((e) => e.message);
    if (Array.isArray(m2) && m2.length) throw new Error("member list still readable");
    const t2 = await call("query", after, "chat/threads:list", {
      workspaceId: wsA._id,
      paginationOpts: { numItems: 5, cursor: null },
    }).catch((e) => e.message);
    if (t2?.page?.length) throw new Error("own thread in A's workspace still listed");
    checks.push("members/threads denied");
    await expectRejected(call("mutation", after, "orgs:acceptInvite", { inviteId: B.invite }), /not found/i);
    checks.push("old invite cannot re-admit");
    const nowMembers = (await call("query", jwtA, "orgs:members", { workspaceId: wsA._id })).length;
    if (nowMembers !== membersBefore) throw new Error(`A's member count ${membersBefore} -> ${nowMembers}`);
    return checks.join(", ");
  });

  // ---------------------------------------------------------------- F-13
  await step("F-13 file deleted mid-ingest: removed while processing", async () => {
    const lines = [];
    for (let i = 0; i < 6000; i++) lines.push(`Line ${i}: ${crypto.randomBytes(24).toString("hex")} quarterly inventory note.`);
    const body = Buffer.from(lines.join("\n"), "utf8");
    const jwt = await J();
    const name = `midway-${Date.now().toString(36)}.txt`;
    await uploadKnowledge(jwt, B.ws, name, "text/plain", body);
    const deadline = Date.now() + 60000;
    let row;
    // A row is "processing" from saveFile on; Python is only provably mid-run
    // once it reports its own stage. Embedding is the long one.
    for (;;) {
      row = (await fileRows(jwt, B.ws)).find((f) => f.name === name);
      if (row?.status === "processing" && ["chunking", "embedding"].includes(row.stage)) break;
      if (row && row.status !== "processing") {
        throw new Error(`reached ${row.status} before it could be deleted mid-run`);
      }
      if (Date.now() > deadline) throw new Error(`never started processing (${row?.status})`);
      await sleep(250);
    }
    B.f13DeletedAt = new Date().toISOString();
    B.f13Stage = `${row.stage ?? "-"} ${row.progress ?? "-"}`;
    await call("mutation", jwt, "userFiles:remove", { fileId: row._id });
    await sleep(8000);
    if ((await fileRows(jwt, B.ws)).some((f) => f.name === name)) throw new Error("row came back");
    return `${name} (${body.length} B) deleted at stage ${B.f13Stage}; Postgres side checked on the VM`;
  });

  // ---------------------------------------------------------------- F-03
  await step("F-03 private knowledge -> web search needs the user's approval", async () => {
    const secret = `ZQ7X-${crypto.randomBytes(5).toString("hex").toUpperCase()}-KV4`;
    B.secret = secret;
    await uploadKnowledge(
      await J(),
      B.ws,
      "atlas-vault.txt",
      "text/plain",
      Buffer.from(
        // Nothing here tells the model to keep it secret: the gate, not the
        // model's discretion, is what is under test.
        `Atlas project record.\nAtlas project reference code: ${secret}.\n` +
          "Used on the Atlas supplier portal.\n",
      ),
    );
    await waitFiles(await J(), B.ws, ["atlas-vault.txt"], 120000);
    await sendChat(
      page,
      "Find the Atlas project reference code in my uploaded files, then do a web search " +
        "for that exact code and tell me what comes up.",
    );
    const approve = page.getByRole("button", { name: "Approve" });
    const stop = page.getByRole("button", { name: "Stop generating" });
    const outcome = await Promise.race([
      page
        .getByText(/Approval required/)
        .first()
        .waitFor({ timeout: 180000 })
        .then(() => approve.first().waitFor({ timeout: 20000 }))
        .then(() => "card"),
      stop
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => stop.waitFor({ state: "detached", timeout: 180000 }))
        .then(() => "finished"),
    ]).catch(async (e) => {
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
      const card = await page.getByText(/Approval required/).count();
      throw new Error(`card text shown: ${card > 0}; ${e.message.split("\n")[0]}`);
    });
    if (outcome !== "card") {
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      throw new Error(`no approval card; turn finished; page tail: "${text.slice(-400)}"`);
    }
    const card = await approve.first().locator("xpath=ancestor::div[3]").innerText();
    await page.getByRole("button", { name: "Reject" }).first().click();
    await stop.waitFor({ state: "detached", timeout: 180000 }).catch(() => {});
    return `card: "${card.replace(/\s+/g, " ").slice(0, 220)}" -> Reject clicked`;
  });

  // ---------------------------------------------------------------- F-12
  await step("F-12 account deletion through Settings; sign-in refused; avatar bytes gone", async () => {
    await page.goto(`${BASE}/en/settings`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Your password").waitFor({ timeout: 30000 });
    await page.getByPlaceholder("Your password").fill(B.password);
    await page.getByRole("button", { name: "Delete Account" }).click();
    await page.getByRole("button", { name: "Are you sure?" }).click();
    await page.locator('input[type="password"]').first().waitFor({ timeout: 30000 });
    await sleep(3000);
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    await signIn(p2, B.email, B.password);
    await sleep(6000);
    if (/\/chat/.test(p2.url())) throw new Error("the deleted account still signs in");
    await fresh.close();
    const out = ["sign-in refused"];
    if (B.avatarUrl) {
      const deadline = Date.now() + 30000;
      let status = 0;
      while (Date.now() < deadline) {
        status = (await fetch(B.avatarUrl)).status;
        if (status === 404) break;
        await sleep(2000);
      }
      if (status !== 404) throw new Error(`avatar URL still ${status}`);
      out.push("avatar 404");
    }
    if (B.key) {
      if (await verifyKey(B.key)) throw new Error("API key valid again");
      out.push("key invalid");
    }
    return out.join("; ");
  });

  await step("zero console errors in B's browser session", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 5).join(" || "));
    return "0";
  });

  fs.writeFileSync(
    OUT,
    JSON.stringify({ userId: B.userId, ws: B.ws, email: B.email, thread: B.thread, task: B.task, f13DeletedAt: B.f13DeletedAt, secret: B.secret }),
  );
  await browser.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== REMAINING SECURITY FINDINGS, PROD: ${pass}/${results.length} ===`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
