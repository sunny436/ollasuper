// Multi-file JOIN — prod acceptance (headed Chrome on app.ollasuper.com).
//
// The QA report listed this as "NOT TESTED", which read as a missing capability.
// It is not: `ai_data_max_datasets` is 12, `run_sql` registers every loaded dataset
// into DuckDB under its sanitized table name, and the Data skill already documents
// "JOINs across datasets". This script is the evidence that was missing.
//
// TWO FILES, and the answer is only reachable by joining them: orders.csv holds
// rep_id and amount but no rep NAME or region; reps.csv holds the names and regions
// but no amounts. A model that never joins cannot produce the per-region totals, so
// a correct answer IS the proof.
//
// The expected figures are computed here in plain JS from the same fixtures, so the
// assertion is against an independently derived number rather than against whatever
// the model happened to say.
//
//   ADMIN_PASSWORD=... node qa-data-join.js
//   HEADED=1 ADMIN_PASSWORD=... node qa-data-join.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const WAIT_MS = Number(process.env.QA_WAIT_MS || 240000);

const results = [];
const errs = [];
const need = (c, m) => {
  if (!c) throw new Error(m);
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

// ---- fixtures: neither file can answer the question alone -------------------
const REPS = [
  { rep_id: "R1", rep_name: "Alice Chen", region: "North" },
  { rep_id: "R2", rep_name: "Bruno Sala", region: "South" },
  { rep_id: "R3", rep_name: "Chidi Okafor", region: "North" },
  { rep_id: "R4", rep_name: "Dana Petrov", region: "South" },
];
const ORDERS = [
  ["O1", "R1", 1200.5], ["O2", "R2", 890.0], ["O3", "R1", 430.25],
  ["O4", "R3", 2750.75], ["O5", "R4", 615.4], ["O6", "R2", 1310.1],
  ["O7", "R3", 505.0], ["O8", "R1", 980.9], ["O9", "R4", 1450.6],
  ["O10", "R2", 220.35],
];

// The answer, derived here — NOT taken from the model.
const byRegion = {};
const byRep = {};
for (const [, repId, amt] of ORDERS) {
  const rep = REPS.find((r) => r.rep_id === repId);
  byRegion[rep.region] = (byRegion[rep.region] || 0) + amt;
  byRep[rep.rep_name] = (byRep[rep.rep_name] || 0) + amt;
}
const topRegion = Object.entries(byRegion).sort((a, b) => b[1] - a[1])[0];
const topRep = Object.entries(byRep).sort((a, b) => b[1] - a[1])[0];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "join-"));
const repsCsv = path.join(dir, "reps.csv");
const ordersCsv = path.join(dir, "orders.csv");
fs.writeFileSync(
  repsCsv,
  "rep_id,rep_name,region\n" +
    REPS.map((r) => `${r.rep_id},${r.rep_name},${r.region}`).join("\n") + "\n",
);
fs.writeFileSync(
  ordersCsv,
  "order_id,rep_id,amount\n" +
    ORDERS.map((o) => o.join(",")).join("\n") + "\n",
);

/** Does the text contain this number, in any of the ways a model writes it? */
const hasNum = (text, n) => {
  const plain = n.toFixed(2);
  const rounded = Math.round(n).toString();
  const grouped = Math.round(n).toLocaleString("en-US");
  const stripped = text.replace(/,/g, "");
  return (
    stripped.includes(plain) ||
    stripped.includes(plain.replace(/\.00$/, "")) ||
    stripped.includes(rounded) ||
    text.includes(grouped)
  );
};

const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  const d = Date.now() + ms;
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(700);
  await page.waitForTimeout(1200);
};
const lastMsg = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    const pill = last?.querySelector("[data-agent-activity]");
    return {
      text: last?.innerText || "",
      pill: pill ? pill.innerText.replace(/\s+/g, " ").trim() : "",
    };
  });

(async () => {
  console.log(`expected — top region ${topRegion[0]} ${topRegion[1].toFixed(2)}`);
  console.log(`expected — top rep    ${topRep[0]} ${topRep[1].toFixed(2)}\n`);

  const b = await chromium.launch({
    headless: process.env.HEADED !== "1" && !!process.env.CI,
    slowMo: 20,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  await step("[JOIN] two files in one turn → per-region totals", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    // BOTH files on the same message — this is the case that was never exercised.
    await page.locator('input[type="file"]').setInputFiles([ordersCsv, repsCsv]);
    await page.waitForTimeout(6000);
    await page
      .locator("#chat-composer")
      .fill(
        "These two files are related by rep_id. Join them and give me total " +
          "order amount by REGION, plus which region is highest. Show the numbers.",
      );
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    await settle(page, WAIT_MS);
    const r = await lastMsg(page);
    console.log(`\n---- [JOIN] pill:${r.pill}\n${r.text}\n---- END ----\n`);

    need(/north/i.test(r.text) && /south/i.test(r.text), "regions absent — did not join");
    for (const [region, total] of Object.entries(byRegion)) {
      need(hasNum(r.text, total), `${region} total ${total.toFixed(2)} not reported`);
    }
    need(
      new RegExp(topRegion[0], "i").test(r.text),
      `did not identify ${topRegion[0]} as highest`,
    );
  });

  await step("[JOIN] follow-up drills to a rep name, no re-upload", async () => {
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
    await page
      .locator("#chat-composer")
      .fill("Which individual rep sold the most, and how much?");
    await page.keyboard.press("Enter");
    await settle(page, WAIT_MS);
    const r = await lastMsg(page);
    console.log(`\n---- [TOP REP]\n${r.text}\n---- END ----\n`);
    // rep_name lives ONLY in reps.csv and amount ONLY in orders.csv, so naming the
    // right person with the right total is unforgeable without a join.
    need(
      new RegExp(topRep[0].split(" ")[0], "i").test(r.text),
      `did not name ${topRep[0]}`,
    );
    need(hasNum(r.text, topRep[1]), `wrong/absent total for ${topRep[0]}`);
    need(
      !/upload|attach|provide the (file|data|dataset)/i.test(r.text.slice(0, 300)),
      "asked to re-upload on a follow-up",
    );
  });

  const uniq = [...new Set(errs)].filter(
    (e) => !/chromestatus|favicon|Failed to load resource/.test(e),
  );
  const passed = results.filter(Boolean).length;
  console.log(`\nconsole errors: ${uniq.length}`);
  for (const e of uniq.slice(0, 5)) console.log("  " + e);
  console.log(`RESULT ${passed}/${results.length}`);
  await b.close();
  process.exit(passed === results.length && uniq.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("SCRIPT ERROR:", e.message);
  process.exit(1);
});
