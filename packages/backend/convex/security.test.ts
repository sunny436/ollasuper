/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { requireMember, requireRole } from "./orgs";

// Discover function modules for convex-test (includes _generated, excludes *.test.ts).
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

// Identity helper — getAuthUserId reads `subject = userId|sessionId`.
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const member = await ctx.db.insert("users", { email: "member@t.test" });
    const outsider = await ctx.db.insert("users", { email: "outsider@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    const memberRow = await ctx.db.insert("members", {
      workspaceId: ws,
      userId: member,
      role: "member",
      createdAt: Date.now(),
    });
    return { owner, member, outsider, ws, memberRow };
  });
}

describe("authorization helpers", () => {
  test("requireMember throws for a non-member", async () => {
    const t = convexTest(schema, modules);
    const { ws, outsider, member } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      await expect(requireMember(ctx, member, ws)).resolves.toBeTruthy();
      await expect(requireMember(ctx, outsider, ws)).rejects.toThrow(/Forbidden/);
    });
  });

  test("requireRole(owner) rejects a plain member", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      await expect(requireRole(ctx, owner, ws, ["owner"])).resolves.toBeTruthy();
      await expect(requireRole(ctx, member, ws, ["owner"])).rejects.toThrow(/Forbidden/);
    });
  });
});

describe("member management (RBAC + integrity)", () => {
  test("removeMember refuses to remove the owner", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    const ownerMemberRow = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("members")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
          .collect()
      ).find((m) => m.role === "owner")?._id,
    );
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.orgs.removeMember, { workspaceId: ws, memberId: ownerMemberRow! }),
    ).rejects.toThrow(/owner/i);
  });

  test("a plain member cannot remove anyone", async () => {
    const t = convexTest(schema, modules);
    const { ws, member, memberRow } = await seedWorkspace(t);
    await expect(
      t
        .withIdentity(as(member))
        .mutation(api.orgs.removeMember, { workspaceId: ws, memberId: memberRow }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("changeRole rejects promotion to owner and bad roles", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, memberRow } = await seedWorkspace(t);
    const asOwner = t.withIdentity(as(owner));
    await expect(
      asOwner.mutation(api.orgs.changeRole, { workspaceId: ws, memberId: memberRow, role: "owner" }),
    ).rejects.toThrow(/Invalid role/);
    await expect(
      asOwner.mutation(api.orgs.changeRole, { workspaceId: ws, memberId: memberRow, role: "superuser" }),
    ).rejects.toThrow(/Invalid role/);
    await asOwner.mutation(api.orgs.changeRole, { workspaceId: ws, memberId: memberRow, role: "admin" });
    const role = await t.run(async (ctx) => (await ctx.db.get(memberRow))?.role);
    expect(role).toBe("admin");
  });
});

describe("cross-tenant isolation (IDOR)", () => {
  test("an outsider cannot read another workspace's files", async () => {
    const t = convexTest(schema, modules);
    const { ws, outsider } = await seedWorkspace(t);
    await expect(
      t.withIdentity(as(outsider)).query(api.files.list, { workspaceId: ws }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("unauthenticated reads return empty, not an error", async () => {
    const t = convexTest(schema, modules);
    const { ws } = await seedWorkspace(t);
    expect(await t.query(api.files.list, { workspaceId: ws })).toEqual([]);
  });
});

// Full IDOR matrix: an authenticated outsider must be denied on EVERY workspace-scoped
// surface. This is the in-process, CI-runnable equivalent of the live p2-idor suite.
describe("cross-tenant isolation matrix (outsider vs workspace)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous fn table for a test matrix
  const cases: Array<[string, (b: any, ws: any) => Promise<unknown>]> = [
    ["apiKeys.listMine", (b, ws) => b.query(api.apiKeys.listMine, { workspaceId: ws })],
    ["apiKeys.create", (b, ws) => b.action(api.apiKeys.create, { workspaceId: ws, name: "x" })],
    ["orgs.members", (b, ws) => b.query(api.orgs.members, { workspaceId: ws })],
    ["orgs.invite", (b, ws) => b.mutation(api.orgs.invite, { workspaceId: ws, email: "x@x.test", role: "member" })],
    ["orgs.pendingInvites", (b, ws) => b.query(api.orgs.pendingInvites, { workspaceId: ws })],
    ["usage.mine", (b, ws) => b.query(api.usage.mine, { workspaceId: ws })],
    ["audit.recent", (b, ws) => b.query(api.audit.recent, { workspaceId: ws })],
    ["files.list", (b, ws) => b.query(api.files.list, { workspaceId: ws })],
    ["files.listPaged", (b, ws) => b.query(api.files.listPaged, { workspaceId: ws, paginationOpts: { numItems: 5, cursor: null } })],
    ["files.generateUploadUrl", (b, ws) => b.mutation(api.files.generateUploadUrl, { workspaceId: ws })],
  ];
  for (const [name, call] of cases) {
    test(`outsider is denied: ${name}`, async () => {
      const t = convexTest(schema, modules);
      const { ws, outsider } = await seedWorkspace(t);
      await expect(call(t.withIdentity(as(outsider)), ws)).rejects.toThrow();
    });
  }
});

// The counters table is what keeps per-workspace counts off a full-table scan.
// There is no public query over it, so read the rows directly — the invariant
// under test is that bump() runs on both the create and the delete path.
describe("maintained counters stay accurate", () => {
  test("createWorkspace seeds members=1; saveFile/remove move files up and down", async () => {
    const t = convexTest(schema, modules);
    const counter = (ws: Id<"workspaces">, metric: string) =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query("counters")
          .withIndex("by_workspace_metric", (q) =>
            q.eq("workspaceId", ws).eq("metric", metric),
          )
          .unique();
        return row?.value ?? 0;
      });

    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "c@t.test" }));
    const u = t.withIdentity(as(userId));

    const ws = await u.mutation(api.orgs.createWorkspace, { name: "C" });
    expect(await counter(ws, "members")).toBe(1); // owner
    expect(await counter(ws, "files")).toBe(0);

    await u.mutation(api.files.generateUploadUrl, { workspaceId: ws });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["hi"])));
    const fileId = await u.mutation(api.files.saveFile, {
      workspaceId: ws,
      storageId,
      name: "a.txt",
      size: 2,
      contentType: "text/plain",
    });
    // files.saveFile now creates a Library file (userFiles): the SAME symmetric
    // counting has to hold there.
    expect(await counter(ws, "userFiles")).toBe(1);

    await u.mutation(api.userFiles.remove, { fileId });
    expect(await counter(ws, "userFiles")).toBe(0);
  });
});

// --- invitation privilege escalation ---------------------------------------
//
// `changeRole` has always refused anything outside ["admin","member"] and
// refused to touch an owner. `invite` validated nothing at all, and — the part
// that actually matters — `acceptInviteImpl` inserted the STORED role verbatim.
// So issuance-side validation alone would leave every invite row that already
// exists in a live database still able to confer ownership on accept.
describe("invitation cannot confer ownership", () => {
  test("an admin cannot ISSUE an owner invite", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    await expect(
      t.withIdentity(as(owner)).mutation(api.orgs.invite, {
        workspaceId: ws,
        email: "victim@t.test",
        role: "owner",
      }),
    ).rejects.toThrow();
  });

  test("an arbitrary role string is refused at issuance", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    await expect(
      t.withIdentity(as(owner)).mutation(api.orgs.invite, {
        workspaceId: ws,
        email: "victim@t.test",
        role: "superuser",
      }),
    ).rejects.toThrow();
  });

  // THE ONE THAT MATTERS: a row that already says owner — as any admin could
  // have created before the issuance check existed — must not grant ownership.
  test("a pre-existing owner invite does not grant ownership on accept", async () => {
    const t = convexTest(schema, modules);
    const { ws, outsider } = await seedWorkspace(t);
    const inviteId = await t.run(async (ctx) => {
      await ctx.db.patch(outsider, { email: "outsider@t.test" });
      return ctx.db.insert("invites", {
        workspaceId: ws,
        email: "outsider@t.test",
        role: "owner",
        invitedBy: outsider,
        accepted: false,
        createdAt: Date.now(),
      });
    });

    await t
      .withIdentity(as(outsider))
      .mutation(api.orgs.acceptInvite, { inviteId })
      .catch(() => undefined);

    const role = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", outsider))
        .collect();
      return rows.find((r) => r.workspaceId === ws)?.role ?? null;
    });
    expect(role).not.toBe("owner");
  });
});

function unsetEnv(key: string) {
  delete process.env[key];
}

// --- server-to-server secret checks -----------------------------------------
//
// Every secret comparison in http.ts is constant-time except, until now,
// /backend/webhook — which used a plain !== that short-circuits on the first
// differing byte. Timing itself is not asserted here (a unit test cannot
// measure it reliably); what IS asserted is the behaviour a naive rewrite would
// break: a wrong secret of the SAME LENGTH is still refused, and a correct one
// is still accepted, so the constant-time path cannot be "fixed" into a
// length-only check.
describe("the backend webhook secret check", () => {
  test("accepts the right secret and refuses a same-length wrong one", async () => {
    const t = convexTest(schema, modules);
    process.env.BACKEND_WEBHOOK_SECRET = "abcdefghijklmnop";

    const post = (secret: string) =>
      t.fetch("/backend/webhook", {
        method: "POST",
        headers: { "x-webhook-secret": secret, "content-type": "application/json" },
        body: JSON.stringify({ type: "event" }),
      });

    // Same length, different bytes — the case a length-only comparison passes.
    expect((await post("abcdefghijklmnoq")).status).toBe(401);
    // Different length.
    expect((await post("short")).status).toBe(401);
    // Correct.
    expect((await post("abcdefghijklmnop")).status).not.toBe(401);
    unsetEnv("BACKEND_WEBHOOK_SECRET");
  });

  test("an unset secret closes the endpoint rather than opening it", async () => {
    const t = convexTest(schema, modules);
    unsetEnv("BACKEND_WEBHOOK_SECRET");
    const res = await t.fetch("/backend/webhook", {
      method: "POST",
      headers: { "x-webhook-secret": "anything", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
