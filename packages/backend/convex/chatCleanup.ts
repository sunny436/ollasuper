import { internalMutation } from "./_generated/server";

/**
 * One-shot migration for the Folders + Prompt Library removal.
 *
 * WHY THIS EXISTS AS A SEPARATE, ORDERED STEP:
 *
 * Convex validates every existing document against the schema at push time. So
 * dropping `chatFolders` / `chatPrompts`, or dropping `chatThreads.folderId`,
 * fails the push for as long as a single row still populates them —
 * "Document ... has field 'folderId' not in the schema". The rows have to go
 * first, in a push where the schema still declares them.
 *
 * Hence three ordered deploys:
 *   1. this file + all feature code removed  (schema unchanged)
 *   2. `convex run chatCleanup:purgeFoldersAndPrompts`
 *   3. the schema removal
 *
 * Steps 2 and 3 cannot be combined.
 *
 * Idempotent: safe to run twice, and a no-op once the tables are empty. It is
 * deliberately NOT deleted after use — leaving it in place means a fresh
 * deployment that is mid-migration can be brought forward with the same
 * command, and it costs nothing once it returns all zeros.
 */
export const purgeFoldersAndPrompts = internalMutation({
  args: {},
  handler: async (ctx) => {
    let folders = 0;
    let prompts = 0;
    let threads = 0;

    for (const f of await ctx.db.query("chatFolders").collect()) {
      await ctx.db.delete(f._id);
      folders++;
    }

    for (const p of await ctx.db.query("chatPrompts").collect()) {
      await ctx.db.delete(p._id);
      prompts++;
    }

    // Clearing an optional field is `undefined`, not `null` — patching null
    // would write a value the (about to be removed) validator rejects.
    for (const t of await ctx.db.query("chatThreads").collect()) {
      if (t.folderId !== undefined) {
        await ctx.db.patch(t._id, { folderId: undefined });
        threads++;
      }
    }

    return { folders, prompts, threads };
  },
});
