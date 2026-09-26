import { activeUserId } from "./accountState";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import { requireDevSeed } from "./devGuard";
import { requireMember } from "./orgs";

export { audit } from "./auditLog";

/** Internal entry point (explicit userId) — for automation/testing. */
export const record = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    action: v.string(),
    meta: v.optional(v.any()),
  },
  handler: async (ctx, a) => {
    requireDevSeed();
    await audit(ctx, a.workspaceId, a.userId, a.action, a.meta);
  },
});

/**
 * Reactive: the CURRENT USER's recent audit entries.
 *
 * It now does what that sentence says. It used to read `by_workspace` with no
 * user filter, so any member — no elevated role needed — received the last 50
 * rows for EVERY member of the workspace. The docstring described the intent;
 * the index did something broader, and nothing reconciled them.
 *
 * That was a live cross-user disclosure of whatever metadata each action
 * records. It surfaced through custom skills, whose rows carried the skill NAME
 * while the Settings page promised "Private to you" (that name is no longer
 * logged either — see `userSkills.ts`), but the shape was general: this query
 * was the read side of every audited action in the product.
 *
 * Membership is still checked. It is now a precondition rather than the whole
 * authorization: you must belong to the workspace AND you only ever see your
 * own rows.
 *
 * Kept as a post-filter rather than a new `by_workspace_user` index because
 * there is no caller today (the Platform UI was removed), so adding an index to
 * a live deployment would be schema churn for a query nobody runs. If this is
 * ever put back on a screen, add the index then — 50 rows scanned per member is
 * fine; a workspace-wide scan behind a UI would not be.
 */
export const recent = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return [];
    await requireMember(ctx, userId, workspaceId);
    const rows = await ctx.db
      .query("auditLogs")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(500);
    return rows.filter((r) => r.userId === userId).slice(0, 50);
  },
});
