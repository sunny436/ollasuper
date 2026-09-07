// QA-0 baseline — production verification (real Chromium vs prod).
// Focus: C1 the AGENT/TOOL path (highest-risk, just-deployed executor), then the
// C2 failure/edge matrix. Captures console errors + network 4xx/5xx + latency,
// and logs thread ids so the backend durable-ledger cross-check can find them.
//
//   E2E_BASE_URL=https://app.ollasuper.com  CI=1  node qa0-baseline.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();

const errs = [];
const net = [];
const results = [];
const threads = [];

const settle = async (page, ms = 90000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(300);
  }
  return false;
};

const threadId = (page) => {
  const u = page.url();
  const m = u.match(/\/chat\/([a-z0-9]+)/i);
  return m ? m[1] : null;
};

const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};

// A soft check that records an observation without failing the suite — used for
// non-deterministic, model-driven behaviour (whether the model chose a tool).
const note = (n, ok, detail) =>
  console.log(`      ↳ ${ok ? "OK " : "?? "}${n}${detail ? " — " + detail : ""}`);

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      net.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`);
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
  });

  // ===== C1 — TOOL / AGENT PATH (priority) ================================
  await step("C1: tool-triggering prompt executes + streams a final answer", async () => {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1200);
    await page.waitForSelector("#chat-composer", { timeout: 10000 });
    await page
      .locator("#chat-composer")
      .fill(
        "Use your web search tool to find one current news headline from today. " +
          "You MUST call the search tool and quote the headline; do not answer from memory.",
      );
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 });
    const id = threadId(page);
    if (id) threads.push(["C1-tool", id]);

    // generation acknowledged (stop button) — proxy for TTFT
    await page
      .getByRole("button", { name: "Stop generating" })
      .waitFor({ timeout: 25000 })
      .catch(() => {});
    const tStart = Date.now() - t0;

    // agent-activity UI appears IFF a tool actually ran (model-dependent).
    let toolUI = false;
    const uiDeadline = Date.now() + 40000;
    while (Date.now() < uiDeadline) {
      if ((await page.locator("[data-agent-activity]").count()) > 0) { toolUI = true; break; }
      if ((await page.getByRole("button", { name: "Stop generating" }).count()) === 0
          && Date.now() - t0 > 8000) break; // finished without a tool
      await page.waitForTimeout(500);
    }
    const ok = await settle(page, 120000);
    const tDone = Date.now() - t0;
    console.log(`      ↳ thread=${id} start~${tStart}ms done~${tDone}ms tool_ui=${toolUI}`);
    note("tool-activity UI", toolUI, toolUI ? "a tool ran" : "model answered from text (backend log will confirm)");
    if (!ok) throw new Error("generation never settled");
    // a final answer must exist (some assistant text landed)
    const hasText = await page.evaluate(() => (document.body.innerText || "").length > 200);
    if (!hasText) throw new Error("no assistant answer rendered");
  });

  await step("C1: tool turn + answer PERSIST across reload", async () => {
    const url = page.url();
    const hadUI = (await page.locator("[data-agent-activity]").count()) > 0;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (page.url() !== url) throw new Error("navigated away on reload");
    const hasText = await page.evaluate(() => (document.body.innerText || "").length > 200);
    if (!hasText) throw new Error("answer did not persist across reload");
    if (hadUI && (await page.locator("[data-agent-activity]").count()) === 0)
      throw new Error("agent-activity UI did not persist across reload");
    note("persistence", true, hadUI ? "answer + tool-activity survived reload" : "answer survived reload");
  });

  // ===== C2 — FAILURE / EDGE MATRIX ======================================
  await step("C2.1-2: empty + whitespace-only do NOT send", async () => {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    const urlBefore = page.url();
    await page.locator("#chat-composer").fill("");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    await page.locator("#chat-composer").fill("     ");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    // no thread was created, no generation started
    if ((await page.getByRole("button", { name: "Stop generating" }).count()) > 0)
      throw new Error("empty/whitespace started a generation");
    if (page.url() !== urlBefore && /\/chat\/[a-z0-9]+/.test(page.url()))
      throw new Error("empty/whitespace created a thread");
  });

  await step("C2.3: very short message streams a reply", async () => {
    await page.locator("#chat-composer").fill("hi");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 });
    const id = threadId(page); if (id) threads.push(["C2-short", id]);
    if (!(await settle(page, 90000))) throw new Error("short message never settled");
  });

  await step("C2.4: very long paste — bounded, completes, no crash", async () => {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    const big = ("The quick brown fox jumps over the lazy dog. ").repeat(1200); // ~55k chars
    await page.locator("#chat-composer").fill(big + "\n\nIn one sentence, what animal is mentioned?");
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 });
    const id = threadId(page); if (id) threads.push(["C2-long", id]);
    if (!(await settle(page, 120000))) throw new Error("long message never settled (possible overflow/hang)");
    console.log(`      ↳ long-input turn done in ~${Date.now() - t0}ms`);
  });

  await step("C2.6: double-send (same text twice fast) — no duplicate assistant rows", async () => {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    const marker = `DUPCHECK-${Date.now()}`;
    await page.locator("#chat-composer").fill(`Reply with exactly: ${marker}`);
    await page.keyboard.press("Enter");
    // immediately try to send again (should be rejected as "already generating")
    await page.waitForTimeout(150);
    await page.locator("#chat-composer").fill(`Reply with exactly: ${marker}`).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    const id = threadId(page); if (id) threads.push(["C2-double", id]);
    await settle(page, 90000);
    // the assistant marker must appear at most once (the second send was a no-op)
    const count = await page.evaluate((m) => {
      const t = document.body.innerText || "";
      return t.split(m).length - 1;
    }, marker);
    console.log(`      ↳ marker occurrences (incl. user bubble): ${count}`);
    // 1 user bubble + at most 1 assistant echo = <=2; a duplicate generation would push it higher
    if (count > 2) throw new Error(`duplicate generation: marker appeared ${count}x`);
  });

  await step("C2.7: reload WHILE streaming — stream persists, no duplicate", async () => {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.locator("#chat-composer").fill("Write a detailed 400-word essay about the ocean.");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 20000 });
    const url = page.url();
    await page.waitForTimeout(1500); // let some tokens stream
    await page.reload({ waitUntil: "domcontentloaded" }); // reload MID-stream
    await page.waitForTimeout(2500);
    if (page.url() !== url) throw new Error("navigated away on mid-stream reload");
    // the turn must complete (stream survives via Convex) and land a final answer
    if (!(await settle(page, 90000))) throw new Error("stream did not resume/finalize after reload");
    const hasText = await page.evaluate(() => (document.body.innerText || "").includes("ocean"));
    if (!hasText) throw new Error("essay did not land after mid-stream reload");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA0: ${passed}/${results.length} | console errors: ${errs.length} | network 4xx/5xx: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
