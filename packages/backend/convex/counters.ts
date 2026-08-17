import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireDevSeed } from "./devGuard";

// Dependency-free counter helpers (no orgs import → no cycle). Mutations keep the
// per-workspace counts current via bump(), so nothing has to .collect() a whole
// table to know how many rows are in it.

async function counterRow(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  metric: string,
) {
  return ctx.db
    .query("counters")
    .withIndex("by_workspace_metric", (q) =>
      q.eq("workspaceId", workspaceId).eq("metric", metric),
    )
    .unique();
}

/** Adjust a workspace metric by delta (floored at 0). Creates the row if absent. */
export async function bump(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  metric: string,
  delta: number,
) {
  const row = await counterRow(ctx, workspaceId, metric);
  if (row) {
    await ctx.db.patch(row._id, { value: Math.max(0, row.value + delta) });
  } else {
    await ctx.db.insert("counters", {
      workspaceId,
      metric,
      value: Math.max(0, delta),
    });
  }
}

async function setCounter(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  metric: string,
  value: number,
) {
  const row = await counterRow(ctx, workspaceId, metric);
  if (row) await ctx.db.patch(row._id, { value });
  else await ctx.db.insert("counters", { workspaceId, metric, value });
}

/** One-time migration: recompute counters from existing rows for every workspace. */
export const backfillAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    requireDevSeed();
    const workspaces = await ctx.db.query("workspaces").collect();
    for (const ws of workspaces) {
      const [files, members] = await Promise.all([
        ctx.db
          .query("files")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
          .collect(),
        ctx.db
          .query("members")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
          .collect(),
      ]);
      await setCounter(ctx, ws._id, "files", files.length);
      await setCounter(ctx, ws._id, "members", members.length);
    }
    return workspaces.length;
  },
});
