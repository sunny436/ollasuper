// File Library — red-team attacks against a DEPLOYED stack, over the same API
// the browser uses. Account A owns the targets; account B is the attacker.
// Everything this script creates is removed at the end.
//
//   QA_EMAIL=… QA_PASSWORD=… QA_EMAIL_B=… QA_PASSWORD_B=… node qa-library-redteam.js
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = process.env.E2E_CONVEX_URL || `${BASE}/__cvx`;
const SITE = CONVEX.replace("/__cvx", "/__cvx-site");
const A = account();
const B = { email: process.env.QA_EMAIL_B, password: process.env.QA_PASSWORD_B };
if (!B.email || !B.password) throw new Error("set QA_EMAIL_B / QA_PASSWORD_B (a second account)");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function jwtFor(browser, who) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.locator('input[type="email"]').first().fill(who.email);
  await p.locator('input[type="password"]').first().fill(who.password);
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/chat/, { timeout: 30000 });
  const jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name))?.value;
  await ctx.close();
  return jwt;
}

async function call(kind, jwt, path, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status !== "error", value: j.value, error: String(j.errorMessage ?? j.errorData?.message ?? "") };
}

async function upload(jwt, ws, name, contentType, body, declared) {
  const begin = await call("mutation", jwt, "library:beginUpload", {
    workspaceId: ws, name, contentType, size: declared ?? body.length, purpose: "library",
  });
  if (!begin.ok || !begin.value.ok) return { begin };
  const up = await fetch(begin.value.uploadUrl, { method: "POST", headers: { "content-type": contentType }, body });
  const status = up.status;
  const storageId = status === 200 ? (await up.json()).storageId : null;
  if (!storageId) return { begin, status };
  const finish = await call("mutation", jwt, "library:finishUpload", {
    intentId: begin.value.intentId, storageId, name, contentType,
  });
  return { begin, status, storageId, finish };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const jwtA = await jwtFor(browser, A);
  const jwtB = await jwtFor(browser, B);
  const wsA = (await call("query", jwtA, "orgs:myWorkspaces", {})).value[0]._id;
  const wsB = (await call("query", jwtB, "orgs:myWorkspaces", {})).value[0]._id;
  const tag = Date.now().toString(36);
  const created = [];
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f5d8ce0000000049454e44ae426082", "hex");

  // --- targets owned by A
  const secret = await upload(jwtA, wsA, `rt-secret-${tag}.txt`, "text/plain", Buffer.from(`A's secret ${tag}`));
  const secretId = secret.finish?.value?.fileId;
  if (secretId) created.push([jwtA, secretId]);
  check("A can upload a target file", !!secretId);

  // --- B against A's file: every door answers like a missing file
  const g = await call("query", jwtB, "library:get", { fileId: secretId });
  check("B: library.get(A's id) is null", g.ok && g.value === null);
  const lst = await call("query", jwtB, "library:list", {
    workspaceId: wsB, paginationOpts: { numItems: 50, cursor: null }, search: `rt-secret-${tag}`,
  });
  check("B: searching A's file name finds nothing", lst.ok && lst.value.page.length === 0);
  const crossWs = await call("query", jwtB, "library:list", {
    workspaceId: wsA, paginationOpts: { numItems: 50, cursor: null },
  });
  check("B: listing A's workspace is refused", !crossWs.ok, crossWs.error.slice(0, 60));
  for (const [path, args] of [
    ["library:mintAccess", { fileId: secretId, purpose: "download" }],
    ["library:rename", { fileId: secretId, name: "pwned.txt" }],
    ["userFiles:remove", { fileId: secretId }],
    ["chat/attachments:attachLibraryFile", { fileId: secretId, workspaceId: wsB }],
    ["chat/attachments:attachLibraryFile", { fileId: secretId, workspaceId: wsA }],
  ]) {
    const r = await call("mutation", jwtB, path, args);
    check(`B: ${path} on A's file is refused`, !r.ok, r.error.slice(0, 50));
  }
  const rm = await call("mutation", jwtB, "library:removeMany", { fileIds: [secretId] });
  check("B: removeMany(A's id) removes nothing", rm.ok && rm.value.removed === 0);
  const prev = await call("mutation", jwtB, "library:mintPreviews", { fileIds: [secretId] });
  check("B: mintPreviews(A's id) mints nothing", prev.ok && prev.value.length === 0);
  const hexA = await call("query", jwtA, "library:get", { fileId: secretId });
  const shaA = require("node:crypto").createHash("sha256").update(`A's secret ${tag}`).digest("hex");
  const dupB = await call("query", jwtB, "library:findDuplicate", { workspaceId: wsB, sha256: shaA });
  check("B: findDuplicate on A's bytes is not an existence oracle", dupB.ok && dupB.value === null);
  const stillThere = await call("query", jwtA, "library:get", { fileId: secretId });
  check("A's file is untouched after every attack", stillThere.value?.name === `rt-secret-${tag}.txt` && !!hexA.value);

  // --- B cannot finish an upload with A's session or approve deleting A's file
  const beginA = await call("mutation", jwtA, "library:beginUpload", {
    workspaceId: wsA, name: `rt-a-${tag}.txt`, contentType: "text/plain", size: 3, purpose: "library",
  });
  const upA = await fetch(beginA.value.uploadUrl, { method: "POST", headers: { "content-type": "text/plain" }, body: "abc" });
  const sidA = (await upA.json()).storageId;
  const hijack = await call("mutation", jwtB, "library:finishUpload", {
    intentId: beginA.value.intentId, storageId: sidA, name: "x.txt", contentType: "text/plain", approvedDeletions: [secretId],
  });
  check("B: finishing A's upload session is refused", !hijack.ok, hijack.error.slice(0, 40));
  const finA = await call("mutation", jwtA, "library:finishUpload", {
    intentId: beginA.value.intentId, storageId: sidA, name: `rt-a-${tag}.txt`, contentType: "text/plain",
  });
  if (finA.value?.fileId) created.push([jwtA, finA.value.fileId]);
  check("…and A can still finish it afterwards", finA.ok && finA.value?.ok === true);
  const again = await call("mutation", jwtA, "library:finishUpload", {
    intentId: beginA.value.intentId, storageId: sidA, name: `rt-a-${tag}.txt`, contentType: "text/plain",
  });
  check("a retried finish returns the SAME file (idempotent)", again.value?.fileId === finA.value?.fileId);

  // --- capabilities
  const tok = await call("mutation", jwtA, "library:mintAccess", { fileId: secretId, purpose: "download" });
  const dl = await fetch(`${SITE}/library/file?t=${tok.value.token}`);
  const h = Object.fromEntries(dl.headers);
  check(
    "download: attachment, octet-stream, nosniff, no-store, sandbox CSP",
    dl.status === 200 && h["content-type"] === "application/octet-stream" && /^attachment;/.test(h["content-disposition"] || "") &&
      h["x-content-type-options"] === "nosniff" && h["cache-control"] === "no-store" && /sandbox/.test(h["content-security-policy"] || ""),
    `${dl.status} ${h["content-type"]}`,
  );
  const wrongPurpose = await fetch(`${SITE}/library/file?t=${tok.value.token}&p=preview`);
  check("a download token cannot be used as a preview", wrongPurpose.status === 404, String(wrongPurpose.status));
  for (const bad of ["x", "A".repeat(43), `${tok.value.token}x`, "../../etc/passwd", "%00"]) {
    const r = await fetch(`${SITE}/library/file?t=${encodeURIComponent(bad)}`);
    if (r.status !== 404) check(`forged token ${JSON.stringify(bad.slice(0, 12))} → 404`, false, String(r.status));
  }
  check("forged / malformed tokens all 404", true);

  // --- active content never renders
  const fake = await upload(jwtA, wsA, `rt-fake-${tag}.png`, "image/png", Buffer.from("<svg onload=alert(document.domain)>"));
  const fakeId = fake.finish?.value?.fileId;
  if (fakeId) created.push([jwtA, fakeId]);
  const fakePrev = await call("mutation", jwtA, "library:mintPreviews", { fileIds: [fakeId] });
  const fr = fakePrev.value?.[0] ? await fetch(`${SITE}/library/file?t=${fakePrev.value[0].token}&p=preview`) : null;
  check("SVG/HTML named .png never renders inline", fr === null || fr.status === 404, fr ? String(fr.status) : "no preview offered");
  const real = await upload(jwtA, wsA, `rt-real-${tag}.png`, "image/png", PNG);
  const realId = real.finish?.value?.fileId;
  if (realId) created.push([jwtA, realId]);
  const realPrev = await call("mutation", jwtA, "library:mintPreviews", { fileIds: [realId] });
  const rr = await fetch(`${SITE}/library/file?t=${realPrev.value[0].token}&p=preview`);
  check("a real PNG previews inline as image/png", rr.status === 200 && rr.headers.get("content-type") === "image/png", String(rr.status));
  const html = await upload(jwtA, wsA, `rt-html-${tag}.html`, "text/html", Buffer.from("<script>alert(1)</script>"));
  check("an upload DECLARED text/html is refused", !(html.begin.ok && html.begin.value.ok) || !html.finish?.ok,
    (html.begin.error || html.finish?.error || "").slice(0, 60));
  if (html.finish?.value?.fileId) created.push([jwtA, html.finish.value.fileId]);

  // --- size and quota abuse
  const tooBig = await call("mutation", jwtB, "library:beginUpload", {
    workspaceId: wsB, name: "huge.zip", contentType: "application/zip", size: 200 * 1024 * 1024, purpose: "library",
  });
  check("declaring 200 MB is refused up front", !tooBig.ok, tooBig.error.slice(0, 50));
  const lie = await upload(jwtB, wsB, `rt-lie-${tag}.bin`, "application/octet-stream", Buffer.alloc(200_000, 7), 10);
  check("declaring 10 B then sending 200 KB: SIZE_MISMATCH, nothing kept",
    lie.finish?.value?.ok === false && lie.finish.value.code === "SIZE_MISMATCH", lie.finish?.value?.code);
  const beginBig = await call("mutation", jwtB, "library:beginUpload", {
    workspaceId: wsB, name: "stream.zip", contentType: "application/zip", size: 20 * 1024 * 1024, purpose: "library",
  });
  if (beginBig.ok && beginBig.value.ok) {
    // A VALID upload URL, 30 MB streamed chunked (no length): the edge must cut it off.
    const { Readable } = require("node:stream");
    let sent = 0;
    const src = Readable.from((function* () {
      while (sent < 30 * 1024 * 1024) { sent += 1 << 20; yield Buffer.alloc(1 << 20, 1); }
    })());
    let status = "reset";
    try {
      const r = await fetch(beginBig.value.uploadUrl, { method: "POST", headers: { "content-type": "application/zip" }, body: src, duplex: "half" });
      status = r.status;
    } catch { /* the edge closes the socket after its 413 */ }
    check("30 MB chunked to a VALID upload URL is cut off by the edge", status === 413 || status === "reset", String(status));
    await call("mutation", jwtB, "library:abortUpload", { intentId: beginBig.value.intentId });
  }

  // --- names cannot spoof or break headers
  const spoof = await call("mutation", jwtA, "library:rename", { fileId: secretId, name: "inv‮gpj.exe\r\nSet-Cookie: x=1" });
  check("rename strips bidi/CRLF (no header injection)", spoof.ok && !/[‮\r\n]/.test(spoof.value.name), JSON.stringify(spoof.value?.name));
  const t2 = await call("mutation", jwtA, "library:mintAccess", { fileId: secretId, purpose: "download" });
  const d2 = await fetch(`${SITE}/library/file?t=${t2.value.token}`);
  check("no injected header reaches the response", d2.headers.get("set-cookie") === null && !/\r|\n/.test(d2.headers.get("content-disposition") || ""));

  // --- cleanup: everything this run made
  for (const [jwt, id] of created) await call("mutation", jwt, "userFiles:remove", { fileId: id });
  const gone = await call("query", jwtA, "library:get", { fileId: secretId });
  check("cleanup removed the targets", gone.value === null);

  await browser.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n=== LIBRARY RED TEAM: ${pass}/${results.length}, ${pass === results.length ? "PASS" : "FAIL"} ===`);
  process.exit(pass === results.length ? 0 : 1);
})();
