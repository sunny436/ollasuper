// Run one File Library migration to completion, page by page.
//
//   node deploy/library-migrate.mjs <module:function> [--apply] [--raw] [--arg k=v ...]
//
// DRY RUN unless --apply (every migration takes `dryRun`, default true). Pages
// with the returned `continueCursor` until `isDone`, and prints each page's
// result plus a final summary as JSON lines. Talks to whichever deployment
// CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY name — set them
// explicitly; the script refuses to run without both, so it can never fall
// back to a .env.local that points somewhere else.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.SRC ?? join(here, "..");
const [fn, ...rest] = process.argv.slice(2);
if (!fn || !fn.includes(":")) {
  console.error("usage: library-migrate.mjs <module:function> [--apply] [--arg k=v ...]");
  process.exit(2);
}
if (!process.env.CONVEX_SELF_HOSTED_URL || !process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
  console.error("set CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY explicitly");
  process.exit(2);
}
const apply = rest.includes("--apply");
// --raw: a one-shot operator function with no dryRun/cursor (e.g. verifyFold).
const raw = rest.includes("--raw");
const extra = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== "--arg") continue;
  const [k, ...v] = String(rest[++i]).split("=");
  const raw = v.join("=");
  try {
    extra[k] = JSON.parse(raw);
  } catch {
    extra[k] = raw;
  }
}

function lastJson(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trimStart();
    if (!t.startsWith("{") && !t.startsWith("[") && t !== "null") continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // walk back to the start of the final JSON value
    }
  }
  throw new Error(`no JSON result in: ${text.slice(-400)}`);
}

let cursor = null;
let pages = 0;
for (;;) {
  const args = raw ? extra : { ...extra, dryRun: !apply, ...(cursor ? { cursor } : {}) };
  const r = spawnSync("node", [join(repo, "node_modules/convex/bin/main.js"), "run", fn, JSON.stringify(args)], {
    cwd: join(repo, "packages/backend"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(r.stderr.slice(-1500));
    process.exit(1);
  }
  const res = lastJson(r.stdout);
  pages++;
  console.log(JSON.stringify({ fn, apply, page: pages, result: res }));
  if (!res || typeof res !== "object" || res.isDone !== false || !res.continueCursor) break;
  cursor = res.continueCursor;
}
console.log(JSON.stringify({ fn, apply, pages, done: true }));
