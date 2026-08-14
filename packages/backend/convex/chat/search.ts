import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireMember } from "../orgs";
import { getUserIdOrNull } from "./authz";

/**
 * Conversation search.
 *
 * Real full-text search rather than client-side filtering, because the client
 * only ever holds ~30 thread titles (page one of the sidebar) and the messages
 * of the single open thread. Filtering client-side would mean shipping every
 * message in the workspace to the browser — simultaneously a bandwidth
 * disaster, a defeat of pagination, and a mass data-exfiltration primitive.
 *
 * EVERY search chain MUST pin .eq("userId", userId). Dropping that one line
 * leaks every conversation in the tenant, and no type checker will catch it —
 * which is exactly why security.test.ts asserts it directly.
 */

const LIMIT = 20;
const MIN_QUERY = 2;
const SNIPPET_RADIUS = 90;

function snippet(content: string, term: string): string {
  const idx = content.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return content.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(content.length, idx + term.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${
    end < content.length ? "…" : ""
  }`;
}

export const threads = query({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    // An empty or one-character term makes Convex scan the whole index.
    if (args.query.trim().length < MIN_QUERY) return [];
    await requireMember(ctx, userId, args.workspaceId);

    const rows = await ctx.db
      .query("chatThreads")
      .withSearchIndex("search_title", (q) =>
        q
          .search("title", args.query)
          .eq("userId", userId)
          .eq("workspaceId", args.workspaceId)
          .eq("status", "active"),
      )
      .take(Math.min(args.limit ?? LIMIT, 50));

    return rows.map((t) => ({
      _id: t._id,
      title: t.title,
      updatedAt: t.updatedAt,
      pinned: t.pinned,
    }));
  },
});

export const messages = query({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    threadId: v.optional(v.id("chatThreads")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    if (args.query.trim().length < MIN_QUERY) return [];
    await requireMember(ctx, userId, args.workspaceId);

    const rows = await ctx.db
      .query("chatMessages")
      .withSearchIndex("search_content", (q) => {
        const base = q
          .search("content", args.query)
          .eq("userId", userId)
          .eq("workspaceId", args.workspaceId);
        return args.threadId ? base.eq("threadId", args.threadId) : base;
      })
      .take(Math.min(args.limit ?? LIMIT, 50));

    const titles = new Map<Id<"chatThreads">, string>();
    const out: {
      _id: Id<"chatMessages">;
      threadId: Id<"chatThreads">;
      threadTitle: string;
      role: Doc<"chatMessages">["role"];
      snippet: string;
      createdAt: number;
    }[] = [];

    for (const m of rows) {
      let title = titles.get(m.threadId);
      if (title === undefined) {
        const thread = await ctx.db.get(m.threadId);
        // Skip trashed threads: their rows still exist until the purge cron
        // catches up, and surfacing them looks like a deletion that failed.
        if (!thread || thread.status === "trashed") continue;
        title = thread.title;
        titles.set(m.threadId, title);
      }
      out.push({
        _id: m._id,
        threadId: m.threadId,
        threadTitle: title,
        role: m.role,
        snippet: snippet(m.content, args.query),
        createdAt: m.createdAt,
      });
    }
    return out;
  },
});

/** Combined, thread-deduped result for the sidebar search box. */
export const combined = query({
  args: { workspaceId: v.id("workspaces"), query: v.string() },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    if (args.query.trim().length < MIN_QUERY) return [];
    await requireMember(ctx, userId, args.workspaceId);

    const [byTitle, byContent] = await Promise.all([
      ctx.db
        .query("chatThreads")
        .withSearchIndex("search_title", (q) =>
          q
            .search("title", args.query)
            .eq("userId", userId)
            .eq("workspaceId", args.workspaceId)
            .eq("status", "active"),
        )
        .take(LIMIT),
      ctx.db
        .query("chatMessages")
        .withSearchIndex("search_content", (q) =>
          q
            .search("content", args.query)
            .eq("userId", userId)
            .eq("workspaceId", args.workspaceId),
        )
        .take(LIMIT),
    ]);

    const seen = new Set<string>();
    const out: {
      threadId: Id<"chatThreads">;
      title: string;
      snippet: string | null;
      updatedAt: number;
    }[] = [];

    for (const t of byTitle) {
      if (seen.has(t._id)) continue;
      seen.add(t._id);
      out.push({
        threadId: t._id,
        title: t.title,
        snippet: null,
        updatedAt: t.updatedAt,
      });
    }
    for (const m of byContent) {
      if (seen.has(m.threadId)) continue;
      const thread = await ctx.db.get(m.threadId);
      if (!thread || thread.status === "trashed") continue;
      seen.add(m.threadId);
      out.push({
        threadId: m.threadId,
        title: thread.title,
        snippet: snippet(m.content, args.query),
        updatedAt: thread.updatedAt,
      });
    }

    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, LIMIT);
  },
});
