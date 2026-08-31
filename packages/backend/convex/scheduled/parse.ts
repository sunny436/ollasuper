import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation } from "../_generated/server";
import { requireMember } from "../orgs";
import { requireUserId } from "./authz";

/**
 * Natural-language schedule parsing for the composer.
 *
 * THIS CREATES NOTHING. It turns text into a candidate schedule and hands it
 * back for the user to edit and confirm; only `tasks.create` — a separate,
 * explicit mutation — ever writes a task. The Python endpoint it calls holds no
 * Convex client at all, so that is structural rather than a convention.
 *
 * Everything expensive or abusable is gated BEFORE the HTTP call: auth,
 * workspace membership, body size and a per-user hourly window. A parse that
 * cannot be served degrades to the manual form rather than erroring, because
 * parsing must never be on the critical path to scheduling something.
 */

const MAX_TEXT = 2_000;
const MAX_TURNS = 6;
const MAX_CONTEXT_CHARS = 4_000;
/** A parse is one small model call, so it gets its own cheap budget rather
 *  than spending the chat allowance. */
const MAX_PARSES_PER_HOUR = 60;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * The action's return type, written out rather than inferred.
 *
 * LOAD-BEARING. `parse` calls `ctx.runMutation(internal.scheduled.parse.gate)`
 * — it references its OWN module through the generated api, so TypeScript
 * cannot infer the handler's type without recursing into itself (TS7022). Left
 * un-annotated it resolves to `any`, and because the whole `api` object is one
 * type, that `any` silently spreads: unrelated queries elsewhere in the
 * codebase lose their types too. The annotation cuts the cycle.
 */
export type ParseResult =
  | { ok: false; reason: string }
  | {
      ok: boolean;
      schedule?: unknown;
      needs?: string[];
      question?: string | null;
      reason?: string | null;
    };

const turnValidator = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
});

/**
 * Auth + membership + the fixed-window budget, in one transaction.
 *
 * A mutation rather than part of the action because it writes the counter, and
 * because doing it here means an unauthenticated or over-budget caller never
 * reaches the network at all.
 */
export const gate = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, workspaceId);

    const now = Date.now();
    const settings = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", userId).eq("workspaceId", workspaceId),
      )
      .unique();

    const start = settings?.parseWindowStart ?? 0;
    const fresh = now - start >= WINDOW_MS;
    const count = fresh ? 0 : (settings?.parseWindowCount ?? 0);
    if (count >= MAX_PARSES_PER_HOUR) {
      return { ok: false as const, reason: "rate_limited" as const };
    }
    const patch = {
      parseWindowStart: fresh ? now : start,
      parseWindowCount: count + 1,
    };
    if (settings) {
      await ctx.db.patch(settings._id, patch);
    } else {
      // Mirrors chat's assertRateLimit: the settings row is created on first
      // use rather than requiring a separate bootstrap.
      await ctx.db.insert("chatSettings", {
        userId,
        workspaceId,
        defaultModel: "",
        sendOnEnter: true,
        updatedAt: now,
        ...patch,
      });
    }
    return { ok: true as const };
  },
});

export const parse = action({
  args: {
    workspaceId: v.id("workspaces"),
    text: v.string(),
    turns: v.optional(v.array(turnValidator)),
    // The card as it stands, so a correction edits rather than replaces.
    draft: v.optional(v.any()),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ParseResult> => {
    // Size is checked FIRST, so an oversized body is refused without spending a
    // rate-limit slot and without leaving this process.
    const text = args.text.trim();
    if (!text) return { ok: false as const, reason: "empty" };
    if (text.length > MAX_TEXT) {
      return { ok: false as const, reason: "too_long" };
    }
    const turns = (args.turns ?? []).slice(-MAX_TURNS);
    const contextChars = turns.reduce((n, t) => n + t.content.length, 0);
    if (contextChars > MAX_CONTEXT_CHARS) {
      return { ok: false as const, reason: "too_long" };
    }

    const gated: { ok: boolean; reason?: string } = await ctx.runMutation(
      internal.scheduled.parse.gate,
      { workspaceId: args.workspaceId },
    );
    if (!gated.ok) {
      return { ok: false as const, reason: gated.reason ?? "rate_limited" };
    }

    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) return { ok: false as const, reason: "unavailable" };

    try {
      const res = await fetch(
        `${base.replace(/\/$/, "")}/v1/schedule/parse`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-service-key": key,
          },
          body: JSON.stringify({
            text,
            turns,
            draft: args.draft ?? null,
            timezone: args.timezone ?? "UTC",
            nowMs: Date.now(),
          }),
        },
      );
      if (!res.ok) return { ok: false as const, reason: "unavailable" };
      return (await res.json()) as {
        ok: boolean;
        schedule?: unknown;
        needs?: string[];
        question?: string | null;
        reason?: string | null;
      };
    } catch {
      // Timeout, DNS, refused connection — all the same to the user: fall back
      // to the manual form. Never retried automatically.
      return { ok: false as const, reason: "unavailable" };
    }
  },
});
