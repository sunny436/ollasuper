// The Convex half of the restore drill (called by verify-restore.sh).
//
// Pages through three proofs on the STAGING deployment, each one a Convex
// function run with the staging admin key:
//   1. every stored blob hashes to its record (libraryOps.verifyStorageIntegrity);
//   2. every Library row's blob exists (libraryOps.libraryRowsPage);
//   3. every knowledge-DB file id (given on stdin) is owned by a Convex file
//      (libraryProcessing.unknownIngestIds).
// Prints one JSON object. Exit 0 = all three hold.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SRC = process.env.SRC;
const CLI = `${SRC}/node_modules/convex/bin/main.js`;

function lastJson(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trimStart().startsWith("{") && !lines[i].trimStart().startsWith("[")) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // keep walking back to the start of the final JSON value
    }
  }
  throw new Error(`no JSON in output: ${text.slice(-400)}`);
}

function run(fn, args) {
  const r = spawnSync("node", [CLI, "run", fn, JSON.stringify(args)], {
    cwd: `${SRC}/packages/backend`,
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${process.env.CVX_PORT}`,
      CONVEX_SELF_HOSTED_ADMIN_KEY: process.env.ADMIN_KEY,
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`${fn} failed: ${r.stderr.slice(-600)}`);
  return lastJson(r.stdout);
}

const out = { blobs: { checked: 0, ok: 0, mismatch: [], unreadable: [], bytes: 0 }, rows: { rows: 0, missing: [] }, knowledge: { checked: 0, unowned: [] } };

let cursor = null;
for (;;) {
  const p = run("libraryOps:verifyStorageIntegrity", { cursor, numItems: 100 });
  out.blobs.checked += p.checked;
  out.blobs.ok += p.ok;
  out.blobs.bytes += p.bytes;
  out.blobs.mismatch.push(...p.mismatch);
  out.blobs.unreadable.push(...p.unreadable);
  if (p.isDone) break;
  cursor = p.continueCursor;
}

cursor = null;
for (;;) {
  const p = run("libraryOps:libraryRowsPage", { cursor, numItems: 200 });
  out.rows.rows += p.rows;
  out.rows.missing.push(...p.missing);
  if (p.isDone) break;
  cursor = p.continueCursor;
}

const ids = readFileSync(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
for (let i = 0; i < ids.length; i += 400) {
  const batch = ids.slice(i, i + 400);
  out.knowledge.checked += batch.length;
  out.knowledge.unowned.push(...run("libraryProcessing:unknownIngestIds", { ids: batch }));
}

out.ok =
  out.blobs.mismatch.length === 0 &&
  out.blobs.unreadable.length === 0 &&
  out.rows.missing.length === 0 &&
  out.knowledge.unowned.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
