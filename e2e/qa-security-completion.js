// Production acceptance for the SECURITY-AUDIT-FINAL completion pass: every
// item the earlier prod runs had not exercised, on the deployed app, as real
// users. Destructive steps only ever touch throwaway accounts made here.
//
//   A = the QA account (owner of its workspace; invites/removes B only).
//   B = throwaway: approval flow, upload queue, avatar, membership lifecycle,
//       account switching; deleted through Settings at the end.
//   C = throwaway: OTP throttling (F-07); deleted at the end.
//   E = throwaway seeded past every cleanup page size (F-12); deleted through
//       Settings inside its own section.
//
//   QA_EMAIL=… QA_PASSWORD=… OLLASTACK_MAIL_TOKEN=… OLLASTACK_E2E_MAILBOX_ID=… \
//   XLSX_DIR=<dir with bomb.xlsx> OUT=<ids.json> [ONLY=f07,f03,…] \
//   node qa-security-completion.js
//
// Sections: f07 f03 multi queue avatar member f09 f14 f12scale. Sign-up, the
// console gate and cleanup always run. OUT receives ids for the read-only VM
// checks; no password is ever printed or written.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = `${BASE}/__cvx`;
const XLSX_DIR = process.env.XLSX_DIR;
const OUT = process.env.OUT;
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => crypto.randomBytes(n).toString("hex").toUpperCase();
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const results = [];
const consoleErrors = [];
const out = {};

const wanted = (section) => ONLY.length === 0 || ONLY.includes(section);

async function step(section, name, fn) {
  if (!wanted(section)) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  [${section}] ${name}${detail ? ` — ${detail}` : ""} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  [${section}] ${name} — ${String(e.message || e).slice(0, 500)}`);
  }
}

async function call(kind, jwt, fn, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") {
    const msg = j.errorData ? JSON.stringify(j.errorData) : j.errorMessage || String(r.status);
    throw new Error(`${fn}: ${msg}`);
  }
  return j.value;
}

async function rejected(promise, re) {
  try {
    await promise;
  } catch (e) {
    if (re.test(e.message)) return e.message.replace(/^[^:]*: /, "");
    throw new Error(`rejected with the wrong error: ${e.message}`);
  }
  throw new Error("was ALLOWED");
}

async function passwordSignIn(email, password) {
  const v = await call("action", null, "auth:signIn", {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
  if (!v?.tokens?.token) throw new Error("no token");
  return v.tokens.token;
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

async function uiSignIn(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await waitForForm(page);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.keyboard.press("Enter");
}

/** A throwaway signed up through the real UI and the e2e inbox. */
async function signUp(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`${label}: ${m.text().slice(0, 200)}`);
  });
  const tag = ollastack.newTag();
  const email = ollastack.taggedAddress(await ollastack.mailboxAddress(), tag);
  const password = `Qa${crypto.randomBytes(12).toString("base64url")}!7z`;
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await waitForForm(page);
  await page.click('button:has-text("Create an account")');
  await page.fill('input[name="name"]', `QA ${label}`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[name="code"]', { timeout: 30000 });
  const code = await ollastack.codeFromOllastack(tag, "email verification", 120000);
  if (!code) throw new Error(`${label}: no verification code arrived`);
  await page.fill('input[name="code"]', code);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  const jwt = async () => {
    const c = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name));
    if (!c) throw new Error(`${label}: no auth cookie`);
    return c.value;
  };
  const me = await call("query", await jwt(), "users:getUser", {});
  const ws = (await call("query", await jwt(), "orgs:myWorkspaces", {}))[0]._id;
  return { label, ctx, page, email, password, tag, jwt, userId: me._id, ws };
}

async function deleteViaSettings(browser, u) {
  await u.page.goto(`${BASE}/en/settings`, { waitUntil: "domcontentloaded" });
  await u.page.getByPlaceholder("Your password").waitFor({ timeout: 30000 });
  await u.page.getByPlaceholder("Your password").fill(u.password);
  await u.page.getByRole("button", { name: "Delete Account" }).click();
  await u.page.getByRole("button", { name: "Are you sure?" }).click();
  await u.page.locator('input[type="password"]').first().waitFor({ timeout: 30000 });
  await sleep(3000);
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await uiSignIn(p2, u.email, u.password);
  await sleep(6000);
  const stillIn = /\/chat/.test(p2.url());
  await fresh.close();
  if (stillIn) throw new Error(`${u.label} still signs in after deletion`);
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
  return (
    await call("query", jwt, "userFiles:list", {
      workspaceId,
      paginationOpts: { numItems: 50, cursor: null },
    })
  ).page;
}

async function waitFiles(jwt, workspaceId, names, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await fileRows(jwt, workspaceId)).filter((f) => names.includes(f.name));
    if (rows.length === names.length && rows.every((f) => f.status !== "processing")) return rows;
    if (Date.now() > deadline) {
      throw new Error(`not terminal: ${rows.map((f) => `${f.name}=${f.status}/${f.stage}`).join(", ")}`);
    }
    await sleep(2500);
  }
}

async function newChat(page, text) {
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/, { timeout: 30000 });
}

const stopBtn = (page) => page.getByRole("button", { name: "Stop generating" });
const approveBtns = (page) => page.getByRole("button", { name: "Approve" });
const rejectBtns = (page) => page.getByRole("button", { name: "Reject" });

/** Wait until the turn either shows an actionable card or finishes. */
async function cardOrDone(page, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  let sawStop = false;
  while (Date.now() < deadline) {
    if ((await approveBtns(page).count()) > 0) return "card";
    const running = (await stopBtn(page).count()) > 0;
    if (running) sawStop = true;
    if (sawStop && !running) return "done";
    await sleep(1000);
  }
  return "timeout";
}

async function waitTurnDone(page, timeoutMs = 180000) {
  await stopBtn(page).waitFor({ state: "detached", timeout: timeoutMs });
}

const threadIdOf = (page) => /\/chat\/([a-z0-9]+)/.exec(page.url())?.[1];

(async () => {
  if (!XLSX_DIR || !OUT) throw new Error("XLSX_DIR and OUT are required");
  if (!ollastack.enabled()) throw new Error("OLLASTACK_MAIL_TOKEN / OLLASTACK_E2E_MAILBOX_ID not set");
  const A = account();
  const jwtA = await passwordSignIn(A.email, A.password);
  const wsA = (await call("query", jwtA, "orgs:myWorkspaces", {})).find((w) =>
    ["owner", "admin"].includes(w.role),
  );
  if (!wsA) throw new Error("QA account administers no workspace");
  const membersBefore = (await call("query", jwtA, "orgs:members", { workspaceId: wsA._id })).length;

  const browser = await chromium.launch({ headless: false });
  const needB = ["f03", "multi", "queue", "avatar", "member", "f09"].some(wanted);
  let B = null;
  if (needB) {
    await step("setup", "B: throwaway signs up through the real UI + inbox", async () => {
      B = await signUp(browser, "B");
      out.B = { userId: B.userId, ws: B.ws, email: B.email };
      return B.email;
    });
  }

  // ------------------------------------------------------------------ F-07
  let C = null;
  await step("f07", "F-07: a throttled code request keeps the last delivered code valid", async () => {
    C = await signUp(browser, "C");
    out.C = { userId: C.userId, email: C.email };
    const resets = async () =>
      (await ollastack.messagesForTag(C.tag)).filter((m) =>
        /password reset/i.test(String(m.subject)),
      );
    let lastCode = null;
    let delivered = 0;
    let throttled = null;
    for (let i = 1; i <= 7 && !throttled; i++) {
      const before = (await resets()).length;
      try {
        await call("action", null, "auth:signIn", {
          provider: "password",
          params: { email: C.email, flow: "reset" },
        });
      } catch (e) {
        throttled = { at: i, message: e.message };
        break;
      }
      const deadline = Date.now() + 90000;
      let now = await resets();
      while (now.length <= before && Date.now() < deadline) {
        await sleep(2000);
        now = await resets();
      }
      if (now.length <= before) throw new Error(`reset #${i} was accepted but no mail arrived`);
      delivered += 1;
      const full = await ollastack.message(now[0].id);
      const m = `${full?.textBody ?? ""} ${full?.htmlBody ?? ""}`.match(/\b(\d{6,8})\b/);
      if (!m) throw new Error(`reset #${i}: no code in the mail`);
      lastCode = m[1];
    }
    if (!throttled) throw new Error(`never throttled after ${delivered} deliveries`);
    if (!/too many codes/i.test(throttled.message)) {
      throw new Error(`throttled with an unexpected message: ${throttled.message}`);
    }
    // No silent replacement: nothing new is delivered for the refused request.
    const countAtThrottle = (await resets()).length;
    await sleep(15000);
    if ((await resets()).length !== countAtThrottle) throw new Error("a mail was sent after the refusal");
    // The code the user holds still works.
    const newPassword = `Qa${crypto.randomBytes(12).toString("base64url")}!9y`;
    const v = await call("action", null, "auth:signIn", {
      provider: "password",
      params: { email: C.email, code: lastCode, newPassword, flow: "reset-verification" },
    });
    if (!v?.tokens?.token) throw new Error("the last delivered code was refused");
    C.password = newPassword;
    await passwordSignIn(C.email, newPassword);
    return `${delivered} codes delivered, request #${throttled.at} refused ("${throttled.message.replace(/^[^:]*: /, "").slice(0, 70)}"), last delivered code still completed the reset`;
  });

  // ------------------------------------------------------------------ F-03
  let secret = null;
  const f03Doc = async () => {
    if (secret) return secret;
    secret = `ZQ7X-${hex(5)}-KV4`;
    await uploadKnowledge(
      await B.jwt(),
      B.ws,
      "atlas-record.txt",
      "text/plain",
      Buffer.from(`Atlas project record.\nAtlas project reference code: ${secret}.\nUsed on the Atlas supplier portal.\n`),
    );
    await waitFiles(await B.jwt(), B.ws, ["atlas-record.txt"], 150000);
    return secret;
  };
  const SEARCH_PROMPT =
    "Find the Atlas project reference code in my uploaded files, then do a web search " +
    "for that exact code and tell me what comes up.";

  /** Start a turn that should park on a card; one retry if the model declines. */
  async function parkedTurn(prompt) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await newChat(B.page, prompt);
      const state = await cardOrDone(B.page);
      if (state === "card") return attempt;
      if (state === "timeout") throw new Error("neither a card nor a finished turn after 150 s");
    }
    throw new Error("the model answered without searching twice (no egress attempted)");
  }

  await step("f03", "F-03: private data → web parks on an actionable card that survives reload; Reject ends the turn without a re-ask", async () => {
    await f03Doc();
    const attempt = await parkedTurn(SEARCH_PROMPT);
    const reason = (await B.page.getByText(/sends data that came from/).first().innerText()).trim();
    if (!/private:knowledge/.test(reason)) throw new Error(`card reason: ${reason}`);
    // Durable: a reload shows the same actionable card.
    await B.page.reload({ waitUntil: "domcontentloaded" });
    await approveBtns(B.page).first().waitFor({ timeout: 30000 });
    const cards = await approveBtns(B.page).count();
    for (let i = 0; i < cards; i++) await rejectBtns(B.page).first().click();
    const after = await cardOrDone(B.page, 120000);
    if (after === "card") throw new Error("re-asked for the same egress after Reject");
    if (after === "timeout") throw new Error("the turn did not finish after Reject");
    const body = (await B.page.locator("body").innerText()).replace(/\s+/g, " ");
    return `attempt ${attempt}; card "${reason.slice(0, 90)}"; ${cards} card(s) survived reload; rejected → turn finished, no re-ask (${body.length} chars on page)`;
  });

  await step("f03", "F-03: Approve runs the approved call and the turn completes", async () => {
    await f03Doc();
    const attempt = await parkedTurn(SEARCH_PROMPT);
    const cards = await approveBtns(B.page).count();
    for (let i = 0; i < cards; i++) await approveBtns(B.page).first().click();
    // The approved call runs; the model may still ask again for a DIFFERENT
    // query (a new decision) — approve those too, bounded.
    for (let round = 0; round < 3; round++) {
      const s = await cardOrDone(B.page, 150000);
      if (s === "done") break;
      if (s === "timeout") throw new Error("the approved turn did not finish");
      await approveBtns(B.page).first().click();
    }
    const tid = threadIdOf(B.page);
    out.f03ApprovedThread = tid;
    return `attempt ${attempt}; ${cards} card(s) approved; turn finished (thread ${tid})`;
  });

  await step("multi", "F-03: two gated calls in one step each get an answerable card; the turn resumes only after both", async () => {
    await f03Doc();
    await parkedTurn(
      "Find the Atlas project reference code in my uploaded files. Then, in ONE step, run TWO " +
        "separate web searches at the same time: one for the exact code, and one for the exact " +
        "code followed by the word leak.",
    );
    await sleep(3000);
    const n = await approveBtns(B.page).count();
    if (n < 2) {
      for (let i = 0; i < n; i++) await rejectBtns(B.page).first().click();
      await cardOrDone(B.page, 120000);
      return `INCONCLUSIVE — the model issued ${n} gated call(s) in that step, not two (the two-card path is covered by chat.approvals.test.ts)`;
    }
    await rejectBtns(B.page).first().click();
    await sleep(4000);
    if ((await stopBtn(B.page).count()) === 0) throw new Error("the turn resumed after the first of two decisions");
    if ((await approveBtns(B.page).count()) < 1) throw new Error("the second card lost its buttons");
    await rejectBtns(B.page).first().click();
    const s = await cardOrDone(B.page, 120000);
    if (s === "timeout") throw new Error("the turn did not finish after both decisions");
    return `${n} cards, both answerable; still parked after the first; finished after the second`;
  });

  // ------------------------------------------------------------ 429 queue
  await step("queue", "Knowledge: 3 files uploaded back-to-back all ingest (queued, not failed with 429)", async () => {
    const names = [1, 2, 3].map((i) => `burst-${i}-${hex(3)}.txt`);
    for (const n of names) {
      await uploadKnowledge(await B.jwt(), B.ws, n, "text/plain", Buffer.from(`burst ${n} ${hex(16)}\n`));
    }
    let sawQueued = false;
    const deadline = Date.now() + 240000;
    for (;;) {
      const rows = (await fileRows(await B.jwt(), B.ws)).filter((f) => names.includes(f.name));
      if (rows.some((f) => f.stage === "queued")) sawQueued = true;
      if (rows.length === 3 && rows.every((f) => f.status !== "processing")) {
        const bad = rows.filter((f) => f.status !== "ready");
        if (bad.length) throw new Error(bad.map((f) => `${f.name}: ${f.status} ${f.error}`).join("; "));
        return `all 3 ready${sawQueued ? " (queued state observed)" : ""}`;
      }
      if (Date.now() > deadline) throw new Error(rows.map((f) => `${f.name}=${f.status}/${f.stage}`).join(", "));
      await sleep(1500);
    }
  });

  // ---------------------------------------------------------------- avatar
  await step("avatar", "Avatar: replacing deletes the old photo's bytes; reset deletes the current one", async () => {
    const setAvatar = async () => {
      await B.page.goto(`${BASE}/en/settings`, { waitUntil: "domcontentloaded" });
      const before = (await call("query", await B.jwt(), "users:getUser", {})).avatarUrl ?? null;
      await B.page.locator("#avatar_field").waitFor({ state: "attached", timeout: 30000 });
      await B.page.locator("#avatar_field").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG_1PX });
      const deadline = Date.now() + 30000;
      for (;;) {
        const now = (await call("query", await B.jwt(), "users:getUser", {})).avatarUrl ?? null;
        if (now && now !== before) return now;
        if (Date.now() > deadline) throw new Error("avatar never changed");
        await sleep(1000);
      }
    };
    const status = async (u) => (await fetch(u)).status;
    const first = await setAvatar();
    if ((await status(first)) !== 200) throw new Error("first avatar not served");
    const second = await setAvatar();
    if ((await status(second)) !== 200) throw new Error("second avatar not served");
    if ((await status(first)) !== 404) throw new Error(`replaced avatar still served (${await status(first)})`);
    await B.page.goto(`${BASE}/en/settings`, { waitUntil: "domcontentloaded" });
    await B.page.getByRole("button", { name: "Reset" }).click();
    const deadline = Date.now() + 20000;
    while ((await status(second)) !== 404 && Date.now() < deadline) await sleep(1000);
    if ((await status(second)) !== 404) throw new Error("reset avatar still served");
    return "old photo 404 after replace; current photo 404 after reset";
  });

  // ------------------------------------------- F-08 / F-11 (membership life)
  await step("member", "F-11/F-08: admin grants, issuer removal, artifacts, retry and retrieval all follow current membership", async () => {
    const jB = () => B.jwt();
    const nimbus = `NB-${hex(5)}`;
    const cirrus = `CR-${hex(5)}`;
    const x = `x-${B.tag}@example.invalid`;

    const inv = await call("mutation", jwtA, "orgs:invite", { workspaceId: wsA._id, email: B.email, role: "admin" });
    await call("mutation", await jB(), "orgs:acceptInvite", { inviteId: inv });
    const self = await rejected(
      call("mutation", await jB(), "orgs:invite", { workspaceId: wsA._id, email: B.email, role: "admin" }),
      /Already a member/,
    );
    await call("mutation", await jB(), "orgs:invite", { workspaceId: wsA._id, email: x, role: "member" });
    const pendingBefore = await call("query", jwtA, "orgs:pendingInvites", { workspaceId: wsA._id });
    if (!pendingBefore.some((i) => i.email === x)) throw new Error("B's invite to X not pending");

    // B's footprint in A's workspace: knowledge, a failed file, an artifact.
    await uploadKnowledge(await jB(), wsA._id, "nimbus.txt", "text/plain",
      Buffer.from(`Project Nimbus budget code: ${nimbus}.\n`));
    const bomb = fs.readFileSync(path.join(XLSX_DIR, "bomb.xlsx"));
    await uploadKnowledge(await jB(), wsA._id, "bomb-in-a.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bomb);
    const [nim, bombRow] = await Promise.all([
      waitFiles(await jB(), wsA._id, ["nimbus.txt"], 150000),
      waitFiles(await jB(), wsA._id, ["bomb-in-a.xlsx"], 150000),
    ]);
    if (nim[0].status !== "ready") throw new Error(`nimbus.txt ${nim[0].status}`);
    if (bombRow[0].status !== "failed") throw new Error(`bomb ${bombRow[0].status}`);
    // B's OWN knowledge (positive control for retrieval after removal).
    await uploadKnowledge(await jB(), B.ws, "cirrus.txt", "text/plain",
      Buffer.from(`Project Cirrus budget code: ${cirrus}.\n`));
    await waitFiles(await jB(), B.ws, ["cirrus.txt"], 150000);

    // An artifact generated in A's workspace.
    const threadInA = await call("mutation", await jB(), "chat/threads:create", { workspaceId: wsA._id, title: "artifact probe" });
    await B.page.goto(`${BASE}/en/chat/${threadInA}`, { waitUntil: "domcontentloaded" });
    await B.page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    await B.page.locator("#chat-composer").fill("Create a downloadable plain-text file named nimbus-note.txt that contains exactly the word nimbus.");
    await B.page.keyboard.press("Enter");
    await stopBtn(B.page).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await waitTurnDone(B.page, 240000);
    const msgs = await call("query", await jB(), "chat/messages:listPaged", {
      threadId: threadInA,
      paginationOpts: { numItems: 10, cursor: null },
    });
    let artifactId = null;
    for (const m of msgs.page) {
      for (const e of m.events ?? []) {
        if (e.type !== "ARTIFACT") continue;
        const p = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
        artifactId = p?.artifact_id ?? artifactId;
      }
    }
    if (!artifactId) throw new Error("no artifact was generated in A's workspace");
    await call("mutation", await jB(), "chat/artifacts:mintDownload", { artifactId }); // positive control

    // Remove B.
    const mem = (await call("query", jwtA, "orgs:members", { workspaceId: wsA._id })).find(
      (m) => (m.email || "").toLowerCase() === B.email.toLowerCase(),
    );
    await call("mutation", jwtA, "orgs:removeMember", { workspaceId: wsA._id, memberId: mem._id });

    const checks = [`self-invite refused ("${self}")`];
    const pendingAfter = await call("query", jwtA, "orgs:pendingInvites", { workspaceId: wsA._id });
    if (pendingAfter.some((i) => i.email === x)) throw new Error("the removed admin's invite survived");
    checks.push("removed admin's invite gone");
    await rejected(call("mutation", await jB(), "chat/artifacts:mintDownload", { artifactId }), /not found/i);
    checks.push("artifact download refused");
    await rejected(call("mutation", await jB(), "userFiles:retry", { fileId: bombRow[0]._id }), /not found/i);
    checks.push("knowledge retry refused");

    // Retrieval follows membership: A's-workspace knowledge is gone, B's own stays.
    const ask = async (q) => {
      await newChat(B.page, q);
      await stopBtn(B.page).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
      await waitTurnDone(B.page, 180000);
      return (await B.page.locator("body").innerText()).replace(/\s+/g, " ");
    };
    const nimbusAnswer = await ask("What is the Project Nimbus budget code in my uploaded files? Quote it exactly.");
    if (nimbusAnswer.includes(nimbus)) throw new Error("retrieved knowledge from a workspace B was removed from");
    const cirrusAnswer = await ask("What is the Project Cirrus budget code in my uploaded files? Quote it exactly.");
    if (!cirrusAnswer.includes(cirrus)) throw new Error("positive control failed: own knowledge not retrieved");
    checks.push("removed-workspace knowledge not retrieved, own knowledge retrieved");

    // A NEW invitation after removal still works (positive control).
    const inv2 = await call("mutation", jwtA, "orgs:invite", { workspaceId: wsA._id, email: B.email, role: "member" });
    await call("mutation", await jB(), "orgs:acceptInvite", { inviteId: inv2 });
    const mem2 = (await call("query", jwtA, "orgs:members", { workspaceId: wsA._id })).find(
      (m) => (m.email || "").toLowerCase() === B.email.toLowerCase(),
    );
    if (!mem2) throw new Error("a fresh invitation did not admit B");
    await call("mutation", jwtA, "orgs:removeMember", { workspaceId: wsA._id, memberId: mem2._id });
    checks.push("a new invite still admits");
    const n = (await call("query", jwtA, "orgs:members", { workspaceId: wsA._id })).length;
    if (n !== membersBefore) throw new Error(`A's member count ${membersBefore} -> ${n}`);
    return checks.join("; ");
  });

  // ---------------------------------------------------------------- F-09
  await step("f09", "F-09: switching accounts in one browser never shows the previous user's cached data", async () => {
    const aThreads = (
      await call("query", jwtA, "chat/threads:list", { workspaceId: wsA._id, paginationOpts: { numItems: 5, cursor: null } })
    ).page.map((t) => t.title).filter((t) => t && t.length >= 6);
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(`F09: ${m.text().slice(0, 200)}`));
    await uiSignIn(page, A.email, A.password);
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    await page.locator("#chat-composer").waitFor({ timeout: 30000 });
    await sleep(4000);
    const cachedA = await page.evaluate(() => JSON.parse(localStorage.getItem("user") || "null"));
    if (!cachedA?.owner) throw new Error("A's cache was not written");
    // The session ends WITHOUT a logout (expiry / revocation / closed tab):
    // cookies go, localStorage stays.
    await ctx.clearCookies();
    const seen = [];
    const sample = async () => seen.push(await page.locator("body").innerText().catch(() => ""));
    await uiSignIn(page, B.email, B.password);
    for (let i = 0; i < 12; i++) {
      await sample();
      await sleep(500);
    }
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    await sleep(3000);
    await sample();
    const leaked = seen.join("\n");
    if (leaked.includes(A.email)) throw new Error("B's screen showed A's email");
    const title = aThreads.find((t) => leaked.includes(t));
    if (title) throw new Error(`B's screen showed A's thread title "${title}"`);
    const cachedNow = await page.evaluate(() => JSON.parse(localStorage.getItem("user") || "null"));
    if (cachedNow && cachedNow.owner === cachedA.owner) throw new Error("A's cache still in place for B");
    await ctx.close();
    return `${seen.length} samples during B's sign-in: no A email, none of A's ${aThreads.length} thread titles; cache owner switched`;
  });

  // ------------------------------------------------------ F-14 / matcher
  await step("f14", "F-14 + F-09 matcher: image-suffixed chat paths stay gated; OAuth still starts with a verifier", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/en/chat/some-thread.png`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    if (!/\/login/.test(page.url())) throw new Error(`signed-out /chat/*.png served at ${page.url()}`);
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await waitForForm(page);
    const google = page.getByRole("button", { name: /google/i }).first();
    await google.click();
    await page.waitForURL(/accounts\.google\.com/, { timeout: 30000 });
    const verifier = (await ctx.cookies(BASE)).some((c) => /OAuthVerifier$/.test(c.name) && c.value);
    await ctx.close();
    if (!verifier) throw new Error("no OAuth verifier cookie was set for the initiated flow");
    return "signed-out /en/chat/*.png → /login; Google sign-in reaches accounts.google.com with a verifier cookie";
  });

  // ------------------------------------------------------------ F-12 scale
  await step("f12scale", "F-12: 201 files + 201 invites + an unsent upload + avatar are all gone after deletion", async () => {
    const E = await signUp(browser, "E");
    out.E = { userId: E.userId, ws: E.ws, email: E.email };
    const N = 201;
    for (let i = 0; i < N; i++) {
      const bytes = Buffer.from(`F-12 seed ${i} ${hex(8)}\n`);
      const url = await call("mutation", await E.jwt(), "files:generateUploadUrl", { workspaceId: E.ws });
      const up = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: bytes });
      const { storageId } = await up.json();
      await call("mutation", await E.jwt(), "files:saveFile", {
        workspaceId: E.ws, storageId, name: `seed-${i}.txt`, size: bytes.length, contentType: "text/plain",
      });
    }
    for (let i = 0; i < N; i++) {
      await call("mutation", await E.jwt(), "orgs:invite", {
        workspaceId: E.ws, email: `f12-${E.tag}-${i}@example.invalid`, role: "member",
      });
    }
    const aUrl = await call("mutation", await E.jwt(), "chat/attachments:generateUploadUrl", { workspaceId: E.ws });
    const aBytes = Buffer.from("unsent attachment\n");
    const aUp = await (await fetch(aUrl, { method: "POST", headers: { "content-type": "text/plain" }, body: aBytes })).json();
    await call("mutation", await E.jwt(), "chat/attachments:register", {
      workspaceId: E.ws, storageId: aUp.storageId, name: "unsent.txt", size: aBytes.length, contentType: "text/plain",
    });
    const files = await call("query", await E.jwt(), "files:list", { workspaceId: E.ws });
    const pending = await call("query", await E.jwt(), "orgs:pendingInvites", { workspaceId: E.ws });
    if (files.length < N || pending.length < N) throw new Error(`seeded ${files.length} files / ${pending.length} invites`);
    const probeUrls = [files[0].url, files[Math.floor(files.length / 2)].url, files[files.length - 1].url];
    for (const u of probeUrls) if ((await fetch(u)).status !== 200) throw new Error("seed file not served");
    await deleteViaSettings(browser, E);
    const deadline = Date.now() + 240000;
    let live = probeUrls.length;
    while (Date.now() < deadline) {
      live = 0;
      for (const u of probeUrls) if ((await fetch(u)).status !== 404) live += 1;
      if (live === 0) break;
      await sleep(5000);
    }
    if (live) throw new Error(`${live} of ${probeUrls.length} probed file URLs still served`);
    out.E.deletedAt = Date.now();
    await E.ctx.close();
    return `${files.length} files + ${pending.length} invites + 1 unsent upload seeded; deleted via Settings; sign-in refused; probed file URLs 404 (row counts checked on the VM)`;
  });

  // --------------------------------------------------------------- cleanup
  if (C) {
    await step("f07", "C: throwaway deleted", async () => {
      const jwt = await passwordSignIn(C.email, C.password);
      await call("action", jwt, "users:deleteCurrentUserAccount", { password: C.password });
      await sleep(3000);
      await rejected(passwordSignIn(C.email, C.password), /./);
      await C.ctx.close();
      return "sign-in refused";
    });
  }
  if (B) {
    await step("setup", "B: throwaway deleted through Settings", async () => {
      await deleteViaSettings(browser, B);
      out.B.deletedAt = Date.now();
      return "sign-in refused";
    });
  }
  await step("setup", "zero console errors across every throwaway session", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 6).join(" || "));
    return "0";
  });

  fs.writeFileSync(OUT, JSON.stringify(out));
  await browser.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== SECURITY COMPLETION, PROD: ${pass}/${results.length} ===`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out));
  process.exit(1);
});
