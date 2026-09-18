const { chromium } = require("playwright");
const { account } = require("./creds");
const BASE = "https://app.ollasuper.com";
const AXE = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
(async () => {
  const who = account();
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "light" });
  await ctx.addInitScript(() => { try { localStorage.setItem("theme", "light"); localStorage.setItem("theme_ts", String(Date.now())); } catch {} });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: "load" });
  await p.waitForTimeout(2500);
  await p.locator('input[type="email"]').first().fill(who.email);
  await p.locator('input[type="password"]').first().fill(who.password);
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
  await p.waitForSelector("#chat-composer", { timeout: 60000 });
  await p.waitForTimeout(2500);

  const rows = p.locator("nav[aria-label=.Conversations.] a, nav[aria-label=.Conversations.] li").first();
  await rows.hover().catch(() => {});
  await p.waitForTimeout(400);
  const ca = p.getByRole("button", { name: "Conversation actions" }).first();
  console.log("conversation actions count:", await ca.count());
  await ca.click({ force: true });
  await p.waitForTimeout(600);
  const ci = p.getByText("Chat instructions", { exact: true }).first();
  console.log("menuitem count:", await ci.count());
  await ci.click({ force: true });
  await p.waitForTimeout(1500);

  await p.addScriptTag({ url: AXE });
  const r = await p.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: ["color-contrast"], resultTypes: ["violations"] });
    const nodes = res.violations.flatMap(v => v.nodes.map(n => ({ t: n.target.join(" "), d: (n.any[0]||{}).data })));
    const dlg = document.querySelector('[role="dialog"]');
    const geo = dlg ? (() => { const r = dlg.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }; })() : null;
    return { nodes, geo };
  });
  console.log("dialog geometry:", JSON.stringify(r.geo));
  console.log("color-contrast nodes:", r.nodes.length);
  for (const n of r.nodes) console.log("  ", n.t.slice(0, 100), JSON.stringify(n.d));
  await b.close();
})();
