import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Per-thread activation of UNTRUSTED connectors (audit H-06, default-deny).
 *
 * WHY. Every `ready` connection used to be composed into every turn, so an
 * untrusted server's tool descriptions — and any instruction hidden in them —
 * reached the model on every message the user sent, whether or not the user
 * had that connector in mind. Trusted (operator-vouched) connectors keep that
 * behaviour: the user chose them for exactly this. An untrusted connector now
 * enters a thread's turns only after the user NAMED it in that thread, or
 * after one of its tools actually ran there (an approved call is the clearest
 * signal of intent there is). The Python plane reads the flag per connection
 * (`McpConnectionRef.activated`) and composes untrusted ones only when set.
 *
 * MATCHING IS DELIBERATELY FORGIVING. A user writes "context7", "Red Team",
 * "google drive"; the slug is `context7`, `qa-redteam`, `google-drive`. Both
 * sides are reduced to lowercase alphanumerics and the slug's parts (≥ 4
 * chars) are looked for as substrings. Activating one connector too many
 * costs an approval prompt; activating one too few costs the user a retry
 * with the name spelled out. The former is the cheaper mistake.
 */

const MAX_ACTIVATED = 32;

function fold(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The alphanumeric needles a connector answers to. */
export function activationNeedles(slug: string): string[] {
  const whole = fold(slug);
  const parts = slug
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(fold)
    .filter((p) => p.length >= 4);
  return [...new Set([whole, ...parts])].filter((n) => n.length >= 4);
}

export function mentionsConnector(text: string, slug: string): boolean {
  const haystack = fold(text);
  if (!haystack) return false;
  return activationNeedles(slug).some((needle) => haystack.includes(needle));
}

/** Add `slugs` to the thread's activated set. Idempotent; bounded. */
export async function activateSlugs(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
  slugs: string[],
): Promise<void> {
  if (slugs.length === 0) return;
  const thread = await ctx.db.get(threadId);
  if (!thread) return;
  const current = thread.mcpActivated ?? [];
  const next = [...new Set([...current, ...slugs])].slice(0, MAX_ACTIVATED);
  if (next.length === current.length) return;
  await ctx.db.patch(threadId, { mcpActivated: next });
}

/**
 * The user sent `text` in `threadId`: activate every ready connector of theirs
 * that the text names. Reads the user's connections by index; a user has a
 * handful, so this is one small scan per message.
 */
export async function activateMentioned(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
  userId: Id<"users">,
  text: string,
): Promise<void> {
  if (!text) return;
  const connections = await ctx.db
    .query("mcpConnections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const named = connections
    .filter((c) => c.status === "ready" && mentionsConnector(text, c.slug))
    .map((c) => c.slug);
  await activateSlugs(ctx, threadId, named);
}

/** `mcp:<slug>:<tool>` -> `<slug>`, or null for a non-MCP tool id. */
export function slugOfToolId(toolId: string): string | null {
  if (!toolId.startsWith("mcp:")) return null;
  const rest = toolId.slice(4);
  const end = rest.indexOf(":");
  const slug = end === -1 ? rest : rest.slice(0, end);
  return slug || null;
}
