import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const as = (id: Id<"users">) => ({ subject: id, issuer: "test" });

/**
 * Regenerate produces a VARIANT, not a second answer.
 *
 * The bug these pin: `regenerate` appends a new assistant row and moves the
 * parent's activeVariantIndex, and both buildHistory (the model's context) and
 * shares.ts (the public view) filter to the active variant — but listPaged did
 * not. The chat transcript was the one surface rendering every regeneration at
 * once, so the user saw two answers to one question.
 */

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: ReturnType<typeof convexTest>) {
  const { owner, ws } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "o@t.test" });
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
    return { owner, ws };
  });
  const u = t.withIdentity(as(owner));
  const threadId = await u.mutation(api.chat.threads.create, {
    workspaceId: ws,
    title: "t",
  });
  const sent = await u.mutation(api.chat.messages.send, {
    threadId,
    content: "hi",
    clientId: "c1",
  });
  await drain(t);
  // send() types assistantMessageId as nullable; a successful send always has
  // one, and a null here would mean the seed itself failed.
  if (!sent.assistantMessageId) throw new Error("seed: send produced no assistant row");
  return {
    owner,
    ws,
    u,
    threadId,
    ...sent,
    assistantMessageId: sent.assistantMessageId,
  };
}

/** Settle the in-flight reply so listPaged can see it (it excludes in-flight). */
async function settle(
  t: ReturnType<typeof convexTest>,
  messageId: Id<"chatMessages">,
  content: string,
) {
  await t.run(async (ctx) => {
    const m = await ctx.db.get(messageId);
    await ctx.db.patch(messageId, { content, status: "complete" });
    if (m) await ctx.db.patch(m.threadId, { streamingMessageId: undefined });
  });
}

const assistants = async (
  t: ReturnType<typeof convexTest>,
  owner: Id<"users">,
  threadId: string,
) => {
  const page = await t
    .withIdentity(as(owner))
    .query(api.chat.messages.listPaged, {
      threadId,
      paginationOpts: { numItems: 50, cursor: null },
    });
  return page.page.filter((m) => m.role === "assistant");
};

describe("regenerate replaces the reply instead of appending one", () => {
  test("after regenerating, the transcript holds exactly ONE assistant reply", async () => {
    const t = convexTest(schema, modules);
    const { owner, u, threadId, assistantMessageId } = await seed(t);
    await settle(t, assistantMessageId, "first answer");
    expect((await assistants(t, owner, threadId)).length).toBe(1);

    const r1 = await u.mutation(api.chat.messages.regenerate, {
      messageId: assistantMessageId,
    });
    await drain(t);
    await settle(t, r1.assistantMessageId, "second answer");

    const list = await assistants(t, owner, threadId);
    expect(list.length).toBe(1);
    // ...and it is the NEW one, not the original.
    expect(list[0].content).toBe("second answer");
  });

  test("regenerating twice still leaves exactly ONE", async () => {
    const t = convexTest(schema, modules);
    const { owner, u, threadId, assistantMessageId } = await seed(t);
    await settle(t, assistantMessageId, "a1");
    const r1 = await u.mutation(api.chat.messages.regenerate, {
      messageId: assistantMessageId,
    });
    await drain(t);
    await settle(t, r1.assistantMessageId, "a2");
    const r2 = await u.mutation(api.chat.messages.regenerate, {
      messageId: r1.assistantMessageId,
    });
    await drain(t);
    await settle(t, r2.assistantMessageId, "a3");

    const list = await assistants(t, owner, threadId);
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("a3");
  });

  test("a FAILED regeneration stays visible so the user can retry", async () => {
    // isInFlight is pending|streaming ONLY, so an error row must still render.
    // If it did not, a failed regeneration would silently empty the turn and
    // leave nothing to press Continue on.
    const t = convexTest(schema, modules);
    const { owner, u, threadId, assistantMessageId } = await seed(t);
    await settle(t, assistantMessageId, "good answer");
    const r1 = await u.mutation(api.chat.messages.regenerate, {
      messageId: assistantMessageId,
    });
    await drain(t);
    await t.run(async (ctx) => {
      const m = await ctx.db.get(r1.assistantMessageId);
      await ctx.db.patch(r1.assistantMessageId, {
        status: "error",
        error: "boom",
        content: "",
      });
      if (m) await ctx.db.patch(m.threadId, { streamingMessageId: undefined });
    });

    const list = await assistants(t, owner, threadId);
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("error");
  });

  test("setActiveVariant flips which reply the transcript shows", async () => {
    const t = convexTest(schema, modules);
    const { owner, u, threadId, userMessageId, assistantMessageId } =
      await seed(t);
    await settle(t, assistantMessageId, "first answer");
    const r1 = await u.mutation(api.chat.messages.regenerate, {
      messageId: assistantMessageId,
    });
    await drain(t);
    await settle(t, r1.assistantMessageId, "second answer");
    expect((await assistants(t, owner, threadId))[0].content).toBe(
      "second answer",
    );

    await u.mutation(api.chat.messages.setActiveVariant, {
      userMessageId,
      variantIndex: 0,
    });
    const back = await assistants(t, owner, threadId);
    expect(back.length).toBe(1);
    expect(back[0].content).toBe("first answer");
  });

  test("a LEGACY reply with no parentId is linked before branching", async () => {
    // parentId is OPTIONAL, so replies written before variants existed carry
    // none. Without the backfill in regenerate the whole variant block is
    // skipped, the new row is created unlinked, and listPaged cannot tell the
    // two apart — so the duplicate would survive on exactly the oldest threads,
    // which is the case a naive suite never covers.
    const t = convexTest(schema, modules);
    const { owner, u, threadId, assistantMessageId } = await seed(t);
    await settle(t, assistantMessageId, "legacy answer");
    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, {
        parentId: undefined,
        variantIndex: undefined,
      });
    });
    // t.run serializes the return value, so an absent field arrives as null.
    expect(
      await t.run(
        async (ctx) => (await ctx.db.get(assistantMessageId))?.parentId ?? null,
      ),
    ).toBeNull();

    const r1 = await u.mutation(api.chat.messages.regenerate, {
      messageId: assistantMessageId,
    });
    await drain(t);
    await settle(t, r1.assistantMessageId, "fresh answer");

    const list = await assistants(t, owner, threadId);
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("fresh answer");
  });

  test("a reply with no parentId and no regeneration still renders", async () => {
    // Backward compatibility: a row is never hidden merely for lacking the link.
    const t = convexTest(schema, modules);
    const { owner, threadId, assistantMessageId } = await seed(t);
    await settle(t, assistantMessageId, "untouched");
    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, {
        parentId: undefined,
        variantIndex: undefined,
      });
    });
    const list = await assistants(t, owner, threadId);
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("untouched");
  });
});
