/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import { buildHistory } from "./chat/messages";
import schema from "./schema";

/**
 * Conversational context: what actually reaches the model.
 *
 * Every assertion here is on the COMPILED HISTORY, never on model output. A test
 * that asserts the assistant "did not say please paste the blog" passes by luck
 * the moment the model is swapped; a test that asserts the blog is present in
 * the compiled context cannot.
 *
 * THE BUG THESE COVER. buildHistory walked newest→oldest doing
 *
 *   chars += m.content.length;
 *   if (chars > HISTORY_MAX_CHARS && picked.length > 0) break;
 *
 * against a 24,000-char budget — three faults in one line. It counted a message
 * BEFORE testing it, so anything larger than the remaining budget could never be
 * admitted. It BROKE rather than continued, so one oversized message discarded
 * every older message too. And it dropped rather than clipped, leaving the model
 * no way to know the content had ever existed.
 *
 * Read from the real shared conversation, the production failure was exactly:
 *   user 6,704 · assistant 25,348 (the blog) · user 84
 * so `84 + 25,348 = 25,432 > 24,000` and the blog was discarded. The model
 * received one 84-character message and correctly said it could not see a blog.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

type Seeded = { threadId: Id<"chatThreads">; nextSeq: number };

/** A thread plus a transcript, seeded verbatim by role and length. */
async function seed(
  t: ReturnType<typeof convexTest>,
  turns: { role: "user" | "assistant"; chars: number; marker?: string }[],
): Promise<Seeded> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    const threadId = await ctx.db.insert("chatThreads", {
      userId,
      workspaceId,
      title: "t",
      titleSource: "user",
      status: "active",
      pinned: false,
      model: "m",
      nextSeq: turns.length,
      messageCount: turns.length,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let seq = 0;
    for (const turn of turns) {
      // A recognisable head so an assertion can prove WHICH message survived,
      // padded to the exact production length.
      const head = turn.marker ?? `${turn.role}-${seq}`;
      const content = head + "x".repeat(Math.max(0, turn.chars - head.length));
      await ctx.db.insert("chatMessages", {
        threadId,
        userId,
        workspaceId,
        role: turn.role,
        content,
        seq,
        status: "complete",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      seq += 1;
    }
    return { threadId, nextSeq: seq };
  });
}

const compile = (t: ReturnType<typeof convexTest>, s: Seeded) =>
  t.run(async (ctx) => buildHistory(ctx, s.threadId, s.nextSeq));

describe("the Cloud WireGuard regression", () => {
  /**
   * The reported failure, at its real message sizes. This is the weakest test in
   * the file — it asserts one concrete shape — but it is the one that maps to the
   * bug report, so it stays.
   */
  test("a 25k assistant answer survives the follow-up that refers to it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, [
      { role: "user", chars: 6_704, marker: "THE-REQUEST" },
      { role: "assistant", chars: 25_348, marker: "THE-BLOG" },
      { role: "user", chars: 84, marker: "give me above blog with more detail" },
    ]);

    const history = await compile(t, s);
    const blog = history.find((m) => m.content.startsWith("THE-BLOG"));

    expect(blog).toBeDefined();
    // Present AND whole: 25,348 is far below the transport bound, so it must not
    // even be clipped.
    expect(blog?.content).toHaveLength(25_348);
    // The turn that refers to it is there too, and so is the original request.
    expect(history).toHaveLength(3);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("the budget walk is non-destructive", () => {
  /**
   * The `break` fault. One oversized message used to take the entire older half
   * of the conversation with it — which is how a thread loses its subject, not
   * just its most recent artifact.
   */
  test("an oversized message does not evict the messages older than it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, [
      { role: "user", chars: 500, marker: "OLDEST" },
      { role: "assistant", chars: 500, marker: "SECOND" },
      { role: "assistant", chars: 200_000, marker: "HUGE" },
      { role: "user", chars: 50, marker: "NEWEST" },
    ]);

    const history = await compile(t, s);
    const heads = history.map((m) => m.content.slice(0, 6));

    // The two small, old messages carry the thread's subject. They must survive
    // a large neighbour.
    expect(heads).toContain("OLDEST");
    expect(heads).toContain("SECOND");
    expect(heads).toContain("NEWEST");
  });

  /**
   * The `drop` fault. Absent content is indistinguishable from content that
   * never existed, and that is precisely what makes the model assert it cannot
   * see something the user is looking at.
   */
  test("a message too large to fit is clipped WITH a marker, never dropped", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, [
      { role: "assistant", chars: 400_000, marker: "ENORMOUS" },
      { role: "user", chars: 40, marker: "expand it" },
    ]);

    const history = await compile(t, s);
    const big = history.find((m) => m.content.startsWith("ENORMOUS"));

    expect(big).toBeDefined();
    expect(big?.content).toMatch(/truncated to fit the context window/);
    // Head AND tail: the end of a document is what an "expand this" turn
    // continues from.
    expect(big?.content.endsWith("x")).toBe(true);
    // ...and it explicitly tells the model not to claim the content is missing.
    expect(big?.content).toMatch(/do not tell the user the content is missing/);
  });

  /**
   * The pin. The newest assistant message is both the thing a follow-up refers
   * to and the largest message in the thread — the exact combination the old
   * loop was guaranteed to discard.
   */
  test("the newest assistant turn survives a budget already spent by older ones", async () => {
    const t = convexTest(schema, modules);
    const turns: { role: "user" | "assistant"; chars: number; marker?: string }[] =
      [];
    // Fill the transport bound with older traffic first.
    for (let i = 0; i < 12; i++) {
      turns.push({ role: "user", chars: 9_000 });
      turns.push({ role: "assistant", chars: 9_000 });
    }
    turns.push({ role: "assistant", chars: 60_000, marker: "THE-ARTIFACT" });
    turns.push({ role: "user", chars: 30, marker: "make it longer" });

    const s = await seed(t, turns);
    const history = await compile(t, s);

    const artifact = history.find((m) => m.content.startsWith("THE-ARTIFACT"));
    expect(artifact).toBeDefined();
    expect(artifact?.content.length).toBeGreaterThanOrEqual(6_000);

    const newest = history.at(-1);
    expect(newest?.content.startsWith("make it longer")).toBe(true);
  });

  /** Chronological order is what makes "previous"/"above" mean anything. */
  test("the compiled history stays in chronological order", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, [
      { role: "user", chars: 100 },
      { role: "assistant", chars: 100 },
      { role: "user", chars: 100 },
      { role: "assistant", chars: 100 },
    ]);
    const history = await compile(t, s);
    const seqs = history.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});
