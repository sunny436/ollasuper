/// <reference types="vite/client" />
/**
 * Regression suite for SECURITY-AUDIT-FINAL.md (2026-09-25).
 *
 * Every block reproduces the audit's own failing case against the real
 * handlers and asserts the boundary now holds — plus a positive control, so a
 * "fix" that simply refuses everything cannot pass.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = TestConvex<typeof schema>;

const DAY = 24 * 60 * 60 * 1000;

async function seed(t: TestT) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const member = await ctx.db.insert("users", { email: "member@t.test" });
    const attacker = await ctx.db.insert("users", { email: "attacker@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "Shared",
      ownerId: owner,
      createdAt: Date.now(),
    });
    const attackerWs = await ctx.db.insert("workspaces", {
      name: "Mine",
      ownerId: attacker,
      createdAt: Date.now(),
    });
    for (const [userId, workspaceId, role] of [
      [owner, ws, "owner"],
      [member, ws, "member"],
      [attacker, attackerWs, "owner"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId,
        userId,
        role,
        createdAt: Date.now(),
      });
    }
    return { owner, member, attacker, ws, attackerWs };
  });
}

/** The client's upload: ask for the URL (records the intent), then store. */
async function uploadAs(
  t: TestT,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  body = "bytes",
): Promise<Id<"_storage">> {
  await t
    .withIdentity(as(userId))
    .mutation(api.chat.attachments.generateUploadUrl, { workspaceId: ws });
  return t.run((ctx) => ctx.storage.store(new Blob([body], { type: "text/plain" })));
}

/** Run the self-rescheduling deletion cascade to completion. */
async function drain(t: TestT) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

const blobExists = (t: TestT, id: Id<"_storage">) =>
  t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);

async function memberRow(t: TestT, userId: Id<"users">, ws: Id<"workspaces">) {
  return t.run((ctx) =>
    ctx.db
      .query("members")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", userId).eq("workspaceId", ws),
      )
      .unique(),
  );
}

// ---------------------------------------------------------------- F-01
describe("F-01: a blob belongs to the user who uploaded it", () => {
  test("a known foreign storage id cannot be registered through ANY path, and its bytes survive", async () => {
    const t = convexTest(schema, modules);
    const { owner, attacker, ws, attackerWs } = await seed(t);
    const victimBlob = await uploadAs(t, owner, ws, "victim");
    await t.withIdentity(as(owner)).mutation(api.chat.attachments.register, {
      workspaceId: ws,
      storageId: victimBlob,
      name: "v.txt",
      size: 6,
      contentType: "text/plain",
    });

    const a = t.withIdentity(as(attacker));
    // The attacker holds live intents of their own — the only thing missing is
    // provenance of THIS blob.
    await a.mutation(api.files.generateUploadUrl, { workspaceId: attackerWs });
    await a.mutation(api.userFiles.generateUploadUrl, { workspaceId: attackerWs });
    await a.mutation(api.users.generateUploadUrl, {});
    // The duplicate path needs one of the attacker's OWN hashes on file.
    const own = await uploadAs(t, attacker, attackerWs, "mine");
    await a.mutation(api.userFiles.saveFile, {
      workspaceId: attackerWs,
      storageId: own,
      name: "mine.txt",
      size: 4,
      contentType: "text/plain",
      contentHash: "attacker-hash",
    });

    await expect(
      a.mutation(api.files.saveFile, {
        workspaceId: attackerWs,
        storageId: victimBlob,
        name: "x",
        size: 1,
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/Not found/);
    await expect(
      a.mutation(api.userFiles.saveFile, {
        workspaceId: attackerWs,
        storageId: victimBlob,
        name: "x",
        size: 1,
        contentType: "text/plain",
        contentHash: "attacker-hash", // the duplicate path that used to DELETE it
      }),
    ).rejects.toThrow(/Not found/);
    await expect(
      a.mutation(api.chat.attachments.register, {
        workspaceId: attackerWs,
        storageId: victimBlob,
        name: "x.txt",
        size: 1,
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/Not found/);
    await expect(
      a.mutation(api.users.updateUserImage, { imageId: victimBlob }),
    ).rejects.toThrow(/Not found/);

    expect(await blobExists(t, victimBlob)).toBe(true);
    await drain(t); // the attacker's own saveFile queued an ingest dispatch
  });

  test("an unregistered blob that predates the caller's intent is not claimable", async () => {
    const t = convexTest(schema, modules);
    const { attacker, attackerWs } = await seed(t);
    // Stored with no intent at all (e.g. server-side, or a leaked id).
    const stray = await t.run((ctx) =>
      ctx.storage.store(new Blob(["stray"], { type: "text/plain" })),
    );
    // Strictly BEFORE the intent: on a fast runner both land in the same
    // millisecond, and an intent issued at that instant legitimately covers it.
    await new Promise((r) => setTimeout(r, 5));
    const a = t.withIdentity(as(attacker));
    await a.mutation(api.files.generateUploadUrl, { workspaceId: attackerWs });
    await expect(
      a.mutation(api.files.saveFile, {
        workspaceId: attackerWs,
        storageId: stray,
        name: "x",
        size: 5,
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/Not found/);
    expect(await blobExists(t, stray)).toBe(true);
  });

  test("the uploader's own flow still works, and one intent claims one blob", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));
    await u.mutation(api.files.generateUploadUrl, { workspaceId: ws });
    const b1 = await t.run((ctx) => ctx.storage.store(new Blob(["one"])));
    const b2 = await t.run((ctx) => ctx.storage.store(new Blob(["two"])));
    const args = { workspaceId: ws, name: "f", size: 3, contentType: "text/plain" };
    await u.mutation(api.files.saveFile, { ...args, storageId: b1 });
    // The single intent was consumed by b1.
    await expect(u.mutation(api.files.saveFile, { ...args, storageId: b2 })).rejects.toThrow(
      /Not found/,
    );
  });

  test("deleting one of two rows that share a blob (a legacy alias) keeps the bytes", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const shared = await t.run((ctx) => ctx.storage.store(new Blob(["shared"])));
    const [f1, f2] = await t.run(async (ctx) => {
      const row = {
        workspaceId: ws,
        userId: owner,
        name: "s",
        storageId: shared,
        size: 6,
        contentType: "text/plain",
        createdAt: Date.now(),
      };
      return [await ctx.db.insert("files", row), await ctx.db.insert("files", row)];
    });
    const u = t.withIdentity(as(owner));
    await u.mutation(api.files.remove, { fileId: f1 });
    expect(await blobExists(t, shared)).toBe(true);
    await u.mutation(api.files.remove, { fileId: f2 });
    expect(await blobExists(t, shared)).toBe(false);
  });
});

// ---------------------------------------------------------------- F-05
describe("F-05: revoking a session revokes API access immediately", () => {
  test("a revoked session reads nothing and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t);
    const u = t.withIdentity(as(owner));
    expect((await u.query(api.orgs.myWorkspaces, {})).length).toBeGreaterThan(0);

    // Sign-out / displacement / reset all DELETE the session row; the access
    // token itself stays signed and unexpired.
    await t.run(async (ctx) => {
      for (const s of await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", owner))
        .collect()) {
        await ctx.db.delete(s._id);
      }
    });

    expect(await u.query(api.orgs.myWorkspaces, {})).toEqual([]);
    await expect(u.mutation(api.orgs.createWorkspace, { name: "n" })).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(u.mutation(api.users.updateName, { name: "x" })).rejects.toThrow(
      /Not authenticated/,
    );
  });

  test("an expired session and another user's session are refused too", async () => {
    const t = convexTest(schema, modules);
    const { owner, member } = await seed(t);
    const [expired, foreign] = await t.run(async (ctx) => [
      await ctx.db.insert("authSessions", {
        userId: owner,
        expirationTime: Date.now() - 1,
      }),
      await ctx.db.insert("authSessions", {
        userId: member,
        expirationTime: Date.now() + DAY,
      }),
    ]);
    for (const sid of [expired, foreign]) {
      expect(
        await t
          .withIdentity({ subject: `${owner}|${sid}` })
          .query(api.orgs.myWorkspaces, {}),
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- F-08
describe("F-08: current entitlement, not past", () => {
  async function removeMember(t: TestT, ws: Id<"workspaces">, owner: Id<"users">, member: Id<"users">) {
    const row = await memberRow(t, member, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.orgs.removeMember, { workspaceId: ws, memberId: row!._id });
  }

  test("a removed member's API key stops resolving (revoked AND re-checked)", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        workspaceId: ws,
        userId: member,
        name: "k",
        prefix: "sk_x",
        hash: "h-removed",
        revoked: false,
        createdAt: Date.now(),
      }),
    );
    const resolve = (hash: string) =>
      t.run((ctx) => ctx.runQuery(internal.apiKeys.resolveByHash, { hash }));
    expect(await resolve("h-removed")).not.toBeNull();
    await removeMember(t, ws, owner, member);
    expect(await resolve("h-removed")).toBeNull();

    // Independent of revocation: membership deleted out-of-band.
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    await t2.run(async (ctx) => {
      await ctx.db.insert("apiKeys", {
        workspaceId: s2.ws,
        userId: s2.member,
        name: "k",
        prefix: "sk_y",
        hash: "h-stale",
        revoked: false,
        createdAt: Date.now(),
      });
      const m = await ctx.db
        .query("members")
        .withIndex("by_user_workspace", (q) =>
          q.eq("userId", s2.member).eq("workspaceId", s2.ws),
        )
        .unique();
      await ctx.db.delete(m!._id);
    });
    expect(
      await t2.run((ctx) =>
        ctx.runQuery(internal.apiKeys.resolveByHash, { hash: "h-stale" }),
      ),
    ).toBeNull();
  });

  test("scheduled task list matches detail: removed or suspended owners see nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    const m = t.withIdentity(as(member));
    await m.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Digest",
      prompt: "Summarise my private inbox",
      spec: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    });
    expect(await m.query(api.scheduled.tasks.list, {})).toHaveLength(1);
    await removeMember(t, ws, owner, member);
    expect(await m.query(api.scheduled.tasks.list, {})).toEqual([]);
    expect(await m.query(api.scheduled.tasks.list, { workspaceId: ws })).toEqual([]);

    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    const o2 = t2.withIdentity(as(s2.owner));
    await o2.mutation(api.scheduled.tasks.create, {
      workspaceId: s2.ws,
      title: "Digest",
      prompt: "Summarise my private inbox",
      spec: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    });
    await t2.run((ctx) => ctx.db.patch(s2.owner, { accountStatus: "suspended" }));
    expect(await o2.query(api.scheduled.tasks.list, {})).toEqual([]);
    await drain(t);
    await drain(t2);
  });

  test("SEO history and knowledge-file retry require current membership", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    const fileId = await t.run(async (ctx) => {
      await ctx.db.insert("seoMutations", {
        approvalId: "ap-1",
        userId: member,
        workspaceId: ws,
        toolId: "seo_update_metadata",
        action: "update_metadata",
        target: "https://example.com/",
        provider: "seo_write",
        argsHash: "x",
        reversibility: "reversible",
        status: "succeeded",
        rollbackStatus: "not_needed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("userFiles", {
        userId: member,
        workspaceId: ws,
        name: "f.pdf",
        size: 1,
        contentType: "application/pdf",
        ingestId: "ing-1",
        status: "failed",
        attempts: 3,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const m = t.withIdentity(as(member));
    expect(await m.query(api.seoMutations.listMyMutations, {})).toHaveLength(1);
    await removeMember(t, ws, owner, member);
    expect(await m.query(api.seoMutations.listMyMutations, {})).toEqual([]);
    await expect(m.mutation(api.userFiles.retry, { fileId })).rejects.toThrow(
      /Forbidden/,
    );
  });

  test("retrieval scope follows the workspace-gated file policy", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    const personal = await t.run(async (ctx) => {
      const p = await ctx.db.insert("workspaces", {
        name: "Personal",
        ownerId: member,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        workspaceId: p,
        userId: member,
        role: "owner",
        createdAt: Date.now(),
      });
      for (const [workspaceId, ingestId] of [
        [ws, "in-shared"],
        [p, "in-personal"],
      ] as const) {
        await ctx.db.insert("userFiles", {
          userId: member,
          workspaceId,
          name: "f",
          size: 1,
          contentType: "text/plain",
          ingestId,
          status: "ready",
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return p;
    });
    const { accountRagScope } = await import("./userFiles");
    // Every file entitled: the whole corpus, exactly as before (null).
    expect(await t.run((ctx) => accountRagScope(ctx, member))).toBeNull();
    await removeMember(t, ws, owner, member);
    // Removed from `ws`: only the still-entitled file is in scope.
    expect(await t.run((ctx) => accountRagScope(ctx, member))).toEqual([
      "in-personal",
    ]);
    expect(personal).toBeDefined();
  });
});

// ---------------------------------------------------------------- F-10
describe("F-10: the legacy relay cannot choose a tenant", () => {
  test("the public relay action no longer exists", async () => {
    const backend = await import("./backend");
    expect("callBackend" in backend).toBe(false);
    // The operator-only internal variant remains.
    expect("callBackendInternal" in backend).toBe(true);
  });

  test("a webhook payload's workspaceId is never trusted", async () => {
    const t = convexTest(schema, modules);
    const { ws } = await seed(t);
    process.env.BACKEND_WEBHOOK_SECRET = "abcdefghijklmnop";
    try {
      const res = await t.fetch("/backend/webhook", {
        method: "POST",
        headers: {
          "x-webhook-secret": "abcdefghijklmnop",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "demo.echo", workspaceId: ws, note: "x" }),
      });
      expect(res.status).toBe(200);
    } finally {
      // biome-ignore lint/performance/noDelete: must be absent, not "undefined"
      delete process.env.BACKEND_WEBHOOK_SECRET;
    }
    const events = await t.run((ctx) => ctx.db.query("events").collect());
    expect(events).toHaveLength(1);
    expect(events[0]?.workspaceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------- F-11
describe("F-11: removal is a revocation boundary for invitations", () => {
  test("the audit repro: a second pending invite no longer restores a removed member", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const joiner = await t.run((ctx) =>
      ctx.db.insert("users", { email: "joiner@t.test" }),
    );
    const o = t.withIdentity(as(owner));
    const first = await o.mutation(api.orgs.invite, {
      workspaceId: ws,
      email: "joiner@t.test",
      role: "member",
    });
    // A repeat invite REFRESHES the pending grant instead of stacking one.
    const again = await o.mutation(api.orgs.invite, {
      workspaceId: ws,
      email: "joiner@t.test",
      role: "admin",
    });
    expect(again).toBe(first);

    const j = t.withIdentity(as(joiner));
    await j.mutation(api.orgs.acceptInvite, { inviteId: first });
    // Inviting someone who is already a member is refused outright.
    await expect(
      o.mutation(api.orgs.invite, { workspaceId: ws, email: "joiner@t.test", role: "admin" }),
    ).rejects.toThrow(/Already a member/);

    // A grant slipped in while they were a member (the pre-fix duplicate)...
    const stale = await t.run((ctx) =>
      ctx.db.insert("invites", {
        workspaceId: ws,
        email: "joiner@t.test",
        role: "admin",
        invitedBy: owner,
        accepted: false,
        createdAt: Date.now(),
      }),
    );
    const row = await memberRow(t, joiner, ws);
    await o.mutation(api.orgs.removeMember, { workspaceId: ws, memberId: row!._id });
    // ...is revoked by the removal itself.
    expect(await t.run((ctx) => ctx.db.get(stale))).toBeNull();
    expect(await memberRow(t, joiner, ws)).toBeNull();
  });

  test("an invite dies with its issuer's authority, its age, and its workspace", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    const [alice, bob, carol] = await t.run(async (ctx) => [
      await ctx.db.insert("users", { email: "alice@t.test" }),
      await ctx.db.insert("users", { email: "bob@t.test" }),
      await ctx.db.insert("users", { email: "carol@t.test" }),
    ]);
    const invite = (email: string, invitedBy: Id<"users">, createdAt = Date.now()) =>
      t.run((ctx) =>
        ctx.db.insert("invites", {
          workspaceId: ws,
          email,
          role: "member",
          invitedBy,
          accepted: false,
          createdAt,
        }),
      );
    // Issued by a plain member (never had authority, or was demoted).
    const fromMember = await invite("alice@t.test", member);
    await expect(
      t.withIdentity(as(alice)).mutation(api.orgs.acceptInvite, { inviteId: fromMember }),
    ).rejects.toThrow(/Invite not found/);
    // Expired.
    const old = await invite("bob@t.test", owner, Date.now() - 8 * DAY);
    await expect(
      t.withIdentity(as(bob)).mutation(api.orgs.acceptInvite, { inviteId: old }),
    ).rejects.toThrow(/Invite not found/);
    // Positive control: a fresh invite from the owner works.
    const fresh = await invite("carol@t.test", owner);
    await t.withIdentity(as(carol)).mutation(api.orgs.acceptInvite, { inviteId: fresh });
    expect(await memberRow(t, carol, ws)).not.toBeNull();
    // A deleting workspace grants nothing — even to an existing member.
    await t.run((ctx) => ctx.db.patch(ws, { deletingAt: Date.now() }));
    await expect(
      t.withIdentity(as(carol)).query(api.orgs.members, { workspaceId: ws }),
    ).rejects.toThrow(/Forbidden/);
  });
});

// ---------------------------------------------------------------- F-12
describe("F-12: account deletion drains everything before the parent goes", () => {
  test("201 files, 201 invites, an unsent upload and a big message all go; no invite survives", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, invitee, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "leaving@t.test" });
      const invitee = await ctx.db.insert("users", { email: "invitee@t.test" });
      const ws = await ctx.db.insert("workspaces", {
        name: "Solo",
        ownerId: userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId,
        role: "owner",
        createdAt: Date.now(),
      });
      for (let i = 0; i < 201; i++) {
        const storageId = await ctx.storage.store(new Blob([`f${i}`]));
        await ctx.db.insert("files", {
          workspaceId: ws,
          userId,
          name: `f${i}`,
          storageId,
          size: 2,
          contentType: "text/plain",
          createdAt: Date.now(),
        });
        await ctx.db.insert("invites", {
          workspaceId: ws,
          email: i === 200 ? "invitee@t.test" : `x${i}@t.test`,
          role: "member",
          invitedBy: userId,
          accepted: false,
          createdAt: Date.now(),
        });
      }
      // An upload attached in the composer and never sent: no threadId.
      await ctx.db.insert("chatAttachments", {
        workspaceId: ws,
        userId,
        storageId: await ctx.storage.store(new Blob(["draft"])),
        name: "draft.txt",
        size: 5,
        contentType: "text/plain",
        kind: "text",
        status: "uploaded",
        createdAt: Date.now(),
      });
      const threadId = await ctx.db.insert("chatThreads", {
        userId,
        workspaceId: ws,
        title: "t",
        titleSource: "user",
        status: "active",
        pinned: false,
        model: "m",
        nextSeq: 1,
        messageCount: 1,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const messageId = await ctx.db.insert("chatMessages", {
        threadId,
        userId,
        workspaceId: ws,
        role: "assistant",
        content: "x",
        seq: 0,
        status: "complete",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      for (let seq = 0; seq < 250; seq++) {
        await ctx.db.insert("chatStreamChunks", {
          messageId,
          streamId: "s-leaving",
          seq,
          text: ".",
        });
      }
      return { userId, ws, invitee, messageId };
    });

    await t.mutation(internal.users.deleteUserAccount, { userId });
    await drain(t);

    const left = await t.run(async (ctx) => ({
      workspace: await ctx.db.get(ws),
      files: await ctx.db.query("files").collect(),
      invites: await ctx.db.query("invites").collect(),
      members: await ctx.db.query("members").collect(),
      attachments: await ctx.db.query("chatAttachments").collect(),
      message: await ctx.db.get(messageId),
      chunks: await ctx.db
        .query("chatStreamChunks")
        .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
        .collect(),
      blobs: await ctx.db.system.query("_storage").collect(),
    }));
    expect(left.workspace).toBeNull();
    expect(left.files).toEqual([]);
    expect(left.invites).toEqual([]);
    expect(left.members).toEqual([]);
    expect(left.attachments).toEqual([]);
    expect(left.message).toBeNull();
    expect(left.chunks).toEqual([]);
    expect(left.blobs).toEqual([]);
    // Nothing left to accept, and the invitee is a member of nothing.
    expect(await memberRow(t, invitee, ws)).toBeNull();
  });

  test("reconcileOrphans reports rows stranded by earlier sweeps and removes them only on apply", async () => {
    const t = convexTest(schema, modules);
    const { orphanFile, blob } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { email: "o@t.test" });
      const ws = await ctx.db.insert("workspaces", {
        name: "gone",
        ownerId: owner,
        createdAt: Date.now(),
      });
      const blob = await ctx.storage.store(new Blob(["residual"]));
      const orphanFile = await ctx.db.insert("files", {
        workspaceId: ws,
        userId: owner,
        name: "r",
        storageId: blob,
        size: 8,
        contentType: "text/plain",
        createdAt: Date.now(),
      });
      await ctx.db.delete(ws);
      return { orphanFile, blob };
    });
    const dry = await t.mutation(internal.authDeletion.reconcileOrphans, { table: "files" });
    expect(dry.orphans).toEqual([orphanFile]);
    expect(await t.run((ctx) => ctx.db.get(orphanFile))).not.toBeNull();
    await t.mutation(internal.authDeletion.reconcileOrphans, { table: "files", apply: true });
    expect(await t.run((ctx) => ctx.db.get(orphanFile))).toBeNull();
    expect(await blobExists(t, blob)).toBe(false);
  });
});
