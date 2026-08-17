import { internalMutation } from "./_generated/server";

/** 90 days. See the retention note in schema.ts / authEvents.ts. */
const RETENTION_MS = 1000 * 60 * 60 * 24 * 90;
/** Bounded per run so a large backlog cannot blow the mutation's limits. */
const BATCH = 500;

export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const stale = await ctx.db
      .query("authEvents")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .take(BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});
