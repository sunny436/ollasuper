/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// saveFile schedules internal.userFiles.dispatch, which POSTs /v1/ingest. Point
// it at a stub and intercept fetch so the scheduler is deterministic; drain()
// runs the scheduled action inside the test transaction.
const realFetch = globalThis.fetch;
let posts: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ ingestId: "x" }), { status: 202 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: the only way to unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to unset an env var
  delete process.env.AI_SERVICE_KEY;
});

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: ReturnType<typeof convexTest>) {
  const seeded = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const other = await ctx.db.insert("users", { email: "other@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const userId of [owner, other]) {
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId,
        role: "member",
        createdAt: Date.now(),
      });
    }
    return { owner, other, ws };
  });
  // The owner's upload, done the way the client does it (audit F-01): the
  // upload URL — i.e. the owner's upload intent — comes BEFORE the bytes.
  await t
    .withIdentity(as(seeded.owner))
    .mutation(api.userFiles.generateUploadUrl, { workspaceId: seeded.ws });
  const storageId = await t.run(async (ctx) =>
    ctx.storage.store(new Blob(["hello world"])),
  );
  return { ...seeded, storageId };
}

const pageOpts = { numItems: 20, cursor: null };

test("saveFile creates a processing row, schedules ingest, and dedups by hash", async () => {
  const t = convexTest(schema, modules);
  const { owner, ws, storageId } = await seed(t);
  const u = t.withIdentity(as(owner));

  const id = await u.mutation(api.userFiles.saveFile, {
    workspaceId: ws,
    storageId,
    name: "a.pdf",
    size: 5,
    contentType: "application/pdf",
    contentHash: "hash1",
  });
  await drain(t);

  expect(posts.some((p) => p.url.endsWith("/v1/ingest"))).toBe(true);
  const row = await t.run(async (ctx) => ctx.db.get(id));
  expect(row?.status).toBe("processing");

  // Same content hash → same row, no duplicate (drops the redundant blob).
  await u.mutation(api.userFiles.generateUploadUrl, { workspaceId: ws });
  const storageId2 = await t.run(async (ctx) =>
    ctx.storage.store(new Blob(["hello world 2"])),
  );
  const id2 = await u.mutation(api.userFiles.saveFile, {
    workspaceId: ws,
    storageId: storageId2,
    name: "a.pdf",
    size: 6,
    contentType: "application/pdf",
    contentHash: "hash1",
  });
  expect(id2).toBe(id);
});

test("files are private-per-user; a non-owner cannot list or delete them", async () => {
  const t = convexTest(schema, modules);
  const { owner, other, ws, storageId } = await seed(t);
  const id = await t.withIdentity(as(owner)).mutation(api.userFiles.saveFile, {
    workspaceId: ws,
    storageId,
    name: "a.pdf",
    size: 5,
    contentType: "application/pdf",
    contentHash: "h",
  });
  await drain(t);

  const otherList = await t
    .withIdentity(as(other))
    .query(api.userFiles.list, { workspaceId: ws, paginationOpts: pageOpts });
  expect(otherList.page.length).toBe(0); // invisible to a same-workspace peer

  const ownerList = await t
    .withIdentity(as(owner))
    .query(api.userFiles.list, { workspaceId: ws, paginationOpts: pageOpts });
  expect(ownerList.page.length).toBe(1);
  // The capability + storageId are never exposed to the client.
  expect("ingestId" in ownerList.page[0]).toBe(false);
  expect("storageId" in ownerList.page[0]).toBe(false);

  await expect(
    t.withIdentity(as(other)).mutation(api.userFiles.remove, { fileId: id }),
  ).rejects.toThrow(/Not found/);
});

test("setStatus is capability-scoped by ingestId and terminal-once", async () => {
  const t = convexTest(schema, modules);
  const { owner, ws, storageId } = await seed(t);
  const id = await t.withIdentity(as(owner)).mutation(api.userFiles.saveFile, {
    workspaceId: ws,
    storageId,
    name: "a.pdf",
    size: 5,
    contentType: "application/pdf",
    contentHash: "h",
  });
  await drain(t);
  const ingestId = await t.run(async (ctx) => {
    const row = await ctx.db.get(id);
    return row?.ingestId as string;
  });

  // Unknown ingestId → {unknown:true} (the /ai/ingress "file" op maps to 404).
  const r0 = await t.mutation(internal.userFiles.setStatus, {
    fileId: "does-not-exist",
    status: "ready",
  });
  expect("unknown" in r0 && r0.unknown).toBe(true);

  await t.mutation(internal.userFiles.setStatus, {
    fileId: ingestId,
    status: "ready",
    chunkCount: 3,
    detectedType: "pdf",
  });
  let row = await t.run(async (ctx) => ctx.db.get(id));
  expect(row?.status).toBe("ready");
  expect(row?.chunkCount).toBe(3);
  expect(row?.storageId).toBeUndefined(); // staging blob dropped on ready

  // A later callback cannot resurrect a terminal row.
  await t.mutation(internal.userFiles.setStatus, {
    fileId: ingestId,
    status: "failed",
    error: "late",
  });
  row = await t.run(async (ctx) => ctx.db.get(id));
  expect(row?.status).toBe("ready");
});

test("remove deletes the row and schedules the Postgres purge", async () => {
  const t = convexTest(schema, modules);
  const { owner, ws, storageId } = await seed(t);
  const id = await t.withIdentity(as(owner)).mutation(api.userFiles.saveFile, {
    workspaceId: ws,
    storageId,
    name: "a.pdf",
    size: 5,
    contentType: "application/pdf",
    contentHash: "h",
  });
  await drain(t);
  posts = [];
  await t.withIdentity(as(owner)).mutation(api.userFiles.remove, { fileId: id });
  await drain(t);
  expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  expect(posts.some((p) => p.url.includes("/v1/ingest/"))).toBe(true);
});
