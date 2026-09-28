/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createLibraryFile, removeLibraryFile } from "./libraryCore";
import schema from "./schema";

/**
 * File Library — the security matrix. User A owns files; user B is a member of
 * the SAME workspace (the hardest boundary: tenancy does not separate them).
 * Every path must answer B exactly as it answers a missing file.
 */
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "k";
  globalThis.fetch = (async () => new Response("{}", { status: 202 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  // biome-ignore lint/performance/noDelete: unset
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: unset
  delete process.env.AI_SERVICE_KEY;
});


async function seed(t: T) {
  return t.run(async (ctx) => {
    const a = await ctx.db.insert("users", { email: "a@t.test" });
    const b = await ctx.db.insert("users", { email: "b@t.test" });
    const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: a, createdAt: 1 });
    const ws2 = await ctx.db.insert("workspaces", { name: "WS2", ownerId: a, createdAt: 1 });
    for (const [w, u] of [[ws, a], [ws, b], [ws2, a]] as const) {
      await ctx.db.insert("members", { workspaceId: w, userId: u, role: "member", createdAt: 1 });
    }
    return { a, b, ws, ws2 };
  });
}

async function fileOf(
  t: T,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  name: string,
  bytes: Uint8Array | string,
  contentType: string,
) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([bytes]));
    // As finishUpload does: the server-computed hash of the stored bytes.
    const sha256 = (await ctx.db.system.get(storageId))?.sha256;
    const fileId = await createLibraryFile(ctx, {
      userId, workspaceId: ws, storageId, name, contentType, size: new Blob([bytes]).size, sha256, source: "uploaded",
    });
    return { fileId, storageId };
  });
}

const page = { numItems: 20, cursor: null };

describe("A vs B (same workspace)", () => {
  test("B can neither see, find, open, rename, delete, download, preview nor attach A's file", async () => {
    const t = convexTest(schema, modules);
    const { a, b, ws } = await seed(t);
    const { fileId } = await fileOf(t, a, ws, "secret-plan.txt", "top secret", "text/plain");
    await fileOf(t, b, ws, "mine.txt", "b's", "text/plain");
    const B = t.withIdentity(as(b));

    const listed = await B.query(api.library.list, { workspaceId: ws, paginationOpts: page });
    expect(listed.page.map((r) => r.name)).toEqual(["mine.txt"]);
    const searched = await B.query(api.library.list, { workspaceId: ws, paginationOpts: page, search: "secret" });
    expect(searched.page).toEqual([]);
    expect(await B.query(api.library.get, { fileId })).toBeNull();

    await expect(B.mutation(api.library.rename, { fileId, name: "pwned" })).rejects.toThrow(/Not found/);
    await expect(B.mutation(api.userFiles.remove, { fileId })).rejects.toThrow(/Not found/);
    await expect(B.mutation(api.library.mintAccess, { fileId, purpose: "download" })).rejects.toThrow(/Not found/);
    await expect(
      B.mutation(api.chat.attachments.attachLibraryFile, { fileId, workspaceId: ws }),
    ).rejects.toThrow(/Not found/);
    expect(await B.mutation(api.library.removeMany, { fileIds: [fileId] })).toEqual({ removed: 0 });
    expect(await t.run(async (ctx) => ctx.db.get(fileId))).not.toBeNull();
  });

  test("B cannot delete A's file by approving it for eviction, nor finish A's upload session", async () => {
    const t = convexTest(schema, modules);
    const { a, b, ws } = await seed(t);
    const { fileId } = await fileOf(t, a, ws, "a.txt", "aaaa", "text/plain");
    const A = t.withIdentity(as(a));
    const begin = await A.mutation(api.library.beginUpload, {
      workspaceId: ws, name: "n.txt", contentType: "text/plain", size: 3, purpose: "library",
    });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["abc"])));
    await expect(
      t.withIdentity(as(b)).mutation(api.library.finishUpload, {
        intentId: begin.ok ? begin.intentId : ("" as Id<"uploadIntents">),
        storageId, name: "n.txt", contentType: "text/plain", approvedDeletions: [fileId],
      }),
    ).rejects.toThrow(/Not found/);
    expect(await t.run(async (ctx) => ctx.db.get(fileId))).not.toBeNull();
  });

  test("guessed and malformed ids resolve to the same null / Not found", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    expect(await A.query(api.library.get, { fileId: "not-an-id" })).toBeNull();
    const foreignTableId = ws as unknown as string; // a real id of ANOTHER table
    expect(await A.query(api.library.get, { fileId: foreignTableId })).toBeNull();
  });

  test("no file name reaches the audit log — B sees nothing of A's, and A's own rows carry ids only", async () => {
    const t = convexTest(schema, modules);
    const { a, b, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    const { fileId } = await fileOf(t, a, ws, "divorce-lawyer.pdf", "%PDF-1", "application/pdf");
    await A.mutation(api.library.rename, { fileId, name: "salary-review.pdf" });
    await A.mutation(api.userFiles.remove, { fileId });
    expect(await t.withIdentity(as(b)).query(api.audit.recent, { workspaceId: ws })).toEqual([]);
    const own = JSON.stringify(await A.query(api.audit.recent, { workspaceId: ws }));
    expect(own).toContain("userfile.upload");
    expect(own).not.toMatch(/divorce|salary/);
  });

  test("'you already have this file' answers only for your own files — never an existence oracle", async () => {
    const t = convexTest(schema, modules);
    const { a, b, ws, ws2 } = await seed(t);
    const { fileId } = await fileOf(t, a, ws, "contract.pdf", "%PDF-contract", "application/pdf");
    const hex = await t.run(async (ctx) => (await ctx.db.get(fileId))?.sha256 ?? "");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const mine = await t.withIdentity(as(a)).query(api.library.findDuplicate, { workspaceId: ws, sha256: hex });
    expect(mine).toMatchObject({ _id: fileId, name: "contract.pdf" });
    // A co-member holding the SAME bytes learns nothing about A's copy.
    expect(await t.withIdentity(as(b)).query(api.library.findDuplicate, { workspaceId: ws, sha256: hex })).toBeNull();
    // Scoped to the workspace being uploaded into, and malformed input is inert.
    expect(await t.withIdentity(as(a)).query(api.library.findDuplicate, { workspaceId: ws2, sha256: hex })).toBeNull();
    expect(await t.withIdentity(as(a)).query(api.library.findDuplicate, { workspaceId: ws, sha256: "x" })).toBeNull();
  });

  test("a file is attached only to a chat in its own workspace", async () => {
    const t = convexTest(schema, modules);
    const { a, ws, ws2 } = await seed(t);
    const { fileId } = await fileOf(t, a, ws, "a.txt", "x", "text/plain");
    await expect(
      t.withIdentity(as(a)).mutation(api.chat.attachments.attachLibraryFile, { fileId, workspaceId: ws2 }),
    ).rejects.toThrow(/Not found/);
  });

  test("a member removed from the workspace loses access to their files there", async () => {
    const t = convexTest(schema, modules);
    const { b, ws } = await seed(t);
    const { fileId } = await fileOf(t, b, ws, "b.txt", "x", "text/plain");
    const B = t.withIdentity(as(b));
    const { token } = await B.mutation(api.library.mintAccess, { fileId, purpose: "download" });
    await t.run(async (ctx) => {
      const m = await ctx.db.query("members").filter((q) => q.eq(q.field("userId"), b)).first();
      await ctx.db.delete(m!._id);
    });
    expect((await t.fetch(`/library/file?t=${token}`)).status).toBe(404);
    await expect(B.mutation(api.library.mintAccess, { fileId, purpose: "download" })).rejects.toThrow();
  });
});

describe("red-team cycle 1: abuse of the quota rules", () => {
  test("generated files cannot fill the global ceiling and block other users' uploads", async () => {
    const t = convexTest(schema, modules);
    const { a, b, ws } = await seed(t);
    // A floods 600 MB of generated files (the ceiling is 500 MB by default).
    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        const storageId = await ctx.storage.store(new Blob([`gen-${i}`]));
        await createLibraryFile(ctx, {
          userId: a, workspaceId: ws, storageId, name: `gen-${i}.pdf`, contentType: "application/pdf",
          size: 100 * 1024 * 1024, source: "generated",
        });
      }
    });
    const global = await t.run(async (ctx) =>
      ctx.db.query("storageUsage").withIndex("by_key", (q) => q.eq("key", "global")).unique(),
    );
    expect(global?.usedBytes ?? 0).toBe(0); // no new bytes, no charge
    // B can still upload.
    const begin = await t.withIdentity(as(b)).mutation(api.library.beginUpload, {
      workspaceId: ws, name: "mine.txt", contentType: "text/plain", size: 5, purpose: "library",
    });
    expect(begin.ok).toBe(true);
  });

  test("a heavy generator's old uploads are still offered by Free up space", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const oldUpload = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["old"]));
      const id = await createLibraryFile(ctx, {
        userId: a, workspaceId: ws, storageId, name: "old.zip", contentType: "application/zip",
        size: 90 * 1024 * 1024, source: "uploaded", createdAt: 1,
      });
      // More generated rows than the bounded scan could ever skip past.
      for (let i = 0; i < 2_100; i++) {
        await ctx.db.insert("userFiles", {
          userId: a, workspaceId: ws, name: `g${i}.pdf`, size: 1, contentType: "application/pdf",
          ingestId: `g-${i}`, status: "stored", attempts: 0, source: "generated", kind: "pdf",
          createdAt: 0, updatedAt: 0,
        });
      }
      return id;
    });
    const res = await t.withIdentity(as(a)).mutation(api.library.beginUpload, {
      workspaceId: ws, name: "new.zip", contentType: "application/zip", size: 20 * 1024 * 1024, purpose: "library",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("NEEDS_SPACE");
    expect(res.candidates.map((c) => c._id)).toEqual([oldUpload]);
  });
});

describe("processing intake (red-team cycle 6, found on prod)", () => {
  test("no door can queue more than 20 files for processing; kept-only files are unaffected", async () => {
    const t = convexTest(schema, modules);
    const { b, ws } = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        const storageId = await ctx.storage.store(new Blob([`p${i}`]));
        await createLibraryFile(ctx, {
          userId: b, workspaceId: ws, storageId, name: `p${i}.txt`, contentType: "text/plain", size: 2, source: "uploaded",
        });
      }
    });
    // The legacy door the F-12 suite used to queue 201 files.
    const B = t.withIdentity(as(b));
    const legacy = async (name: string, type: string) => {
      const url = await B.mutation(api.files.generateUploadUrl, { workspaceId: ws });
      expect(url).toBeTruthy();
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob([`x-${name}`], { type })));
      return B.mutation(api.files.saveFile, { workspaceId: ws, storageId, name, size: 3, contentType: type });
    };
    await expect(legacy("p20.txt", "text/plain")).rejects.toThrow(/still processing/);
    await expect(legacy("archive.zip", "application/zip")).resolves.toBeTruthy(); // kept, never processed
  });

  test("the queue's patience covers a FULL intake at the fastest retry rate", async () => {
    const { QUEUE_MAX_ATTEMPTS, QUEUE_MIN_DELAY_MS, INGEST_DEADLINE_MS } = await import("./userFiles");
    const { MAX_PROCESSING_PER_USER } = await import("./libraryCore");
    // The last of 20 files waits for 19 ingestions of up to the whole-file deadline.
    expect(QUEUE_MAX_ATTEMPTS * QUEUE_MIN_DELAY_MS).toBeGreaterThanOrEqual(
      (MAX_PROCESSING_PER_USER - 1) * INGEST_DEADLINE_MS,
    );
  });
});

describe("upload-delete churn (red-team cycle 7, measured on prod)", () => {
  test("deleting does not refund the daily upload budget: churn is bounded at 1 GiB/day", async () => {
    const t = convexTest(schema, modules);
    const { b, ws } = await seed(t);
    const B = t.withIdentity(as(b));
    const MB = 1024 * 1024;
    const churn = async (i: number) => {
      const r = await B.mutation(api.library.beginUpload, {
        workspaceId: ws, name: `c${i}.zip`, contentType: "application/zip", size: 25 * MB, purpose: "library",
      });
      if (!r.ok) throw new Error("no room");
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob([`c${i}`], { type: "application/zip" })));
      const done = await B.mutation(api.library.finishUpload, {
        intentId: r.intentId, storageId, name: `c${i}.zip`, contentType: "application/zip",
      });
      if (!done.ok) throw new Error("finish failed");
      await B.mutation(api.library.removeMany, { fileIds: [done.fileId] });
    };
    for (let i = 0; i < 40; i++) await churn(i); // 1,000 MB of upload URLs, every file deleted
    await expect(churn(40)).rejects.toThrow(/uploaded a lot today/);
  });

  test("an upload URL that is never finished is charged all the same", async () => {
    // The bytes can be written the moment the URL exists. Charging at finish
    // let an upload that was never finished write to the disk for free.
    const t = convexTest(schema, modules);
    const { b, ws } = await seed(t);
    const B = t.withIdentity(as(b));
    for (let i = 0; i < 40; i++) {
      const r = await B.mutation(api.library.beginUpload, {
        workspaceId: ws, name: `u${i}.zip`, contentType: "application/zip", size: 25 * 1024 * 1024, purpose: "library",
      });
      expect(r.ok).toBe(true);
      // Abandoned: the session closes (its reservation lapses), the charge stays.
      if (r.ok) await B.mutation(api.library.abortUpload, { intentId: r.intentId });
    }
    await expect(
      B.mutation(api.library.beginUpload, {
        workspaceId: ws, name: "more.zip", contentType: "application/zip", size: 25 * 1024 * 1024, purpose: "library",
      }),
    ).rejects.toThrow(/uploaded a lot today/);
    // The legacy doors are charged the same way (their declared or maximum size).
    await expect(B.mutation(api.userFiles.generateUploadUrl, { workspaceId: ws })).rejects.toThrow(
      /uploaded a lot today/,
    );
  });
});

describe("upload flood limit (shared by every door)", () => {
  test("a folder of hundreds of files is fine; the 301st session in an hour is refused", async () => {
    const t = convexTest(schema, modules);
    const { b, ws } = await seed(t);
    const B = t.withIdentity(as(b));
    for (let i = 0; i < 300; i++) {
      const r = await B.mutation(api.library.beginUpload, {
        workspaceId: ws, name: `f${i}.txt`, contentType: "text/plain", size: 1, purpose: "library",
      });
      expect(r.ok).toBe(true);
      if (r.ok) await B.mutation(api.library.abortUpload, { intentId: r.intentId });
    }
    await expect(
      B.mutation(api.library.beginUpload, {
        workspaceId: ws, name: "f300.txt", contentType: "text/plain", size: 1, purpose: "library",
      }),
    ).rejects.toThrow(/Too many uploads/);
    // The legacy doors draw on the same window — no way around it.
    await expect(B.mutation(api.userFiles.generateUploadUrl, { workspaceId: ws })).rejects.toThrow(/Too many uploads/);
    await expect(B.mutation(api.chat.attachments.generateUploadUrl, { workspaceId: ws })).rejects.toThrow(/Too many uploads/);
  });
});

describe("access capabilities and the /library/file route", () => {
  test("a download is an attachment of an inert type, with every protective header", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const { fileId } = await fileOf(t, a, ws, "Rapport été.html", "<script>alert(1)</script>", "text/html");
    const { token } = await t.withIdentity(as(a)).mutation(api.library.mintAccess, { fileId, purpose: "download" });
    const res = await t.fetch(`/library/file?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Rapport _t_.html"; filename\*=UTF-8''Rapport%20%C3%A9t%C3%A9\.html$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("a preview renders ONLY a real raster image — never HTML or SVG named like one", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    const png = await fileOf(t, a, ws, "real.png", PNG, "image/png");
    const fake = await fileOf(t, a, ws, "fake.png", "<svg onload=alert(1)>", "image/png");
    const ok = await A.mutation(api.library.mintAccess, { fileId: png.fileId, purpose: "preview" });
    const res = await t.fetch(`/library/file?t=${ok.token}&p=preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    const bad = await A.mutation(api.library.mintAccess, { fileId: fake.fileId, purpose: "preview" });
    expect((await t.fetch(`/library/file?t=${bad.token}&p=preview`)).status).toBe(404);
    // SVG is an image but never inline: no preview is even offered (it used to
    // be offered, 404, and be re-requested every 30 s — red-team cycle 2).
    const svg = await fileOf(t, a, ws, "chart.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml");
    expect((await A.query(api.library.get, { fileId: svg.fileId }))?.canPreview).toBe(false);
    await expect(A.mutation(api.library.mintAccess, { fileId: svg.fileId, purpose: "preview" })).rejects.toThrow();
    expect(await A.mutation(api.library.mintPreviews, { fileIds: [svg.fileId, png.fileId] })).toHaveLength(1);
    // A non-image can never even get a preview capability.
    const doc = await fileOf(t, a, ws, "d.pdf", "%PDF", "application/pdf");
    await expect(A.mutation(api.library.mintAccess, { fileId: doc.fileId, purpose: "preview" })).rejects.toThrow();
  });

  test("wrong purpose, malformed, expired, replayed-after-TTL and deleted-file tokens all 404", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    const { fileId } = await fileOf(t, a, ws, "x.txt", "hello", "text/plain");
    const dl = await A.mutation(api.library.mintAccess, { fileId, purpose: "download" });
    expect((await t.fetch(`/library/file?t=${dl.token}&p=preview`)).status).toBe(404); // wrong purpose
    expect((await t.fetch("/library/file?t=abc")).status).toBe(404); // malformed
    expect((await t.fetch(`/library/file?t=${"A".repeat(43)}`)).status).toBe(404); // guessed
    expect((await t.fetch(`/library/file?t=${dl.token}`)).status).toBe(200);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    expect((await t.fetch(`/library/file?t=${dl.token}`)).status).toBe(404); // expired / replay
    vi.useRealTimers();
    const again = await A.mutation(api.library.mintAccess, { fileId, purpose: "download" });
    await A.mutation(api.userFiles.remove, { fileId });
    expect((await t.fetch(`/library/file?t=${again.token}`)).status).toBe(404); // deleted
    // Only the token's hash is stored — never the token itself.
    const rows = await t.run(async (ctx) => ctx.db.query("fileAccessTokens").collect());
    for (const r of rows) expect(r.tokenHash).not.toBe(again.token);
  });

  test("a valid account cannot turn downloads into unbounded bandwidth", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    // 300 MB logical file on a tiny blob: two downloads exceed the 500 MB/hour budget.
    const fileId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["x"]));
      return createLibraryFile(ctx, {
        userId: a, workspaceId: ws, storageId, name: "huge.zip", contentType: "application/zip", size: 300 * 1024 * 1024, source: "generated",
      });
    });
    const t1 = await A.mutation(api.library.mintAccess, { fileId, purpose: "download" });
    expect((await t.fetch(`/library/file?t=${t1.token}`)).status).toBe(200);
    // The byte budget is charged when a capability is minted: the second
    // 300 MB download does not even get a link.
    await expect(A.mutation(api.library.mintAccess, { fileId, purpose: "download" })).rejects.toThrow(/downloaded a lot/);
  });

  test("one capability serves a bounded number of fetches (counted on its own row)", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    const { fileId } = await fileOf(t, a, ws, "x.txt", "hello", "text/plain");
    const { token } = await A.mutation(api.library.mintAccess, { fileId, purpose: "download" });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await t.fetch(`/library/file?t=${token}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429]); // a download manager's retries, then no more
    // Serving never writes the user's shared quota row (no cross-file contention).
    const quotaWritesBefore = await t.run(async (ctx) => (await ctx.db.query("userQuotas").collect()).length);
    const png = await fileOf(t, a, ws, "p.png", PNG, "image/png");
    const [prev] = await A.mutation(api.library.mintPreviews, { fileIds: [png.fileId] });
    const before = await t.run(async (ctx) => JSON.stringify(await ctx.db.query("userQuotas").collect()));
    expect((await t.fetch(`/library/file?t=${prev!.token}&p=preview`)).status).toBe(200);
    const after = await t.run(async (ctx) => JSON.stringify(await ctx.db.query("userQuotas").collect()));
    expect(after).toBe(before);
    expect(quotaWritesBefore).toBeGreaterThan(0);
  });
});
