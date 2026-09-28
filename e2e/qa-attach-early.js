// Regression: a file attached the instant the chat page loads is uploaded, not
// silently dropped. The composer used to ignore files until the workspace had
// resolved — no chip, no toast, and (measured on the WebSocket) no upload
// mutation at all. Each round reloads /chat, attaches as soon as the file input
// EXISTS, and asserts the chip appears and the chat reference
// (`chat/attachments:attachLibraryFile`, after the Library upload) is sent.
// The chip is removed afterwards, which deletes the attachment and the Library
// file this upload created.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-attach-early.js   (ROUNDS=5 by default)
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const ROUNDS = Number(process.env.ROUNDS || 5);
const { email, password } = account();

(async () => {
  const browser = await chromium.launch({ headless: !!process.env.HEADLESS });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  let registers = 0;
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      if (String(f.payload).includes("chat/attachments:attachLibraryFile")) registers += 1;
    }),
  );

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 30000 });

  let pass = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    const name = `early-${Date.now().toString(36)}-${i}.txt`;
    const before = registers;
    await page.goto(`${BASE}/en/chat`, { waitUntil: "commit" });
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 30000 });
    const t0 = Date.now();
    await input.setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("early") });
    const remove = page.getByRole("button", { name: `Remove ${name}` });
    try {
      await remove.waitFor({ timeout: 5000 });
      const deadline = Date.now() + 30000;
      while (registers === before && Date.now() < deadline) await page.waitForTimeout(100);
      if (registers === before) throw new Error("chip shown but no register mutation was sent");
      await page.waitForTimeout(500); // let the chip take its id before removing it
      await remove.click();
      await remove.waitFor({ state: "detached", timeout: 10000 });
      pass += 1;
      console.log(`PASS  round ${i}: attached as soon as the input existed → chip + register sent (${Date.now() - t0} ms round trip)`);
    } catch (e) {
      console.log(`FAIL  round ${i}: ${String(e.message || e).split("\n")[0]}`);
    }
  }
  console.log(`console errors: ${errors.length}${errors.length ? ` — ${errors[0]}` : ""}`);
  await browser.close();
  const ok = pass === ROUNDS && errors.length === 0;
  console.log(`\n=== ATTACH AT PAGE LOAD: ${pass}/${ROUNDS} rounds, ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
})();
