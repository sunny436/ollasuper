// Headed prod check for the scroll fix. Overflow is guaranteed by accumulating
// several turns (independent of model reply length); scroll-up-not-yanked is
// then tested during a final streaming reply.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = "admin@myos.test", PASSWORD = require("./creds").adminPassword();
const errs = [];
const SCROLLER = `[...document.querySelectorAll("div")].find(d => getComputedStyle(d).overflowY === "auto" && (d.className||"").includes("overscroll-contain") && !d.closest("nav"))`;
const settle = async (page, ms=60000) => { const s=page.getByRole("button",{name:"Stop generating"}); const dl=Date.now()+ms; while(Date.now()<dl){ if((await s.count())===0) return; await page.waitForTimeout(300);} };
(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 30 });
  const page = await (await b.newContext({ viewport: { width: 1100, height: 620 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  let pass=0, fail=0;
  const check=(n,ok,info)=>{console.log((ok?"PASS  ":"FAIL  ")+n+(info?"  ("+info+")":""));ok?pass++:fail++;};
  const dims=()=>page.evaluate((S)=>{const el=eval(S);return el?{sh:el.scrollHeight,ch:el.clientHeight,top:el.scrollTop}:null;},SCROLLER);

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Accumulate turns to guarantee the transcript overflows.
  for (let i = 0; i < 6; i++) {
    await settle(page);
    await page.locator("#chat-composer").fill(`Turn ${i}: reply with a short sentence about the number ${i}.`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await settle(page, 60000);
  }
  let d = await dims();
  check("transcript overflows after several turns", d && d.sh > d.ch + 400, d ? `sh=${d.sh} ch=${d.ch}` : "no scroller");

  // Start a final streaming reply, then scroll up mid-stream.
  await page.locator("#chat-composer").fill("Write a detailed multi-paragraph essay about the ocean, about 400 words.");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 20000 }).catch(()=>{});
  await page.waitForTimeout(800);
  await page.evaluate((S)=>{const el=eval(S);el.scrollTop=el.scrollHeight-el.clientHeight-300;el.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:-300}));},SCROLLER);
  await page.waitForTimeout(2500); // many token frames — the old bug snapped back each one
  const d1 = await dims();
  check("NOT yanked back to bottom while streaming", d1 && (d1.sh-d1.top-d1.ch) > 150, d1?`dist=${Math.round(d1.sh-d1.top-d1.ch)}px`:"no scroller");

  // Return to bottom → auto-follow resumes (dist stays ~0 as more tokens arrive).
  await page.evaluate((S)=>{const el=eval(S);el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event("scroll",{bubbles:true}));},SCROLLER);
  await page.waitForTimeout(2500);
  const d2 = await dims();
  check("auto-follow RESUMES after returning to bottom", d2 && (d2.sh-d2.top-d2.ch) < 120, d2?`dist=${Math.round(d2.sh-d2.top-d2.ch)}px`:"no scroller");

  const stop = page.getByRole("button", { name: "Stop generating" });
  if (await stop.count()) await stop.click().catch(()=>{});
  check("zero console errors", errs.length === 0, errs.slice(0,3).join(" | "));
  console.log(`\n===== SCROLL: ${pass}/${pass+fail} | console errors: ${errs.length} =====`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
