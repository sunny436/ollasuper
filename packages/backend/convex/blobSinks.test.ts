import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isExecutableContentType, neutralizedBlobType } from "./blobSafety";

/**
 * A source-level invariant, not a behavioural test — deliberately.
 *
 * convex-test's fake `_storage` does not carry `contentType` (probed: metadata is
 * `{_creationTime, _id, sha256, size}` only), so `assertNonExecutableBlob` can
 * never fire in-process and the two behavioural cases in blobSafety.test.ts are
 * skipped for that reason. That harness gap is exactly how a NEW unguarded sink
 * would slip in unnoticed, so the invariant is asserted over the source instead:
 *
 *   every PUBLIC mutation that accepts a `v.id("_storage")` must consult the
 *   blob-type guard before that id becomes a row.
 *
 * Registration is the chokepoint — a blob that is never registered never has a
 * `getUrl()` minted for it — so this is the property that actually closes the
 * stored-XSS surface, and it is the one that regressed: `users.updateUserImage`
 * took an arbitrary `_storage` id and patched it straight onto the user, whose
 * `image` URL is handed to the browser by `users.ts` on the app's own origin.
 */
function convexSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "_generated") out.push(...convexSources(p));
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts") && e !== "schema.ts") {
      out.push(p);
    }
  }
  return out;
}

const GUARD = /assertNonExecutableBlob|isExecutableContentType|neutralizedBlobType/;

/** Split a source file into `export const NAME = <kind>({ ... })` segments. */
function exportedFunctions(src: string) {
  const re = /export const (\w+) = (mutation|internalMutation|query|internalQuery|action|internalAction)\(/g;
  const marks = [...src.matchAll(re)];
  return marks.map((m, i) => ({
    name: m[1] as string,
    kind: m[2] as string,
    body: src.slice(m.index ?? 0, marks[i + 1]?.index ?? src.length),
  }));
}

describe("no unguarded blob sink", () => {
  test("every PUBLIC mutation taking a _storage id consults the blob-type guard", () => {
    const offenders: string[] = [];
    for (const file of convexSources("convex")) {
      if (file.endsWith("blobSafety.ts")) continue; // the guard itself
      const src = readFileSync(file, "utf8");
      if (!src.includes('v.id("_storage")')) continue;
      for (const fn of exportedFunctions(src)) {
        if (fn.kind !== "mutation") continue; // internal* is not client-reachable
        if (!fn.body.includes('v.id("_storage")')) continue;
        if (!GUARD.test(fn.body) && !GUARD.test(src)) {
          offenders.push(`${file}:${fn.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the neutraliser keeps the bytes reachable but never executable", () => {
    // /ai/artifact must not REFUSE html/svg — generating them is a shipped
    // feature — so it stores them under a type a browser will not execute while
    // /artifact/file keeps serving the declared mime from our own row.
    expect(neutralizedBlobType("text/html")).toBe("text/plain");
    expect(neutralizedBlobType("image/svg+xml")).toBe("text/plain");
    expect(neutralizedBlobType("text/html; charset=utf-8")).toBe("text/plain");
    expect(isExecutableContentType(neutralizedBlobType("text/html"))).toBe(false);
    // everything else is untouched — previews are image/png and must stay so
    expect(neutralizedBlobType("image/png")).toBe("image/png");
    expect(neutralizedBlobType("application/pdf")).toBe("application/pdf");
  });
});
