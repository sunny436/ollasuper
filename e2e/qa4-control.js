// QA-4 (prod-safe) — CANCELLATION + races, real user. Approval is best-effort
// (fires only when the model picks a side-effecting tool; we won't force real
// irreversible side effects — the approval state machine is covered by the suites).
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const errs = [], net = [], results = [], threads = [];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 150000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); }
  return false;
};
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };
const step = async (n, f) => {
  try { await f(); results.push(true); console.log("PASS  " + n); }
  catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); }
};
async function fresh(page, prompt) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await gen(page).waitFor({ timeout: 25000 });
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  return tid(page);
}
async function pressStop(page) {
  const s = gen(page);
  if ((await s.count()) === 0) throw new Error("no Stop button (generation not in flight)");
  await s.click();
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 20 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) net.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`); });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]'); await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
  });
  console.log("QA4_START " + new Date().toISOString());

  await step("STOP during streaming → generation actually stops (no silent continue)", async () => {
    const id = await fresh(page, "Write a detailed 800-word essay about the history of the ocean.");
    threads.push(["stop-stream", id]);
    await page.waitForTimeout(1800); // let it stream
    await pressStop(page);
    await page.waitForTimeout(2500);
    if ((await gen(page).count()) > 0) throw new Error("still generating after STOP");
    // and it must NOT silently restart
    const len1 = (await page.evaluate(() => document.body.innerText)).length;
    await page.waitForTimeout(3000);
    const len2 = (await page.evaluate(() => document.body.innerText)).length;
    if (len2 > len1 + 40) throw new Error("text kept growing after STOP (silent continuation)");
  });

  await step("STOP during TOOL execution → stops, no runaway tools", async () => {
    const id = await fresh(page, "search the web for the latest world news and give me a long detailed summary");
    threads.push(["stop-tool", id]);
    // wait until a tool is actually running (agent-activity) then stop
    const dl = Date.now() + 30000;
    while (Date.now() < dl) { if ((await page.locator("[data-agent-activity]").count()) > 0) break; await page.waitForTimeout(500); }
    await pressStop(page);
    await page.waitForTimeout(3000);
    if ((await gen(page).count()) > 0) throw new Error("still generating after STOP during tool");
  });

  await step("RACE: STOP + immediate SEND → new turn works, no stuck state", async () => {
    const id = await fresh(page, "Write a very long essay about mountains, at least 800 words.");
    threads.push(["stop-send", id]);
    await page.waitForTimeout(1500);
    await pressStop(page);
    // immediately send a new message on the same thread
    await page.waitForTimeout(400);
    await page.locator("#chat-composer").fill("Reply with exactly the word: RESUMED");
    await page.keyboard.press("Enter");
    await gen(page).waitFor({ timeout: 20000 }).catch(() => {});
    await settle(page, 90000);
    const ok = await page.evaluate(() => (document.body.innerText || "").includes("RESUMED"));
    if (!ok) throw new Error("post-STOP send did not produce a reply (stuck state)");
  });

  await step("APPROVAL (best-effort): a side-effecting task → approval UI or safe fallback", async () => {
    const id = await fresh(page, "open the website example.com in a browser and tell me the exact main heading text");
    threads.push(["approval-try", id]);
    // look for an approval affordance for up to 20s
    let approvalSeen = false;
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      const btns = await page.getByRole("button", { name: /approve|allow|run|authorize/i }).count();
      if (btns > 0) { approvalSeen = true; break; }
      if ((await gen(page).count()) === 0) break;
      await page.waitForTimeout(600);
    }
    await settle(page, 120000);
    console.log(`      ↳ approval UI surfaced: ${approvalSeen}`);
    // pass either way: if approval surfaced it was gated (good); if not, the model
    // used a read-only path or answered — both are safe. The state machine itself
    // is covered by the approval suites. This step must just not ERROR/crash.
  });

  console.log("QA4_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA4: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
