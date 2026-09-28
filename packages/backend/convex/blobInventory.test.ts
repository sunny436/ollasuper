import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The blob REFERENCE INVENTORY, pinned. Two things depend on it being complete:
 * reference-aware deletion (`blobReferenced` — never delete bytes another row
 * still points at, audit F-01) and `authDeletion.reconcileOrphanBlobs`, which
 * deletes stored bytes nothing references (audit F-12). A sweep is exactly as
 * safe as its inventory: a new table that starts holding storage ids without
 * being added to `blobReferenced` would have its files swept as orphans.
 *
 * So each place bytes can be referenced or created is listed here, and this
 * test fails the moment the code grows one that is not. Extending the list is
 * the right fix only after `blobReferenced` (and, for ids stored inside JSON,
 * `sharedBlobIds`) covers the new place.
 */
function convexSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "_generated") out.push(...convexSources(p));
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}
const rel = (p: string) => p.replace(/\\/g, "/").replace(/^.*?convex\//, "");

/** table.field for every `v.id("_storage")` column in the schema. */
function storageColumns(): string[] {
  const src = readFileSync(join(__dirname, "schema.ts"), "utf8");
  const out: string[] = [];
  let table = "";
  for (const line of src.split("\n")) {
    const t = /^ {2}(\w+): defineTable\(/.exec(line);
    if (t) table = t[1] as string;
    const f = /^\s+(\w+): v\.(?:optional\()?v?\.?id\("_storage"\)/.exec(line);
    if (f) out.push(`${table}.${f[1]}`);
  }
  return out.sort();
}

describe("blob reference inventory (F-01 deletion, F-12 orphan sweep)", () => {
  test("storage-id columns are exactly the ones blobReferenced checks", () => {
    expect(storageColumns()).toEqual([
      "chatArtifacts.storageId",
      "chatAttachments.storageId",
      "files.storageId",
      "userFiles.storageId",
      "users.imageId",
    ]);
    const blob = readFileSync(join(__dirname, "blobOwnership.ts"), "utf8");
    const fn = blob.slice(blob.indexOf("export async function blobReferenced"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    for (const table of ["files", "userFiles", "chatAttachments", "chatArtifacts", "users"]) {
      expect(body, `blobReferenced must check ${table}`).toContain(`.query("${table}")`);
    }
  });

  test("the only storage ids kept inside JSON are share snapshots, which the sweep reads", () => {
    const schema = readFileSync(join(__dirname, "schema.ts"), "utf8");
    // The schema documents every JSON field that carries storage ids.
    const jsonHolders = schema
      .split("\n")
      .filter((l) => /storageIds? live here/i.test(l));
    expect(jsonHolders).toHaveLength(1);
    const deletion = readFileSync(join(__dirname, "authDeletion.ts"), "utf8");
    expect(deletion).toContain('ctx.db.query("chatShares")');
  });

  test("every place that creates stored bytes is known", () => {
    const creators = convexSources(__dirname)
      .filter((p) => /ctx\.storage\.store\(|storage\.generateUploadUrl\(/.test(readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    // Each of these writes a row that references its bytes in one of the
    // columns above (or immediately deletes them on failure).
    expect(creators).toEqual([
      "blobSafety.ts",
      "http.ts",
      // EVERY upload URL, for every door (Library, chat, Projects, legacy,
      // avatar), is issued by libraryCore.mintUploadUrl — ticketed and charged.
      "libraryCore.ts",
      // The hash-verified restore of originals (bound to its row, or deleted).
      "libraryMigrations.ts",
      "scheduled/delivery.ts",
    ]);
  });
});
