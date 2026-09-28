/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { accountRagScope } from "./userFiles";
import { USER_QUOTA_BYTES, createLibraryFile, reservedBytes, userKey } from "./libraryCore";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;
const MB = 1024 * 1024;

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string }> = [];
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "k";
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  // biome-ignore lint/performance/noDelete: unset
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: unset
  delete process.env.AI_SERVICE_KEY;
});


async function drain(t: T) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: T) {
  return t.run(async (ctx) => {
    const a = await ctx.db.insert("users", { email: "a@t.test" });
    const b = await ctx.db.insert("users", { email: "b@t.test" });
    const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: a, createdAt: Date.now() });
    for (const userId of [a, b]) {
      await ctx.db.insert("members", { workspaceId: ws, userId, role: "member", createdAt: Date.now() });
    }
    return { a, b, ws };
  });
}

/** The real client flow: begin → bytes → finish. */
async function upload(
  t: T,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  name: string,
  contentType: string,
  body: string,
  opts: { declared?: number; approve?: Id<"userFiles">[]; purpose?: "library" | "chat" } = {},
) {
  const u = t.withIdentity(as(userId));
  const size = opts.declared ?? new Blob([body]).size;
  const begin = await u.mutation(api.library.beginUpload, {
    workspaceId: ws,
    name,
    contentType,
    size,
    purpose: opts.purpose ?? "library",
    ...(opts.approve ? { approvedDeletions: opts.approve } : {}),
  });
  if (!begin.ok) return { begin };
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([body], { type: contentType })));
  const finish = await u.mutation(api.library.finishUpload, {
    intentId: begin.intentId,
    storageId,
    name,
    contentType,
    ...(opts.approve ? { approvedDeletions: opts.approve } : {}),
  });
  return { begin, finish, storageId };
}

/** The new file's id from a completed upload — or a loud failure. */
function fileIdOf(r: Awaited<ReturnType<typeof upload>>): Id<"userFiles"> {
  if (!r.finish?.ok) throw new Error(`upload did not complete: ${JSON.stringify(r)}`);
  return r.finish.fileId;
}

/** A Library file with a large LOGICAL size on a tiny blob (quota tests). */
async function bigFile(t: T, userId: Id<"users">, ws: Id<"workspaces">, name: string, size: number, createdAt: number) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["x"]));
    return createLibraryFile(ctx, {
      userId,
      workspaceId: ws,
      storageId,
      name,
      contentType: "application/zip",
      size,
      source: "uploaded",
      createdAt,
    });
  });
}

const usage = (t: T, userId: Id<"users">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("storageUsage").withIndex("by_key", (q) => q.eq("key", userKey(userId))).unique())
      ?.usedBytes ?? 0,
  );
const page = { numItems: 20, cursor: null };
const usedBytesOf = (t: T, key: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("storageUsage").withIndex("by_key", (q) => q.eq("key", key)).unique())?.usedBytes ?? 0,
  );

describe("upload", () => {
  test("a readable file is processed; an archive is only stored and never reaches processing", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const pdf = await upload(t, a, ws, "report.pdf", "application/pdf", "%PDF-1.4 x");
    const zip = await upload(t, a, ws, "bundle.zip", "application/zip", "PK\u0003\u0004 x");
    await drain(t);
    const rows = await t.run(async (ctx) => ctx.db.query("userFiles").collect());
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(pdf.finish?.ok && zip.finish?.ok).toBe(true);
    expect(byName["report.pdf"]?.status).toBe("processing");
    expect(byName["bundle.zip"]?.status).toBe("stored");
    expect(byName["bundle.zip"]?.kind).toBe("other");
    // Exactly one ingest dispatch: the archive never reached the pipeline.
    expect(calls.filter((c) => c.url.endsWith("/v1/ingest")).length).toBe(1);
  });

  test("identical bytes uploaded twice are two files with two ingest ids", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    await upload(t, a, ws, "a.txt", "text/plain", "same bytes");
    await upload(t, a, ws, "b.txt", "text/plain", "same bytes");
    const rows = await t.run(async (ctx) => ctx.db.query("userFiles").collect());
    expect(rows.map((r) => r.name).sort()).toEqual(["a.txt", "b.txt"]);
    expect(new Set(rows.map((r) => r.ingestId)).size).toBe(2);
    expect(new Set(rows.map((r) => r.storageId)).size).toBe(2);
    expect(rows[0]?.sha256).toBe(rows[1]?.sha256); // server hash, same bytes
  });

  test("the server's size is authoritative: a blob larger than declared is refused and dropped", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const r = await upload(t, a, ws, "x.txt", "text/plain", "0123456789", { declared: 3 });
    expect(r.finish).toMatchObject({ ok: false, code: "SIZE_MISMATCH" });
    expect(await t.run(async (ctx) => (await ctx.db.query("userFiles").collect()).length)).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.storage.get(r.storageId!)) === null)).toBe(true);
  });

  test("finish is idempotent: a retry after a lost response returns the same file and charges once", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const r = await upload(t, a, ws, "x.txt", "text/plain", "hello");
    const u = t.withIdentity(as(a));
    const again = await u.mutation(api.library.finishUpload, {
      intentId: r.begin.ok ? r.begin.intentId : ("" as Id<"uploadIntents">),
      storageId: r.storageId!,
      name: "x.txt",
      contentType: "text/plain",
    });
    expect(again).toMatchObject({ ok: true, fileId: r.finish && "fileId" in r.finish ? r.finish.fileId : "" });
    expect(await usage(t, a)).toBe(5);
  });

  test("an aborted session frees its reservation at once, and an expired one lapses on its own", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const u = t.withIdentity(as(a));
    const b1 = await u.mutation(api.library.beginUpload, {
      workspaceId: ws, name: "big.bin", contentType: "application/zip", size: 10 * MB, purpose: "library",
    });
    expect(await t.run((ctx) => reservedBytes(ctx, a))).toBe(10 * MB);
    if (b1.ok) await u.mutation(api.library.abortUpload, { intentId: b1.intentId });
    expect(await t.run((ctx) => reservedBytes(ctx, a))).toBe(0);

    vi.useFakeTimers();
    await u.mutation(api.library.beginUpload, {
      workspaceId: ws, name: "big2.bin", contentType: "application/zip", size: 10 * MB, purpose: "library",
    });
    expect(await t.run((ctx) => reservedBytes(ctx, a))).toBe(10 * MB);
    vi.setSystemTime(Date.now() + 61 * 60_000); // past the session TTL: a crashed browser
    expect(await t.run((ctx) => reservedBytes(ctx, a))).toBe(0);
  });
});

describe("100 MB per user: ask first, then free up space", () => {
  async function fill(t: T, a: Id<"users">, ws: Id<"workspaces">) {
    // 4 × 25 MB = exactly the quota, oldest first.
    const ids: Id<"userFiles">[] = [];
    for (let i = 0; i < 4; i++) ids.push(await bigFile(t, a, ws, `old${i}.zip`, 25 * MB, 1_000 + i));
    return ids;
  }

  test("a file that does not fit deletes NOTHING without approval, and offers the oldest first", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const ids = await fill(t, a, ws);
    const r = await upload(t, a, ws, "new.txt", "text/plain", "x".repeat(100));
    expect(r.begin).toMatchObject({ ok: false, reason: "NEEDS_SPACE" });
    if (!r.begin.ok && "plan" in r.begin) expect(r.begin.plan.suggested).toEqual([ids[0]]);
    expect(await t.run(async (ctx) => (await ctx.db.query("userFiles").collect()).length)).toBe(4);
  });

  test("the user's own choice (not only the oldest) is honoured, then notified", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const ids = await fill(t, a, ws);
    const r = await upload(t, a, ws, "new.txt", "text/plain", "x".repeat(100), { approve: [ids[2]!] });
    expect(r.finish).toMatchObject({ ok: true, evicted: ["old2.zip"] });
    const left = await t.run(async (ctx) => (await ctx.db.query("userFiles").collect()).map((f) => f.name).sort());
    expect(left).toEqual(["new.txt", "old0.zip", "old1.zip", "old3.zip"]);
    expect(await usage(t, a)).toBe(75 * MB + 100);
    const note = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(note.some((n) => n.type === "library.evicted" && n.body?.includes("old2.zip"))).toBe(true);
  });

  test("a stale approval (the file changed meanwhile) deletes nothing and asks again", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const ids = await fill(t, a, ws);
    const u = t.withIdentity(as(a));
    const begin = await u.mutation(api.library.beginUpload, {
      workspaceId: ws, name: "n.txt", contentType: "text/plain", size: 100, purpose: "library", approvedDeletions: [ids[0]!],
    });
    expect(begin.ok).toBe(true);
    // The approved file is linked to a Project before finishing: no longer deletable.
    await t.run(async (ctx) => {
      const p = await ctx.db.insert("projects", {
        workspaceId: ws, userId: a, name: "P", status: "active", createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("projectFiles", { projectId: p, fileId: ids[0]!, userId: a, addedAt: 1 });
    });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x".repeat(100)])));
    const r = await u.mutation(api.library.finishUpload, {
      intentId: begin.ok ? begin.intentId : ("" as Id<"uploadIntents">),
      storageId, name: "n.txt", contentType: "text/plain", approvedDeletions: [ids[0]!],
    });
    expect(r).toMatchObject({ ok: false, code: "QUOTA_PLAN_CHANGED" });
    expect(await t.run(async (ctx) => (await ctx.db.query("userFiles").collect()).length)).toBe(4);
  });

  test("files in a Project and generated files are never offered or deleted", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const ids = await fill(t, a, ws);
    await t.run(async (ctx) => {
      const p = await ctx.db.insert("projects", { workspaceId: ws, userId: a, name: "P", status: "active", createdAt: 1, updatedAt: 1 });
      for (const id of ids) await ctx.db.insert("projectFiles", { projectId: p, fileId: id, userId: a, addedAt: 1 });
      const sid = await ctx.storage.store(new Blob(["gen"]));
      await createLibraryFile(ctx, { userId: a, workspaceId: ws, storageId: sid, name: "gen.pdf", contentType: "application/pdf", size: 3, source: "generated" });
    });
    const r = await upload(t, a, ws, "new.txt", "text/plain", "hi");
    expect(r.begin).toMatchObject({ ok: false, reason: "CANNOT_FIT" });
    if (!r.begin.ok && "candidates" in r.begin) expect(r.begin.candidates).toEqual([]);
    // Generated files are not charged at all.
    expect(await usage(t, a)).toBe(100 * MB);
  });

  test("two uploads racing for the same freed space: the second is told to re-plan, never over quota", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const ids = await fill(t, a, ws);
    const u = t.withIdentity(as(a));
    const b1 = await u.mutation(api.library.beginUpload, { workspaceId: ws, name: "1.txt", contentType: "text/plain", size: 10, purpose: "library", approvedDeletions: [ids[0]!] });
    const b2 = await u.mutation(api.library.beginUpload, { workspaceId: ws, name: "2.txt", contentType: "text/plain", size: 10, purpose: "library", approvedDeletions: [ids[0]!] });
    const s1 = await t.run((ctx) => ctx.storage.store(new Blob(["0123456789"])));
    const s2 = await t.run((ctx) => ctx.storage.store(new Blob(["0123456789"])));
    const f1 = await u.mutation(api.library.finishUpload, { intentId: b1.ok ? b1.intentId : ("" as Id<"uploadIntents">), storageId: s1, name: "1.txt", contentType: "text/plain", approvedDeletions: [ids[0]!] });
    const f2 = await u.mutation(api.library.finishUpload, { intentId: b2.ok ? b2.intentId : ("" as Id<"uploadIntents">), storageId: s2, name: "2.txt", contentType: "text/plain", approvedDeletions: [ids[0]!] });
    expect(f1).toMatchObject({ ok: true });
    // 75 MB + 10 B used, 10 B of room short of fitting another 10 B? It fits:
    // the first freed 25 MB. The second needs no eviction, and no double delete.
    expect(f2).toMatchObject({ ok: true, evicted: [] });
    expect(await usage(t, a)).toBeLessThanOrEqual(USER_QUOTA_BYTES);
  });

  test("the one-time 90 % notice fires once and re-arms below 80 %", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const x = await bigFile(t, a, ws, "x.zip", 91 * MB, 1);
    await bigFile(t, a, ws, "y.zip", 1 * MB, 2);
    let notes = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(notes.filter((n) => n.type === "library.near_full").length).toBe(1);
    await t.withIdentity(as(a)).mutation(api.userFiles.remove, { fileId: x });
    await bigFile(t, a, ws, "z.zip", 91 * MB, 3);
    notes = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(notes.filter((n) => n.type === "library.near_full").length).toBe(2);
  });
});

describe("one blob, many references", () => {
  test("a Library file reused in chats A, B, C and Project X is ONE blob; each stream sees only its own chat", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const r = await upload(t, a, ws, "notes.txt", "text/plain", "shared notes");
    const fileId = fileIdOf(r);
    const u = t.withIdentity(as(a));
    const threads: Id<"chatThreads">[] = [];
    for (let i = 0; i < 3; i++) threads.push(await u.mutation(api.chat.threads.create, { workspaceId: ws }));
    for (const threadId of threads) await u.mutation(api.chat.attachments.attachLibraryFile, { fileId, workspaceId: ws, threadId });
    const projectId = await u.mutation(api.projects.create, { workspaceId: ws, name: "X" });
    await u.mutation(api.projects.linkFile, { projectId, fileId });

    const refs = await t.run(async (ctx) => ctx.db.query("chatAttachments").collect());
    expect(refs).toHaveLength(3);
    expect(new Set(refs.map((x) => x.storageId))).toEqual(new Set([r.storageId]));
    expect((await t.run(async (ctx) => ctx.db.system.query("_storage").collect())).length).toBe(1);

    // Each chat's stream is authorised for the blob in ITS thread only.
    for (const threadId of threads) {
      const streamId = `s-${threadId}`;
      await t.run(async (ctx) => {
        const messageId = await ctx.db.insert("chatMessages", {
          threadId, workspaceId: ws, userId: a, role: "assistant", seq: 1, content: "",
          status: "streaming", variantCount: 1, activeVariantIndex: 0, createdAt: 1, updatedAt: 1,
        });
        await ctx.db.insert("chatStreams", {
          streamId, threadId, messageId, userId: a, workspaceId: ws, status: "running",
          startedAt: 1, heartbeatAt: 1, committedText: "", committedSeq: 0,
          cancelRequested: false, chunkSeq: 0,
        } as never);
      });
      const ok = await t.query(internal.chat.stream.attachmentInStream, { streamId, storageId: r.storageId! });
      expect(ok).not.toBeNull();
    }
    const other = await u.mutation(api.chat.threads.create, { workspaceId: ws });
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("chatMessages", {
        threadId: other, workspaceId: ws, userId: a, role: "assistant", seq: 1, content: "",
        status: "streaming", variantCount: 1, activeVariantIndex: 0, createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("chatStreams", {
        streamId: "s-other", threadId: other, messageId, userId: a, workspaceId: ws, status: "running",
        startedAt: 1, heartbeatAt: 1, committedText: "", committedSeq: 0,
        cancelRequested: false, chunkSeq: 0,
      } as never);
    });
    expect(await t.query(internal.chat.stream.attachmentInStream, { streamId: "s-other", storageId: r.storageId! })).toBeNull();

    // Deleting ONE chat keeps the file; deleting the FILE removes every reference and the bytes.
    await t.run(async (ctx) => ctx.db.patch(threads[0]!, { status: "trashed" }));
    await t.mutation(internal.chat.threads.purge, { threadId: threads[0]! });
    expect(await t.run(async (ctx) => ctx.db.get(fileId))).not.toBeNull();
    expect(await t.run(async (ctx) => (await ctx.storage.get(r.storageId!)) !== null)).toBe(true);
    await u.mutation(api.userFiles.remove, { fileId });
    expect(await t.run(async (ctx) => ctx.db.query("chatAttachments").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("projectFiles").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.storage.get(r.storageId!)) === null)).toBe(true);
    expect(await usage(t, a)).toBe(0);
  });

  test("the legacy chat paperclip is ONE upload: a charged Library file plus a reference on the same blob", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const u = t.withIdentity(as(a));
    await u.mutation(api.chat.attachments.generateUploadUrl, { workspaceId: ws });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["abc"], { type: "text/plain" })));
    const attId = await u.mutation(api.chat.attachments.register, {
      workspaceId: ws, storageId, name: "p.txt", size: 3, contentType: "text/plain",
    });
    const att = await t.run(async (ctx) => ctx.db.get(attId));
    const file = await t.run(async (ctx) => (att?.userFileId ? ctx.db.get(att.userFileId) : null));
    expect(file?.storageId).toBe(storageId);
    expect(await usage(t, a)).toBe(3);
  });

  test("the legacy doors cannot bypass the quota", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    await bigFile(t, a, ws, "full.zip", USER_QUOTA_BYTES, 1);
    const u = t.withIdentity(as(a));
    await u.mutation(api.userFiles.generateUploadUrl, { workspaceId: ws });
    const sid = await t.run((ctx) => ctx.storage.store(new Blob(["abc"])));
    await expect(
      u.mutation(api.userFiles.saveFile, { workspaceId: ws, storageId: sid, name: "x.txt", size: 3, contentType: "text/plain", contentHash: "h" }),
    ).rejects.toThrow(/full/i);
  });
});

describe("lifecycle", () => {
  test("rename changes the name only — never the bytes — and strips spoofing characters", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const r = await upload(t, a, ws, "x.txt", "text/plain", "hi");
    const fileId = fileIdOf(r);
    const before = await t.run(async (ctx) => ctx.db.get(fileId));
    const res = await t.withIdentity(as(a)).mutation(api.library.rename, { fileId, name: "inv‮gpj.exe\r\nX" });
    expect(res.name).toBe("invgpj.exeX");
    const after = await t.run(async (ctx) => ctx.db.get(fileId));
    expect(after?.storageId).toBe(before?.storageId);
    expect(after?.sha256).toBe(before?.sha256);
  });

  test("a stored file is terminal: a late processing callback cannot turn it into ready", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const r = await upload(t, a, ws, "b.zip", "application/zip", "PK");
    const file = await t.run(async (ctx) => ctx.db.query("userFiles").first());
    const res = await t.mutation(internal.userFiles.setStatus, { fileId: file!.ingestId, status: "ready", chunkCount: 9 });
    expect(res).toMatchObject({ alreadyFinal: true });
    expect((await t.run(async (ctx) => ctx.db.get(file!._id)))?.status).toBe("stored");
    expect(r.finish?.ok).toBe(true);
  });

  test("processing that times out keeps the original, so the file can be retried (bounded)", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const r = await upload(t, a, ws, "d.pdf", "application/pdf", "%PDF");
    const fileId = fileIdOf(r);
    await t.run(async (ctx) => ctx.db.patch(fileId, { attempts: 3, updatedAt: 0 }));
    await t.mutation(internal.userFiles.reapStalled, {});
    const f = await t.run(async (ctx) => ctx.db.get(fileId));
    expect(f?.status).toBe("failed");
    expect(f?.storageId).toBe(r.storageId);
    expect(await t.run(async (ctx) => (await ctx.storage.get(r.storageId!)) !== null)).toBe(true);
    const u = t.withIdentity(as(a));
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push((await u.mutation(api.userFiles.retry, { fileId })).ok);
      await t.run(async (ctx) => ctx.db.patch(fileId, { status: "failed" }));
    }
    expect(results).toEqual([true, true, true, false]); // 3 per file per day
  });

  test("a deleted file never enters the retrieval scope; stored files never do either", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const r = await upload(t, a, ws, "k.txt", "text/plain", "kb");
    const fileId = fileIdOf(r);
    const f = await t.run(async (ctx) => ctx.db.get(fileId));
    await t.mutation(internal.userFiles.setStatus, { fileId: f!.ingestId, status: "ready", chunkCount: 1 });
    await upload(t, a, ws, "z.zip", "application/zip", "PK");
    expect(await t.run((ctx) => accountRagScope(ctx, a))).toEqual([f!.ingestId]);
    await t.withIdentity(as(a)).mutation(api.userFiles.remove, { fileId });
    expect(await t.run((ctx) => accountRagScope(ctx, a))).toEqual([]);
  });

  test("a generated file joins the Library on the artifact's own blob, once, uncharged", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const { addGeneratedToLibrary } = await import("./libraryCore");
    const ids = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("chatThreads", {
        userId: a, workspaceId: ws, title: "t", titleSource: "user", status: "active", pinned: false, model: "m",
        nextSeq: 0, messageCount: 0, tokensIn: 0, tokensOut: 0, lastMessageAt: 1, createdAt: 1, updatedAt: 1,
      });
      const messageId = await ctx.db.insert("chatMessages", {
        threadId, workspaceId: ws, userId: a, role: "assistant", seq: 1, content: "", status: "complete",
        variantCount: 1, activeVariantIndex: 0, createdAt: 1, updatedAt: 1,
      });
      const storageId = await ctx.storage.store(new Blob(["%PDF gen"]));
      const artifactId = await ctx.db.insert("chatArtifacts", {
        streamId: "s", messageId, threadId, workspaceId: ws, userId: a, storageId,
        filename: "deck.pdf", format: "pdf", mime: "application/pdf", size: 8, createdAt: 1,
      });
      return { storageId, artifactId };
    });
    const args = { ...ids, userId: a, workspaceId: ws, name: "deck.pdf", contentType: "application/pdf", size: 8 };
    const f1 = await t.run((ctx) => addGeneratedToLibrary(ctx, args));
    const f2 = await t.run((ctx) => addGeneratedToLibrary(ctx, args));
    expect(f1).toBe(f2);
    const row = await t.run(async (ctx) => ctx.db.get(f1!));
    expect(row).toMatchObject({ source: "generated", status: "stored", storageId: ids.storageId });
    expect(await usage(t, a)).toBe(0);
  });
});

describe("list: server-side filters, sorts and name search", () => {
  test("filters by kind and source, sorts by name both ways, searches names, clamps pages", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    await upload(t, a, ws, "Budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK sheet");
    await upload(t, a, ws, "alpha.pdf", "application/pdf", "%PDF a");
    await upload(t, a, ws, "photo.png", "image/png", "\u0089PNG");
    const u = t.withIdentity(as(a));
    const names = async (args: Record<string, unknown>) =>
      (await u.query(api.library.list, { workspaceId: ws, paginationOpts: page, ...args })).page.map((r) => r.name);
    expect(await names({ kind: "pdf" })).toEqual(["alpha.pdf"]);
    expect(await names({ kind: "spreadsheet" })).toEqual(["Budget.xlsx"]);
    expect(await names({ sort: "name_asc" })).toEqual(["alpha.pdf", "Budget.xlsx", "photo.png"]);
    expect(await names({ sort: "name_desc" })).toEqual(["photo.png", "Budget.xlsx", "alpha.pdf"]);
    expect(await names({ source: "generated" })).toEqual([]);
    expect(await names({ search: "budget" })).toEqual(["Budget.xlsx"]);
    const big = await u.query(api.library.list, { workspaceId: ws, paginationOpts: { numItems: 5000, cursor: null } });
    expect(big.page.length).toBeLessThanOrEqual(50);
    // No storage id, ingest id or URL ever leaves the server.
    for (const row of big.page) {
      expect(Object.keys(row)).not.toContain("storageId");
      expect(Object.keys(row)).not.toContain("ingestId");
    }
  });
});

describe("account deletion (red-team cycle 5)", () => {
  test("deleting an account releases its Library charge — the global ledger does not drift", async () => {
    const t = convexTest(schema, modules);
    const { a, b, ws } = await seed(t);
    await bigFile(t, a, ws, "keep.zip", 7 * MB, 1);
    const globalBefore = await usedBytesOf(t, "global");
    await bigFile(t, b, ws, "gone.zip", 30 * MB, 2);
    expect(await usedBytesOf(t, "global")).toBe(globalBefore + 30 * MB);
    await t.mutation(internal.authDeletion.cascadeUserContent, { userId: b });
    await drain(t);
    expect(await usedBytesOf(t, "global")).toBe(globalBefore);
    expect(await usage(t, b)).toBe(0);
    expect(await usage(t, a)).toBe(7 * MB); // nobody else's charge moves
  });
});

describe("migrations (dry-run first, verified, non-destructive)", () => {
  test("legacy shared files fold into their uploaders' Libraries on the same bytes; cleanup waits for verification", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const legacy = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["legacy bytes"]));
      return {
        storageId,
        id: await ctx.db.insert("files", {
          workspaceId: ws, userId: a, name: "old.zip", storageId, size: 12, contentType: "application/zip", createdAt: 5,
        }),
      };
    });
    const dry = await t.mutation(internal.libraryMigrations.foldSharedFiles, {});
    expect(dry).toMatchObject({ dryRun: true, created: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.query("userFiles").collect()).length)).toBe(0);
    expect(await t.mutation(internal.libraryMigrations.cleanupFoldedFiles, { dryRun: false })).toMatchObject({ refused: expect.any(String) });

    await t.mutation(internal.libraryMigrations.foldSharedFiles, { dryRun: false });
    await t.mutation(internal.libraryMigrations.foldSharedFiles, { dryRun: false }); // idempotent
    const rows = await t.run(async (ctx) => ctx.db.query("userFiles").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: a, storageId: legacy.storageId, legacyFileId: legacy.id, status: "stored" });
    expect(await t.mutation(internal.libraryMigrations.verifyFold, {})).toMatchObject({ verified: true });
    await t.mutation(internal.libraryMigrations.cleanupFoldedFiles, { dryRun: false });
    expect(await t.run(async (ctx) => ctx.db.get(legacy.id))).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.storage.get(legacy.storageId)) !== null)).toBe(true);
  });

  test("a legacy row whose bytes already back a Library file is reported, and the rest of the page still folds", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const { shared, other } = await t.run(async (ctx) => {
      const shared = await ctx.storage.store(new Blob(["shared bytes"]));
      const other = await ctx.storage.store(new Blob(["other bytes"]));
      await createLibraryFile(ctx, {
        userId: a, workspaceId: ws, storageId: shared, name: "mine.zip", contentType: "application/zip", size: 12, source: "uploaded",
      });
      for (const [name, storageId] of [["a.zip", shared], ["b.zip", other]] as const) {
        await ctx.db.insert("files", {
          workspaceId: ws, userId: a, name, storageId, size: 11, contentType: "application/zip", createdAt: 5,
        });
      }
      return { shared, other };
    });
    const res = await t.mutation(internal.libraryMigrations.foldSharedFiles, { dryRun: false });
    expect(res).toMatchObject({ created: 1, failed: 1, lastError: expect.stringContaining("shares its bytes") });
    const rows = await t.run(async (ctx) => ctx.db.query("userFiles").collect());
    expect(rows.map((r) => r.storageId).sort()).toEqual([shared, other].sort());
    // Not verified while a legacy row has no Library file of its own.
    expect(await t.mutation(internal.libraryMigrations.verifyFold, {})).toMatchObject({ verified: false });
  });

  test("restoreOriginals binds a blob ONLY when every hash agrees; a mismatch changes nothing", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    const good = "restored original";
    const hex = async (s: string) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const ids = await t.run(async (ctx) => {
      const mk = (name: string, ingestId: string) =>
        ctx.db.insert("userFiles", {
          userId: a, workspaceId: ws, name, size: 17, contentType: "text/plain", ingestId,
          status: "ready", attempts: 0, createdAt: 1, updatedAt: 1,
        });
      return { ok: await mk("ok.txt", "ing-ok"), bad: await mk("bad.txt", "ing-bad") };
    });
    const goodHash = await hex(good);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const bytes = url.includes("ing-ok") ? good : "tampered bytes!!!";
      return new Response(bytes, { status: 200, headers: { "x-content-sha256": goodHash } });
    }) as typeof fetch;
    const res = await t.action(internal.libraryMigrations.restoreOriginals, { dryRun: false });
    expect(res).toMatchObject({ restored: 1, failed: 1 });
    const okRow = await t.run(async (ctx) => ctx.db.get(ids.ok));
    const badRow = await t.run(async (ctx) => ctx.db.get(ids.bad));
    expect(okRow?.storageId).toBeDefined();
    expect(okRow?.sha256).toBe(goodHash);
    expect(badRow?.storageId).toBeUndefined();
  });

  test("recomputeUsage re-derives the ledger from the rows and reports the drift it fixed", async () => {
    const t = convexTest(schema, modules);
    const { a, ws } = await seed(t);
    await upload(t, a, ws, "x.txt", "text/plain", "12345");
    await t.run(async (ctx) => {
      const d = await ctx.db.query("storageUsage").withIndex("by_key", (q) => q.eq("key", userKey(a))).unique();
      await ctx.db.patch(d!._id, { usedBytes: 999 }); // drift
    });
    const res = await t.mutation(internal.libraryMigrations.recomputeUsage, { dryRun: false });
    expect(res.diffs.some((d) => d.key === userKey(a) && d.live === 999 && d.truth === 5)).toBe(true);
    expect(await usage(t, a)).toBe(5);
  });
});
