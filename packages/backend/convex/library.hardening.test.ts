/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { GENERATED_LIVE_BYTES, LIMITS, createLibraryFile, genKey, hashToken } from "./libraryCore";
import { AUTO_RETRY_BATCH, AUTO_RETRY_MAX, REINDEX_MAX_ATTEMPTS } from "./libraryProcessing";
import { accountRagScope } from "./userFiles";
import schema from "./schema";

/**
 * File Library production hardening (2026-09-28/29): upload tickets, complete
 * deletion, the generation fence, automatic retry + dead letter, background
 * re-index, the cross-plane reconcile, the host health snapshot and the
 * generated-file budget.
 */
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;
const MB = 1024 * 1024;
const EDGE = "edge-secret-for-tests";
const OPS = "ops-secret-for-tests";
const INGRESS = "ingress-secret-for-tests";

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "k";
  process.env.EDGE_TICKET_SECRET = EDGE;
  process.env.OPS_HEALTH_SECRET = OPS;
  process.env.AI_INGRESS_SECRET = INGRESS;
  globalThis.fetch = (async () => new Response("{}", { status: 202 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["AI_BASE_URL", "AI_SERVICE_KEY", "EDGE_TICKET_SECRET", "OPS_HEALTH_SECRET", "AI_INGRESS_SECRET"]) {
    delete process.env[k];
  }
});

async function seed(t: T) {
  return t.run(async (ctx) => {
    const a = await ctx.db.insert("users", { email: "a@t.test" });
    const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: a, createdAt: 1 });
    await ctx.db.insert("members", { workspaceId: ws, userId: a, role: "owner", createdAt: 1 });
    return { a, ws };
  });
}

async function streamFor(t: T, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const threadId = await ctx.db.insert("chatThreads", {
      userId, workspaceId, title: "t", titleSource: "user", status: "active", pinned: false, model: "m",
      nextSeq: 3, messageCount: 2, tokensIn: 0, tokensOut: 0, lastMessageAt: now, createdAt: now, updatedAt: now,
    });
    const messageId = await ctx.db.insert("chatMessages", {
      threadId, userId, workspaceId, role: "assistant", content: "", seq: 2, status: "streaming",
      createdAt: now, updatedAt: now,
    });
    const streamId = `stream_${Math.random()}`;
    await ctx.db.insert("chatStreams", {
      streamId, messageId, threadId, workspaceId, userId, status: "running", cancelRequested: false,
      chunkSeq: -1, committedText: "", committedSeq: -1, heartbeatAt: now, startedAt: now, attempts: 0,
      deadlineAt: now + 300_000,
    });
    return { streamId, threadId, messageId };
  });
}

/** A processable (text) Library file, status `processing`, generation 1. */
async function processingFile(t: T, a: Id<"users">, ws: Id<"workspaces">, name = "notes.txt") {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([`hello ${name}`], { type: "text/plain" }));
    const id = await createLibraryFile(ctx, {
      userId: a, workspaceId: ws, storageId, name, contentType: "text/plain", size: 12, source: "uploaded",
    });
    return (await ctx.db.get(id))!;
  });
}

const redeem = (t: T, ticket: string, key = EDGE) =>
  t.fetch("/edge/upload-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", "x-edge-key": key },
    body: JSON.stringify({ ticket }),
  });

const ticketOf = (url: string) => new URL(url).searchParams.get("lt") ?? "";

// ------------------------------------------------------------ upload tickets

describe("upload tickets (every upload URL is bound to a user and a byte count)", () => {
  test("a Library upload URL carries a single-use ticket sized to the declared file", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const r = await t.withIdentity(as(a)).mutation(api.library.beginUpload, {
      workspaceId: ws, name: "a.pdf", contentType: "application/pdf", size: 1234, purpose: "library",
    });
    if (!r.ok) throw new Error("no session");
    const ticket = ticketOf(r.uploadUrl);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const intent = await t.run((ctx) => ctx.db.get(r.intentId));
    expect(intent?.ticketHash).toBe(await hashToken(ticket));
    expect(intent?.maxBytes).toBe(1234);
    expect(JSON.stringify(intent)).not.toContain(ticket); // only the hash is stored

    const first = await redeem(t, ticket);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, maxBytes: 1234 });
    expect((await redeem(t, ticket)).status).toBe(403); // single use
  });

  test("the redeem door is closed without the edge's own secret, and malformed tickets never reach the table", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const r = await t.withIdentity(as(a)).mutation(api.library.beginUpload, {
      workspaceId: ws, name: "a.pdf", contentType: "application/pdf", size: 10, purpose: "library",
    });
    if (!r.ok) throw new Error("no session");
    expect((await redeem(t, ticketOf(r.uploadUrl), "wrong")).status).toBe(401);
    expect((await redeem(t, ticketOf(r.uploadUrl), INGRESS)).status).toBe(401); // another plane's key
    expect((await redeem(t, "not-a-ticket")).status).toBe(403);
    // The rightful redeem still works: the refusals above consumed nothing.
    expect((await redeem(t, ticketOf(r.uploadUrl))).status).toBe(200);
  });

  test("an aborted or expired session's ticket is refused", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    const begin = () =>
      A.mutation(api.library.beginUpload, {
        workspaceId: ws, name: "a.txt", contentType: "text/plain", size: 10, purpose: "library",
      });
    const aborted = await begin();
    if (!aborted.ok) throw new Error("no session");
    await A.mutation(api.library.abortUpload, { intentId: aborted.intentId });
    expect((await redeem(t, ticketOf(aborted.uploadUrl))).status).toBe(403);

    const expired = await begin();
    if (!expired.ok) throw new Error("no session");
    await t.run((ctx) => ctx.db.patch(expired.intentId, { expiresAt: Date.now() - 1 }));
    expect((await redeem(t, ticketOf(expired.uploadUrl))).status).toBe(403);
  });

  test("legacy doors and the avatar are ticketed to their declared size, or the largest file", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    const sized = await A.mutation(api.userFiles.generateUploadUrl, { workspaceId: ws, size: 500 });
    const unsized = await A.mutation(api.files.generateUploadUrl, { workspaceId: ws });
    const chat = await A.mutation(api.chat.attachments.generateUploadUrl, { workspaceId: ws, size: 7 });
    const avatar = await A.mutation(api.users.generateUploadUrl, {});
    const maxOf = async (url: string) => {
      const hash = await hashToken(ticketOf(url));
      return t.run(async (ctx) =>
        (await ctx.db.query("uploadIntents").withIndex("by_ticket", (q) => q.eq("ticketHash", hash)).first())?.maxBytes,
      );
    };
    expect(await maxOf(sized)).toBe(500);
    expect(await maxOf(unsized)).toBe(LIMITS.stored);
    expect(await maxOf(chat)).toBe(7);
    expect(await maxOf(avatar)).toBe(LIMITS.stored);
  });

  test("a legacy claim refuses a blob larger than its ticket admitted", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const A = t.withIdentity(as(a));
    await A.mutation(api.userFiles.generateUploadUrl, { workspaceId: ws, size: 3 });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["0123456789"], { type: "text/plain" })));
    await expect(
      A.mutation(api.userFiles.saveFile, {
        workspaceId: ws, storageId, name: "big.txt", size: 3, contentType: "text/plain", contentHash: "x",
      }),
    ).rejects.toThrow(/Not found/);
  });
});

// ------------------------------------------------------------ deletion

describe("deleting a file deletes all of it", () => {
  test("a generated file: its chat card, its preview pages and every byte go with it", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const { streamId } = await streamFor(t, a, ws);
    const A = t.withIdentity(as(a));
    const parentBlob = await t.run((ctx) => ctx.storage.store(new Blob(["PDF"], { type: "application/pdf" })));
    const parent = await t.mutation(internal.chat.artifacts.registerArtifact, {
      streamId, storageId: parentBlob, filename: "deck.pdf", format: "pdf", mime: "application/pdf", size: 3,
    });
    const pageBlob = await t.run((ctx) => ctx.storage.store(new Blob(["PNG"], { type: "image/png" })));
    await t.mutation(internal.chat.artifacts.registerArtifact, {
      streamId, storageId: pageBlob, filename: "p1.png", format: "png", mime: "image/png", size: 3,
      parentArtifactId: parent.artifactId!, role: "preview", page: 1,
    });
    const file = await t.run((ctx) =>
      ctx.db.query("userFiles").withIndex("by_artifact", (q) => q.eq("artifactId", parent.artifactId!)).first(),
    );
    expect(file?.source).toBe("generated");
    await A.mutation(api.chat.artifacts.mintDownload, { artifactId: parent.artifactId! }); // works before

    await A.mutation(api.library.removeMany, { fileIds: [file!._id] });

    const left = await t.run(async (ctx) => ({
      cards: (await ctx.db.query("chatArtifacts").collect()).length,
      parentBytes: await ctx.db.system.get(parentBlob),
      pageBytes: await ctx.db.system.get(pageBlob),
      gen: (await ctx.db.query("storageUsage").withIndex("by_key", (q) => q.eq("key", genKey(a))).unique())?.usedBytes,
    }));
    expect(left).toEqual({ cards: 0, parentBytes: null, pageBytes: null, gen: 0 });
    await expect(A.mutation(api.chat.artifacts.mintDownload, { artifactId: parent.artifactId! })).rejects.toThrow(
      /Not found/,
    );
  });

  test("an uploaded file: every attachment on its blob goes, even one with no Library link", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const { storageId, fileId } = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["zip"], { type: "application/zip" }));
      const fileId = await createLibraryFile(ctx, {
        userId: a, workspaceId: ws, storageId, name: "a.zip", contentType: "application/zip", size: 3, source: "uploaded",
      });
      // An attachment registered before attachments carried userFileId.
      await ctx.db.insert("chatAttachments", {
        workspaceId: ws, userId: a, storageId, name: "a.zip", size: 3, contentType: "application/zip",
        kind: "document", extractedText: "the content", status: "ready", createdAt: 1,
      });
      return { storageId, fileId };
    });
    await t.withIdentity(as(a)).mutation(api.library.removeMany, { fileIds: [fileId] });
    const left = await t.run(async (ctx) => ({
      attachments: (await ctx.db.query("chatAttachments").collect()).length,
      bytes: await ctx.db.system.get(storageId),
    }));
    expect(left).toEqual({ attachments: 0, bytes: null });
  });

  test("the derived store is purged for EVERY deleted file, stored-only ones included", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const fileId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["zip"], { type: "application/zip" }));
      return createLibraryFile(ctx, {
        userId: a, workspaceId: ws, storageId, name: "keep.zip", contentType: "application/zip", size: 3, source: "uploaded",
      });
    });
    const f = await t.run((ctx) => ctx.db.get(fileId));
    expect(f?.status).toBe("stored");
    await t.withIdentity(as(a)).mutation(api.library.removeMany, { fileIds: [fileId] });
    const purges = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.name.includes("purge")),
    );
    expect(purges.map((p) => (p.args[0] as { ingestId: string }).ingestId)).toContain(f!.ingestId);
  });
});

// ------------------------------------------------------------ generation fence + retries

describe("the generation fence", () => {
  test("a callback from another generation moves nothing; the current one (or an older Python's) does", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await processingFile(t, a, ws);
    expect(f.generation).toBe(1);
    const stale = await t.mutation(internal.userFiles.setStatus, {
      fileId: f.ingestId, status: "failed", error: "Parsing failed", generation: 2,
    });
    expect(stale).toMatchObject({ stale: true });
    expect((await t.run((ctx) => ctx.db.get(f._id)))?.status).toBe("processing");

    await t.mutation(internal.userFiles.setStatus, { fileId: f.ingestId, status: "ready", chunkCount: 3, generation: 1 });
    expect((await t.run((ctx) => ctx.db.get(f._id)))?.status).toBe("ready");

    const g = await processingFile(t, a, ws, "old-python.txt");
    await t.mutation(internal.userFiles.setStatus, { fileId: g.ingestId, status: "ready", chunkCount: 1 });
    expect((await t.run((ctx) => ctx.db.get(g._id)))?.status).toBe("ready");
  });

  test("progress from another generation is ignored too", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await processingFile(t, a, ws);
    await t.mutation(internal.userFiles.setProgress, { fileId: f.ingestId, stage: "embedding", generation: 7 });
    expect((await t.run((ctx) => ctx.db.get(f._id)))?.stage).toBeUndefined();
  });
});

describe("failures, automatic retry and the dead letter", () => {
  const fail = (t: T, ingestId: string, code: string, generation?: number) =>
    t.mutation(internal.userFiles.setStatus, {
      fileId: ingestId, status: "failed", error: `failed: ${code}`, failureCode: code, generation,
    });

  test("a transient failure schedules a retry; a permanent one is a dead letter — both visible", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const transient = await processingFile(t, a, ws, "t.txt");
    const permanent = await processingFile(t, a, ws, "p.txt");
    await fail(t, transient.ingestId, "EMBED_PROVIDER", 1);
    await fail(t, permanent.ingestId, "PARSE_FAILED", 1);
    const [tr, pe] = await t.run(async (ctx) => [await ctx.db.get(transient._id), await ctx.db.get(permanent._id)]);
    expect(tr?.status).toBe("failed");
    expect(tr?.failureCode).toBe("EMBED_PROVIDER");
    expect(tr?.nextRetryAt).toBeGreaterThan(Date.now());
    expect(tr?.deadLetteredAt).toBeUndefined();
    expect(pe?.deadLetteredAt).toBeDefined();
    expect(pe?.nextRetryAt).toBeUndefined();

    const page = await t.withIdentity(as(a)).query(api.library.list, {
      workspaceId: ws, paginationOpts: { numItems: 10, cursor: null },
    });
    const byName = Object.fromEntries(page.page.map((r) => [r.name, r]));
    expect(byName["t.txt"]).toMatchObject({ failureCode: "EMBED_PROVIDER", deadLettered: false });
    expect(byName["t.txt"].retryAt).toBeGreaterThan(0);
    expect(byName["p.txt"]).toMatchObject({ failureCode: "PARSE_FAILED", deadLettered: true, retryAt: null });
  });

  test("the health snapshot tells a corrupt file from a fault that outlasted its retries", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const corrupt = await processingFile(t, a, ws, "c.txt");
    const flaky = await processingFile(t, a, ws, "f.txt");
    await fail(t, corrupt.ingestId, "PARSE_FAILED", 1);
    // A retryable fault on its last automatic retry: dead-lettered, not rescheduled.
    await t.run((ctx) => ctx.db.patch(flaky._id, { autoRetries: AUTO_RETRY_MAX }));
    await fail(t, flaky.ingestId, "EMBED_PROVIDER", 1);
    const h = await t.query(internal.libraryProcessing.healthSnapshot, {});
    expect(h.files.failed).toBe(2);
    expect(h.failedFinal).toBe(1);
    expect(h.deadLettered).toBe(1);
    expect(h.deadLetteredLastDay).toBe(1);
  });

  test("the retry cron re-dispatches due files with a NEW generation, at most a batch per run", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const files: Doc<"userFiles">[] = [];
    for (let i = 0; i < AUTO_RETRY_BATCH + 2; i++) {
      const f = await processingFile(t, a, ws, `f${i}.txt`);
      await fail(t, f.ingestId, "KNOWLEDGE_DB", 1);
      await t.run((ctx) => ctx.db.patch(f._id, { nextRetryAt: Date.now() - 1 }));
      files.push(f);
    }
    const first = await t.mutation(internal.libraryProcessing.autoRetryDue, {});
    expect(first.retried).toBe(AUTO_RETRY_BATCH);
    const after = await t.run(async (ctx) => Promise.all(files.map((f) => ctx.db.get(f._id))));
    const retried = after.filter((f) => f?.status === "processing");
    expect(retried).toHaveLength(AUTO_RETRY_BATCH);
    for (const f of retried) expect(f).toMatchObject({ generation: 2, autoRetries: 1 });

    // The first attempt's late answer lands on the retry — and moves nothing.
    const late = await t.mutation(internal.userFiles.setStatus, {
      fileId: retried[0]!.ingestId, status: "ready", chunkCount: 9, generation: 1,
    });
    expect(late).toMatchObject({ stale: true });
    expect((await t.run((ctx) => ctx.db.get(retried[0]!._id)))?.status).toBe("processing");

    const second = await t.mutation(internal.libraryProcessing.autoRetryDue, {});
    expect(second.retried).toBe(2);
  });

  test(`after ${AUTO_RETRY_MAX} automatic retries the next failure is a dead letter`, async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await processingFile(t, a, ws);
    for (let i = 0; i < AUTO_RETRY_MAX; i++) {
      const cur = (await t.run((ctx) => ctx.db.get(f._id)))!;
      await fail(t, f.ingestId, "EMBED_PROVIDER", cur.generation);
      await t.run((ctx) => ctx.db.patch(f._id, { nextRetryAt: Date.now() - 1 }));
      await t.mutation(internal.libraryProcessing.autoRetryDue, {});
    }
    const cur = (await t.run((ctx) => ctx.db.get(f._id)))!;
    expect(cur.autoRetries).toBe(AUTO_RETRY_MAX);
    await fail(t, f.ingestId, "EMBED_PROVIDER", cur.generation);
    const end = (await t.run((ctx) => ctx.db.get(f._id)))!;
    expect(end.deadLetteredAt).toBeDefined();
    expect(end.nextRetryAt).toBeUndefined();
  });

  test("a retry never pushes a user past their own processing intake", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await processingFile(t, a, ws, "waiting.txt");
    await fail(t, f.ingestId, "TIMEOUT", 1);
    await t.run(async (ctx) => {
      await ctx.db.patch(f._id, { nextRetryAt: Date.now() - 1 });
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("userFiles", {
          userId: a, workspaceId: ws, name: `busy${i}.txt`, size: 1, contentType: "text/plain",
          ingestId: `busy-${i}`, status: "processing", attempts: 0, createdAt: 1, updatedAt: Date.now(),
        });
      }
    });
    const r = await t.mutation(internal.libraryProcessing.autoRetryDue, {});
    expect(r.retried).toBe(0);
    const row = (await t.run((ctx) => ctx.db.get(f._id)))!;
    expect(row.status).toBe("failed");
    expect(row.nextRetryAt).toBeGreaterThan(Date.now());
  });

  test("a hand retry leaves the dead letter with a fresh generation and a fresh budget", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await processingFile(t, a, ws);
    await fail(t, f.ingestId, "PARSE_FAILED", 1);
    const r = await t.withIdentity(as(a)).mutation(api.userFiles.retry, { fileId: f._id });
    expect(r).toEqual({ ok: true });
    const row = (await t.run((ctx) => ctx.db.get(f._id)))!;
    expect(row).toMatchObject({ status: "processing", generation: 2, autoRetries: 0 });
    expect(row.deadLetteredAt).toBeUndefined();
    expect(row.failureCode).toBeUndefined();
  });

  test("requeueFailed: the dry run changes nothing; applying codes the backlog and spreads it out", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const ids = await t.run(async (ctx) => {
      const mk = async (name: string, error: string, withBlob = true) => {
        const storageId = withBlob ? await ctx.storage.store(new Blob([name])) : undefined;
        return ctx.db.insert("userFiles", {
          userId: a, workspaceId: ws, name, size: 1, contentType: "text/plain", ingestId: `i-${name}`,
          status: "failed", attempts: 0, error, createdAt: 1, updatedAt: 1, ...(storageId ? { storageId } : {}),
        });
      };
      return [
        await mk("e1", "Embedding provider failed"),
        await mk("e2", "Knowledge database write failed"),
        await mk("e3", "Ingest service responded 429"),
        await mk("p1", "Parsing failed"),
        await mk("gone", "Embedding provider failed", false),
      ];
    });
    const dry = await t.mutation(internal.libraryProcessing.requeueFailed, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, requeue: 3, deadLetter: 1, needsReupload: 1 });
    expect(dry.byCode).toEqual({ EMBED_PROVIDER: 2, KNOWLEDGE_DB: 1, QUEUE_EXHAUSTED: 1, PARSE_FAILED: 1 });
    const untouched = await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
    for (const r of untouched) expect(r?.failureCode).toBeUndefined();

    const applied = await t.mutation(internal.libraryProcessing.requeueFailed, { dryRun: false });
    expect(applied).toMatchObject({ requeue: 3, deadLetter: 1, needsReupload: 1 });
    const rows = await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
    const due = rows.filter((r) => r?.nextRetryAt !== undefined).map((r) => r!.nextRetryAt!);
    expect(due).toHaveLength(3);
    expect(new Set(due).size).toBe(3); // staggered, not one wave
    expect(rows[3]?.deadLetteredAt).toBeDefined();
    expect(rows[4]?.deadLetteredAt).toBeDefined();

    const again = await t.mutation(internal.libraryProcessing.requeueFailed, { dryRun: false });
    expect(again).toMatchObject({ requeue: 0, deadLetter: 0, alreadyHandled: 5 });
  });
});

// ------------------------------------------------------------ re-index

describe("re-index keeps files searchable", () => {
  async function readyFile(t: T, a: Id<"users">, ws: Id<"workspaces">) {
    const f = await processingFile(t, a, ws);
    await t.mutation(internal.userFiles.setStatus, { fileId: f.ingestId, status: "ready", chunkCount: 2, generation: 1 });
    return f;
  }

  test("the file stays ready (and in the RAG scope) until the new chunks are swapped in", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await readyFile(t, a, ws);
    const r = await t.mutation(internal.libraryProcessing.startReindex, { ingestIds: [f.ingestId] });
    expect(r.started).toBe(1);
    const mid = (await t.run((ctx) => ctx.db.get(f._id)))!;
    expect(mid).toMatchObject({ status: "ready", reindexing: true, generation: 2 });
    expect(await t.run((ctx) => accountRagScope(ctx, a))).toContain(f.ingestId);
    const payload = await t.query(internal.userFiles.dispatchPayload, { fileId: f._id });
    expect(payload).toMatchObject({ generation: 2, reindex: true });

    await t.mutation(internal.userFiles.setStatus, { fileId: f.ingestId, status: "ready", chunkCount: 5, generation: 2 });
    const end = (await t.run((ctx) => ctx.db.get(f._id)))!;
    expect(end).toMatchObject({ status: "ready", chunkCount: 5 });
    expect(end.reindexing).toBeUndefined();
  });

  test("a failed re-index leaves the file ready on its old chunks, and gives up after its attempts", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await readyFile(t, a, ws);
    for (let i = 0; i < REINDEX_MAX_ATTEMPTS; i++) {
      const r = await t.mutation(internal.libraryProcessing.startReindex, { ingestIds: [f.ingestId] });
      expect(r.started).toBe(1);
      const cur = (await t.run((ctx) => ctx.db.get(f._id)))!;
      await t.mutation(internal.userFiles.setStatus, {
        fileId: f.ingestId, status: "failed", error: "Embedding provider failed", generation: cur.generation,
      });
      const after = (await t.run((ctx) => ctx.db.get(f._id)))!;
      expect(after.status).toBe("ready");
      expect(after.chunkCount).toBe(2);
    }
    const skipped = await t.mutation(internal.libraryProcessing.startReindex, { ingestIds: [f.ingestId] });
    expect(skipped.started).toBe(0);
  });

  test("a stalled re-index is reaped, and its late answer is ignored", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await readyFile(t, a, ws);
    await t.mutation(internal.libraryProcessing.startReindex, { ingestIds: [f.ingestId] });
    await t.run((ctx) => ctx.db.patch(f._id, { reindexStartedAt: Date.now() - 60 * 60_000 }));
    await t.mutation(internal.userFiles.reapStalled, {});
    const reaped = (await t.run((ctx) => ctx.db.get(f._id)))!;
    expect(reaped.reindexing).toBeUndefined();
    expect(reaped.generation).toBe(3);
    const late = await t.mutation(internal.userFiles.setStatus, {
      fileId: f.ingestId, status: "ready", chunkCount: 99, generation: 2,
    });
    expect(late).toMatchObject({ stale: true });
    expect((await t.run((ctx) => ctx.db.get(f._id)))?.chunkCount).toBe(2);
  });
});

// ------------------------------------------------------------ reconcile, health, generated budget

describe("cross-plane reconcile and the host health snapshot", () => {
  test("only ids no Convex file owns are reported for purging", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const f = await processingFile(t, a, ws);
    const unknown = await t.query(internal.libraryProcessing.unknownIngestIds, { ids: [f.ingestId, "gone-1", "gone-2"] });
    expect(unknown).toEqual(["gone-1", "gone-2"]);
  });

  test("/ops/library-health answers only the monitor's own key, with counts", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    await processingFile(t, a, ws);
    expect((await t.fetch("/ops/library-health", { headers: { "x-ops-key": "nope" } })).status).toBe(401);
    expect((await t.fetch("/ops/library-health", { headers: { "x-ops-key": EDGE } })).status).toBe(401);
    const res = await t.fetch("/ops/library-health", { headers: { "x-ops-key": OPS } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.processing).toBe(1);
    expect(body).toHaveProperty("deadLettered", 0);
    expect(JSON.stringify(body)).not.toContain("notes.txt"); // counts, never names
  });
});

describe("generated files have their own bounds", () => {
  const post = (t: T, streamId: string, bytes: number) =>
    t.fetch("/ai/artifact", {
      method: "POST",
      headers: {
        "x-ai-key": INGRESS,
        "x-stream-id": streamId,
        "x-artifact-format": "pdf",
        "x-artifact-filename": "out.pdf",
        "content-type": "application/pdf",
      },
      body: new Uint8Array(bytes),
    });

  test("past the live cap an artifact is refused BEFORE any byte is stored", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const { streamId } = await streamFor(t, a, ws);
    await t.run((ctx) => ctx.db.insert("storageUsage", { key: genKey(a), usedBytes: GENERATED_LIVE_BYTES - 5, files: 1 }));
    const blobsBefore = await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
    const refused = await post(t, streamId, 64);
    expect(refused.status).toBe(507);
    expect((await refused.json()).error).toBe("GENERATED_FULL");
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(blobsBefore);

    const fits = await post(t, streamId, 4);
    expect(fits.status).toBe(200);
  });

  test("recomputeUsage rebuilds the generated ledger from the rows", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const { streamId } = await streamFor(t, a, ws);
    const blob = await t.run((ctx) => ctx.storage.store(new Blob(["abcdef"], { type: "application/pdf" })));
    await t.mutation(internal.chat.artifacts.registerArtifact, {
      streamId, storageId: blob, filename: "g.pdf", format: "pdf", mime: "application/pdf", size: 6,
    });
    // Drift the ledger, then recompute it from the rows.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("storageUsage").withIndex("by_key", (q) => q.eq("key", genKey(a))).unique();
      if (row) await ctx.db.patch(row._id, { usedBytes: 999, files: 9 });
    });
    const r = await t.mutation(internal.libraryMigrations.recomputeUsage, { dryRun: false });
    expect(r.diffs).toContainEqual({ key: genKey(a), live: 999, truth: 6 });
    const fixed = await t.run((ctx) =>
      ctx.db.query("storageUsage").withIndex("by_key", (q) => q.eq("key", genKey(a))).unique(),
    );
    expect(fixed).toMatchObject({ usedBytes: 6, files: 1 });
  });

  test("the upload quota is untouched by generated files", async () => {
    const t = makeTest();
    const { a, ws } = await seed(t);
    const { streamId } = await streamFor(t, a, ws);
    const blob = await t.run((ctx) => ctx.storage.store(new Blob(["x".repeat(3 * MB)], { type: "application/pdf" })));
    await t.mutation(internal.chat.artifacts.registerArtifact, {
      streamId, storageId: blob, filename: "big.pdf", format: "pdf", mime: "application/pdf", size: 3 * MB,
    });
    const summary = await t.withIdentity(as(a)).query(api.library.storageSummary, {});
    expect(summary?.usedBytes).toBe(0);
  });
});
