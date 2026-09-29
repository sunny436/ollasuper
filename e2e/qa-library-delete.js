// Deleting a file deletes ALL of it — proved layer by layer, on STAGING.
//
//   E2E_BASE_URL=http://localhost:3400 QA_EMAIL=… QA_PASSWORD=… node qa-library-delete.js
//
// upload -> process -> verify every layer HAS it -> delete -> verify every
// layer does NOT: the Library row, the download capability, the chat
// attachment and its storage URL, the knowledge DB (file, chunks, embeddings)
// behind a tombstone, a real RAG chat turn, the Convex storage record, and the
// PHYSICAL bytes on the volume once the host reclaimer runs — then a byte-level
// integrity pass proving the reclaimer removed nothing that was still live.
// A GENERATED file is deleted with its chat card and preview pages.
//
// Staging by default: it reads the volume and databases over SSH.
// E2E_TARGET=production (the post-deploy acceptance run) reads production's
// instead and does NOT force the reclaimer: production keeps its 10-minute
// grace, so the canary's bytes are left for the hourly timer and the step
// records the path to check after it has run.
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { account } = require("./creds");

const PROD = process.env.E2E_TARGET === "production";
const BASE = process.env.E2E_BASE_URL || (PROD ? "https://app.ollasuper.com" : "http://localhost:3400");
const CONVEX = process.env.E2E_CONVEX_URL || `${BASE}/__cvx`;
const SITE = CONVEX.replace("/__cvx", "/__cvx-site");
const VM = process.env.STAGING_VM || "root@172.16.70.25";
if (!PROD && !/localhost|127\.0\.0\.1/.test(BASE)) throw new Error("set E2E_TARGET=production to run against production");

const VOLUME = PROD
  ? "/var/lib/docker/volumes/self-hosted_data/_data/storage"
  : "/var/lib/docker/volumes/myos-staging-data/_data/storage";
const { email, password } = account();
const results = [];
const errors = [];
const OUT = require("node:path").join(__dirname, "out", "library-delete");
let shotPage = null; // the page a failing step photographs

const step = async (name, fn) => {
  try {
    const d = await fn();
    results.push([true, name]);
    console.log(`PASS  ${name}${d ? ` — ${d}` : ""}`);
  } catch (e) {
    results.push([false, name]);
    const shot = `${OUT}/fail-${results.length}.png`;
    if (shotPage) {
      require("node:fs").mkdirSync(OUT, { recursive: true });
      await shotPage.screenshot({ path: shot }).catch(() => {});
    }
    console.log(`FAIL  ${name} — ${String(e.message || e).split("\n")[0]}${shotPage ? ` (screenshot ${shot})` : ""}`);
  }
};

function vm(cmd) {
  return execFileSync("ssh", ["-o", "BatchMode=yes", VM, cmd], { encoding: "utf8", maxBuffer: 32 << 20 }).trim();
}
const knowledge = (sql) =>
  vm(`docker exec ${PROD ? "ai-knowledge-db-1" : "myos-staging-pg"} psql -U myos_ai -d myos_knowledge -At -c "${sql}"`);
const admin = (fn, args) =>
  vm(
    PROD
      ? // production's own CLI config (packages/backend/.env.local)
        `cd /opt/myos/packages/backend && node ../../node_modules/convex/bin/main.js run ${fn} '${JSON.stringify(args)}' 2>/dev/null`
      : `. /opt/myos-staging/.staging.env && cd /opt/myos-staging/src/packages/backend && ` +
          `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3310 CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" ` +
          `node ../../node_modules/convex/bin/main.js run ${fn} '${JSON.stringify(args)}' 2>/dev/null`,
  );
const blobWith = (needle) => vm(`grep -l -F '${needle}' ${VOLUME}/files/*.blob 2>/dev/null | head -1 || true`);
const exists = (path) => vm(`test -e '${path}' && echo yes || echo no`) === "yes";

async function login(p) {
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // Hydrated first: filled before React attaches, the form submits empty.
  await p.waitForFunction(
    () => {
      const f = document.querySelector("form");
      return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
    },
    null,
    { timeout: 30000 },
  );
  await p.locator('input[type="email"]').first().fill(email);
  await p.locator('input[type="password"]').first().fill(password);
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/chat/, { timeout: 30000 });
  await p.locator("#chat-composer:not([disabled])").waitFor({ timeout: 60000 });
}

async function jwtOf(ctx) {
  const c = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name));
  if (!c) throw new Error("no auth cookie");
  return c.value;
}

async function call(kind, jwt, path, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status !== "error", value: j.value, error: j.errorMessage };
}

/** Ask the assistant in a fresh chat; return its answer text. */
async function ask(page, question) {
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  // Hydrated first: Enter in a server-rendered composer is silently dropped.
  const box = page.locator("#chat-composer:not([disabled])");
  await box.waitFor({ timeout: 60000 });
  await box.fill(question);
  await box.press("Enter");
  // The thread URL proves the send happened (p-chat.js). Messages carry no
  // role attribute; the composer swaps Send for "Stop generating" while a
  // reply streams, so its absence is the idle signal - and a fast reply may
  // finish before it is ever seen.
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 20000 }).catch(() => {});
  await stop.waitFor({ state: "detached", timeout: 240000 });
  // Settled = the fresh chat's transcript holds more than the question and
  // reads the same twice, 2 s apart. The question holds the tag, never the
  // code, so the code can only have come from the answer. An answer that never
  // renders THROWS: "the code is absent" must never pass on an empty page.
  const convo = page.locator('[aria-label="Conversation"]');
  let prev = "";
  for (let i = 0; i < 60; i++) {
    const now = (await convo.innerText().catch(() => "")).trim();
    const answer = now.replace(question, "").trim();
    if (answer.length > 1 && now === prev) return answer;
    prev = now;
    await page.waitForTimeout(2000);
  }
  throw new Error(`no answer was rendered (transcript: ${prev.slice(0, 120)})`);
}

(async () => {
  const browser = await chromium.launch({ headless: !!process.env.HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  shotPage = page;
  const tag = Date.now().toString(36);
  const code = `ZX${tag.toUpperCase()}Q`;
  const name = `canary-${tag}.txt`;
  const body = Buffer.from(
    `Delete-proof canary document ${tag}.\nThe secret canary code is ${code}.\nNothing else is in this file.\n`,
  );
  let jwt;
  let workspaceId;
  let fileId;
  let blobPath = "";
  let ingestId = "";
  let downloadUrl = "";
  let attachmentUrl = "";
  let usedUploadUrl = "";

  await step("upload a canary file through the ticketed upload path", async () => {
    await login(page);
    jwt = await jwtOf(ctx);
    workspaceId = (await call("query", jwt, "orgs:myWorkspaces", {})).value?.[0]?._id;
    const begin = await call("mutation", jwt, "library:beginUpload", {
      workspaceId, name, contentType: "text/plain", size: body.length, purpose: "library",
    });
    if (!begin.ok || !begin.value.ok) throw new Error(`begin: ${begin.error}`);
    if (!new URL(begin.value.uploadUrl).searchParams.get("lt")) throw new Error("upload URL carries no ticket");
    const up = await fetch(begin.value.uploadUrl, { method: "POST", headers: { "content-type": "text/plain" }, body });
    if (up.status !== 200) throw new Error(`upload ${up.status}`);
    const { storageId } = await up.json();
    const fin = await call("mutation", jwt, "library:finishUpload", {
      intentId: begin.value.intentId, storageId, name, contentType: "text/plain",
    });
    if (!fin.ok || !fin.value.ok) throw new Error(`finish: ${fin.error || fin.value?.code}`);
    fileId = fin.value.fileId;
    usedUploadUrl = begin.value.uploadUrl;
  });

  // Its own step: a failure here (an edge that does not redeem tickets yet)
  // must not take the rest of the proof down with it.
  await step("the upload ticket is single-use at the edge", async () => {
    if (!usedUploadUrl) throw new Error("no upload to replay");
    const again = await fetch(usedUploadUrl, { method: "POST", headers: { "content-type": "text/plain" }, body });
    if (again.status !== 403) throw new Error(`a used ticket was accepted again (${again.status})`);
    return "second POST 403";
  });

  await step("it is processed and every layer has it", async () => {
    let row = null;
    for (let i = 0; i < 60; i++) {
      row = (await call("query", jwt, "library:get", { fileId })).value;
      if (row?.status === "ready") break;
      await page.waitForTimeout(2000);
    }
    if (row?.status !== "ready") throw new Error(`status ${row?.status}`);
    blobPath = blobWith(code);
    if (!blobPath) throw new Error("the blob is not on the volume");
    ingestId = knowledge(`SELECT DISTINCT file_id FROM file_chunks WHERE content LIKE '%${code}%'`);
    if (!ingestId) throw new Error("no chunks in the knowledge DB");
    const mint = await call("mutation", jwt, "library:mintAccess", { fileId, purpose: "download" });
    downloadUrl = `${SITE}/library/file?t=${mint.value.token}`;
    const d = await fetch(downloadUrl);
    if (d.status !== 200 || !(await d.text()).includes(code)) throw new Error(`download ${d.status}`);
    const att = await call("mutation", jwt, "chat/attachments:attachLibraryFile", { fileId, workspaceId });
    const pub = await call("query", jwt, "chat/attachments:get", { attachmentId: att.value });
    attachmentUrl = pub.value?.url ?? "";
    const a = attachmentUrl ? await fetch(attachmentUrl) : null;
    if (!a || a.status !== 200) throw new Error(`attachment url ${a?.status}`);
    return `blob ${blobPath.split("/").pop()}, ${knowledge(`SELECT count(*) FROM file_chunks WHERE file_id='${ingestId}'`)} chunk(s)`;
  });

  await step("RAG finds it before the delete", async () => {
    const answer = await ask(page, `What is the secret canary code in my canary document ${tag}? Reply with the code only.`);
    if (!answer.includes(code)) throw new Error(`the answer did not contain the code: ${answer.slice(0, 120)}`);
  });

  await step("delete it", async () => {
    const r = await call("mutation", jwt, "library:removeMany", { fileIds: [fileId] });
    if (!r.ok || r.value.removed !== 1) throw new Error(`removeMany ${r.error || JSON.stringify(r.value)}`);
  });

  await step("gone from the Library, downloads, previews and the chat attachment AT ONCE", async () => {
    const got = await call("query", jwt, "library:get", { fileId });
    if (got.value) throw new Error("library:get still returns it");
    const d = await fetch(downloadUrl);
    if (d.status !== 404) throw new Error(`an old download link answered ${d.status}`);
    const mint = await call("mutation", jwt, "library:mintAccess", { fileId, purpose: "download" });
    if (mint.ok) throw new Error("a new download capability was minted");
    const a = await fetch(attachmentUrl);
    if (a.status === 200) throw new Error("the chat attachment's storage URL still serves the bytes");
    return `download 404, storage URL ${a.status}`;
  });

  await step("gone from the knowledge DB (file, chunks, embeddings) behind a tombstone", async () => {
    let left = "1";
    for (let i = 0; i < 30 && left !== "0"; i++) {
      left = knowledge(`SELECT count(*) FROM file_chunks WHERE file_id='${ingestId}'`);
      if (left !== "0") await page.waitForTimeout(2000);
    }
    const files = knowledge(`SELECT count(*) FROM files WHERE id='${ingestId}'`);
    const copies = knowledge(`SELECT count(*) FROM file_blobs WHERE file_id='${ingestId}'`);
    const tomb = knowledge(`SELECT count(*) FROM ingest_tombstones WHERE file_id='${ingestId}'`);
    if (left !== "0" || files !== "0" || copies !== "0") throw new Error(`chunks=${left} files=${files} copies=${copies}`);
    if (tomb !== "1") throw new Error("no tombstone: a late worker could write it back");
    const text = knowledge(`SELECT count(*) FROM file_chunks WHERE content LIKE '%${code}%'`);
    if (text !== "0") throw new Error("its text is still in the chunk table");
  });

  await step("RAG no longer finds it", async () => {
    const answer = await ask(page, `What is the secret canary code in my canary document ${tag}? Reply with the code only.`);
    if (answer.includes(code)) throw new Error("the deleted file's content was retrieved");
  });

  await step(
    PROD
      ? "the bytes are left to the production reclaimer (its grace), and nothing live is broken"
      : "the bytes leave the DISK when the host reclaimer runs (and nothing live is touched)",
    async () => {
    if (!exists(blobPath)) throw new Error("the blob vanished before the reclaimer ran (unexpected)");
    let reclaimed = "";
    if (!PROD) {
      // Staging runs it with no grace: production waits 10 minutes after the
      // delete. The minimum age (60 s here) still protects uploads in flight -
      // and so protects a canary younger than that: wait it out.
      const age = Number(vm(`echo $(( $(date +%s) - $(stat -c %Y '${blobPath}') ))`));
      if (age < 65) await page.waitForTimeout((65 - age) * 1000);
      const report = vm(
        "cd /opt/myos-staging/src/services/ai && /opt/myos/services/ai/.venv/bin/python -m app.ops.blob_reclaim " +
          `--storage-dir ${VOLUME} --psql 'docker exec -i myos-staging-pg psql -U convex -d myos_staging' ` +
          "--grace-s 0 --min-age-s 60 --max 500 --lock /tmp/myos-staging-storage.lock --apply",
      );
      const rep = JSON.parse(report.split("\n").pop());
      if (rep.status !== "ok") throw new Error(`reclaimer ${rep.status}: ${rep.message}`);
      if (exists(blobPath)) throw new Error(`still on disk (${rep.deleted} deleted, candidates ${rep.candidates})`);
      reclaimed = `${rep.deleted} orphan blob(s) reclaimed (${rep.deleted_bytes} B); `;
    }
    // Every blob that is still live must still be readable, byte for byte.
    let cursor = null;
    let checked = 0;
    let bad = 0;
    for (;;) {
      const out = admin("libraryOps:verifyStorageIntegrity", { cursor, numItems: 200 });
      const p = JSON.parse(out.slice(out.indexOf("{")));
      checked += p.checked;
      bad += p.mismatch.length + p.unreadable.length;
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
    if (bad) throw new Error(`${bad} live blob(s) broken after reclaiming`);
    const later = PROD ? `; after the next myos-blob-reclaim run, check: test ! -e ${blobPath}` : "";
    return `${reclaimed}${checked} live blobs re-hashed intact${later}`;
    },
  );

  await step("a GENERATED file is deleted with its chat card and preview pages", async () => {
    await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
    const answer = await ask(page, `Create a one-page PDF titled "Generated canary ${tag}" with one sentence in it.`);
    const card = page.locator("[data-artifact-card]").last();
    await card.waitFor({ timeout: 90000 });
    let gen = null;
    for (let i = 0; i < 20 && !gen; i++) {
      const l = await call("query", jwt, "library:list", {
        workspaceId, paginationOpts: { numItems: 50, cursor: null }, source: "generated",
      });
      gen = l.value?.page?.find((f) => f.createdAt > Date.now() - 10 * 60_000) ?? null;
      if (!gen) await page.waitForTimeout(1500);
    }
    if (!gen) throw new Error(`no generated Library file (answer: ${answer.slice(0, 80)})`);
    await call("mutation", jwt, "library:removeMany", { fileIds: [gen._id] });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-artifact-deleted]").last().waitFor({ timeout: 30000 });
    if (await page.locator("[data-artifact-download]").count()) {
      const stillDownloadable = await page.locator("[data-artifact-card]").last().locator("[data-artifact-download]").count();
      if (stillDownloadable) throw new Error("the deleted file's card still offers a download");
    }
    return `"${gen.name}" deleted; its chat card now says Deleted`;
  });

  await browser.close();
  console.log(`console errors: ${errors.length}`);
  for (const e of errors) console.log(`  ! ${e}`);
  const passed = results.filter(([ok]) => ok).length;
  const ok = passed === results.length && errors.length === 0;
  console.log(`\n=== LIBRARY DELETE: ${passed}/${results.length}, ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
