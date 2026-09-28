// Headed: a plain (non-processable) upload on the Library goes through
// library.beginUpload → POST → library.finishUpload and is stored as-is.
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = "https://app.ollasuper.com";
const { email, password } = account();

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.goto(`${BASE}/en/library`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000); // the workspace resolves before uploads are accepted
  const name = `stored-${Date.now().toString(36)}.bin`;
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3]) });
  const outcome = await Promise.race([
    page.getByText(`Added ${name}`).first().waitFor({ timeout: 30000 }).then(() => "uploaded"),
    page.getByText("Upload failed").first().waitFor({ timeout: 30000 }).then(() => "FAILED"),
  ]).catch(() => "no toast");
  console.log(`files upload: ${outcome} (${name}); console errors: ${errors.length}`);
  for (const e of errors) console.log("  " + e);
  await browser.close();
  process.exit(outcome === "uploaded" && errors.length === 0 ? 0 : 1);
})();
