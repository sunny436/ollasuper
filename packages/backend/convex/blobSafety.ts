import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * What a browser will EXECUTE if it navigates to a stored blob.
 *
 * THE THING THAT MATTERS HERE: Convex serves a blob with the content-type set by
 * the UPLOAD POST, not with whatever we later persist on our own row. Measured on
 * this deployment — a blob uploaded as `application/json` and registered as
 * `text/plain` is served as `application/json`. So validating the row's
 * `contentType` protects nothing; the blob's own type is the one that reaches the
 * browser, and `generateUploadUrl` hands every workspace member the ability to
 * set it.
 *
 * That matters because `ctx.storage.getUrl()` returns a URL on the CONVEX SITE
 * ORIGIN, which on this deployment is proxied at `app.ollasuper.com/__cvx` — the
 * same origin as the app. A stored `text/html` blob is therefore same-origin
 * script execution against every viewer, reachable from every surface that hands
 * a `url` to a browser.
 *
 * Registration is the chokepoint: a blob that is never registered never has a
 * URL minted for it, so refusing here closes every one of those surfaces at once.
 *
 * SVG is on the list deliberately — it is an image everywhere else in this
 * codebase, but a navigated SVG executes its own <script>.
 */
const EXECUTABLE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xslt+xml",
  "text/xsl",
]);

export function isExecutableContentType(ct: string | null | undefined): boolean {
  const t = (ct ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return EXECUTABLE_TYPES.has(t);
}

/**
 * Refuse a blob the browser would execute, judged on the BLOB's stored type.
 *
 * Deliberately not a sanitiser: re-storing the bytes under a safe type would mean
 * writing a copy and deleting the original, and "delete the blob you were handed"
 * is the exact shape of a separate finding in this codebase. Refusing is smaller
 * and has no destructive step.
 */
export async function assertNonExecutableBlob(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  const meta = await ctx.db.system.get(storageId);
  if (isExecutableContentType(meta?.contentType)) {
    throw new ConvexError(
      `Unsupported file type: ${meta?.contentType}. Upload it declared as text/plain instead.`,
    );
  }
}
