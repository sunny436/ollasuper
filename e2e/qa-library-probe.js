// Diagnostic probe for the File Library on a deployed stack (no UI assertions):
// name search through the API, and one download/preview capability fetched
// directly, with every non-2xx the page loads recorded by URL.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-library-probe.js
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = process.env.E2E_CONVEX_URL || `${BASE}/__cvx`;
const SITE = CONVEX.replace("/__cvx", "/__cvx-site");
const { email, password } = account();

async function call(kind, jwt, path, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status !== "error", value: j.value, error: j.errorMessage };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const bad = [];
  page.on("response", (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(/t=[^&]+/, "t=…")}`);
  });
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.goto(`${BASE}/en/library`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name))?.value;
  const ws = (await call("query", jwt, "orgs:myWorkspaces", {})).value?.[0]?._id;
  const all = await call("query", jwt, "library:list", { workspaceId: ws, paginationOpts: { numItems: 50, cursor: null } });
  const rows = all.value?.page ?? [];
  console.log(`list: ${rows.length} rows; first: ${rows.slice(0, 3).map((r) => `${r.name} [${r.kind}/${r.source}/${r.status}]`).join(" | ")}`);
  const probe = rows.find((r) => /^lib-/.test(r.name)) ?? rows[0];
  if (probe) {
    const term = probe.name.replace(/^lib-/, "").replace(/\.[^.]+$/, "");
    for (const q of [probe.name, term, term.slice(0, 4), "lib"]) {
      const s = await call("query", jwt, "library:list", { workspaceId: ws, paginationOpts: { numItems: 50, cursor: null }, search: q });
      console.log(`search ${JSON.stringify(q)} -> ${s.ok ? `${s.value.page.length} hits, includes probe: ${s.value.page.some((r) => r._id === probe._id)}` : `ERROR ${s.error}`}`);
    }
    const m = await call("mutation", jwt, "library:mintAccess", { fileId: probe._id, purpose: "download" });
    if (!m.ok) console.log(`mintAccess: ERROR ${m.error}`);
    else {
      const r = await fetch(`${SITE}/library/file?t=${m.value.token}`);
      console.log(`download ${r.status} type=${r.headers.get("content-type")} disp=${(r.headers.get("content-disposition") || "").slice(0, 40)} corp=${r.headers.get("cross-origin-resource-policy")}`);
    }
  }
  console.log(`non-2xx loads on /library: ${bad.length ? bad.join(" ; ") : "none"}`);
  await browser.close();
})();
