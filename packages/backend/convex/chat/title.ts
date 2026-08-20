import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";

/**
 * Auto chat-title generation — the separate, lightweight, non-critical task.
 *
 * Scheduled by ingest.finishStream ONLY on the first assistant turn's success
 * (assistant seq === 1). It reads just the first user message + first assistant
 * output (no history), asks the Python plane's /v1/title (Gemini Flash) for a
 * short title, and persists it via ingest.setTitle (which validates, guards a
 * user rename, and does not reorder the sidebar). Every failure is swallowed:
 * a missing auto-title is cosmetic and must never affect the chat.
 */

/** The minimum context for a title: first user input + first assistant output. */
export const firstTurnContext = internalQuery({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique();
    if (!stream) return null;
    const thread = await ctx.db.get(stream.threadId);
    if (!thread || thread.titleSource === "user") return null; // never re-title a rename

    const msgs = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_seq", (q) =>
        q.eq("threadId", stream.threadId).lte("seq", 1),
      )
      .collect();
    const user = msgs.find((m) => m.seq === 0 && m.role === "user");
    const assistant = msgs.find((m) => m.seq === 1 && m.role === "assistant");
    if (!user || !assistant || !assistant.content.trim()) return null;
    return {
      user: user.content.slice(0, 4000),
      assistant: assistant.content.slice(0, 8000),
    };
  },
});

export const generate = internalAction({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    // Non-critical: if the plane isn't configured, silently skip (never failStream).
    if (!base || !key) return;

    let context: { user: string; assistant: string } | null;
    try {
      context = await ctx.runQuery(internal.chat.title.firstTurnContext, {
        streamId,
      });
    } catch {
      return;
    }
    if (!context) return;

    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/title`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-key": key },
        body: JSON.stringify({
          firstUser: context.user,
          firstAssistant: context.assistant,
        }),
        // Latency safety: never wait on a hung Gemini call.
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as {
        title?: string;
      } | null;
      const title = data?.title;
      if (typeof title === "string" && title.trim()) {
        await ctx.runMutation(internal.chat.ingest.setTitle, { streamId, title });
      }
    } catch {
      // Swallow — a missing auto-title is cosmetic; never surface to the user.
    }
  },
});
