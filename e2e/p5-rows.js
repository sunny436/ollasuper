// Why does hovering a task row time out? Observe, do not guess.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 30 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const all = page.locator("div.group");
  console.log(`div.group total: ${await all.count()}`);
  const rows = all.filter({
    has: page.getByRole("button", { name: "Task actions" }),
  });
  const n = await rows.count();
  console.log(`rows with a Task actions button: ${n}`);
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    const box = await r.boundingBox();
    const txt = (await r.innerText()).replace(/\n/g, " | ").slice(0, 70);
    console.log(
      `  [${i}] visible=${await r.isVisible()} box=${box ? `${Math.round(box.width)}x${Math.round(box.height)}@${Math.round(box.y)}` : "null"}  ${txt}`,
    );
  }

  // What is on top at the first row's centre? A transparent overlay would make
  // hover time out while the element itself looks perfectly fine.
  if (n > 0) {
    const box = await rows.first().boundingBox();
    if (box) {
      const top = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return "none";
          const path = [];
          let cur = el;
          for (let i = 0; i < 4 && cur; i++) {
            path.push(
              `${cur.tagName}.${(cur.className || "").toString().split(" ").slice(0, 3).join(".")}`,
            );
            cur = cur.parentElement;
          }
          return path.join(" < ");
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      console.log(`\nelementFromPoint at row 0 centre:\n  ${top}`);
    }
    console.log("\nattempting hover with a 8s budget…");
    try {
      await rows.first().hover({ timeout: 8000 });
      console.log("  hover OK");
    } catch (e) {
      console.log("  hover FAILED: " + e.message.split("\n")[0]);
    }
  }
  await b.close();
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
