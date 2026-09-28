/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createLibraryFile } from "./libraryCore";
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
    const t2 = await A.mutation(api.library.mintAccess, { fileId, purpose: "download" });
    expect((await t.fetch(`/library/file?t=${t2.token}`)).status).toBe(429);
  });
});
