import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";

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
 *
 * So are the two plain XML types (audit F-02): an XML document carrying
 * `<?xml-stylesheet type="text/xsl" href="...">` is transformed by the browser
 * into HTML that runs script on the serving origin. The edge proxy now also
 * forces raw storage responses to download/sandbox (edge/proxy.js) — this list
 * is the registration-time half, not the only control.
 */
const EXECUTABLE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xslt+xml",
  "text/xsl",
  "application/xml",
  "text/xml",
]);

export function isExecutableContentType(ct: string | null | undefined): boolean {
  const t = (ct ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return EXECUTABLE_TYPES.has(t);
}

/**
 * Types safe to render INLINE from a public route that serves bytes directly.
 *
 * AN ALLOWLIST, NOT THE DENYLIST ABOVE, and the difference is the whole point.
 * `EXECUTABLE_TYPES` guards the BLOB's stored type, which this deployment
 * controls at upload. `/share/file` is different: it streams the blob but takes
 * its content-type from the chatAttachments ROW, and that field is
 * `args.contentType` — supplied by the client at register() and never
 * validated. Against a caller-chosen value a denylist has to be exhaustive to
 * be correct, and this one is not: `text/xml` carrying
 * `<?xml-stylesheet type="text/xsl" href="...">` is transformed by the browser
 * into same-origin HTML, and no entry above covers it. An allowlist fails
 * closed on the type nobody thought of.
 *
 * SVG IS EXCLUDED DELIBERATELY. It is an image everywhere else in this
 * codebase, but /share/file renders non-images as a NAVIGATED link
 * (share-attachment.tsx), and a navigated svg executes its own <script>.
 */
const INLINE_SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);

export function isInlineSafeImageType(ct: string | null | undefined): boolean {
  const t = (ct ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return INLINE_SAFE_IMAGE_TYPES.has(t);
}

/**
 * The content-type to STORE a blob under, given the type it was declared as.
 *
 * Refusing is right where the executable type is never legitimate (an avatar, a
 * chat attachment). It is wrong for artifacts: generating an .html report or an
 * .svg chart is a shipped feature, and the census found real user deliverables
 * of both kinds. So the bytes are stored under a type no browser will execute,
 * while the DECLARED mime stays on the artifact row — `/artifact/file` serves
 * `content-type` from that row and forces `content-disposition: attachment`, so
 * the download is byte- and type-identical and only the raw storage URL, which
 * is same-origin with the app, stops being executable.
 *
 * This is the prospective half of the remediation that restored the 12
 * already-stored executable blobs to text/plain.
 */
export function neutralizedBlobType(declared: string): string {
  return isExecutableContentType(declared) ? "text/plain" : declared;
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

/**
 * How many stored blobs a browser would still execute.
 *
 * Refusing new ones (above) is prospective only. Blobs stored BEFORE that guard
 * keep their content-type, and `ctx.storage.getUrl()` URLs are bearer
 * capabilities with no expiry — so anything already handed out stays live until
 * the underlying blob is gone. This is the read-only census that decides whether
 * remediation is needed and how big it is.
 */
export const auditExecutableBlobs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const blobs = await ctx.db.system.query("_storage").take(5000);
    const byType: Record<string, number> = {};
    const executable: Array<{ storageId: string; contentType: string; size: number }> = [];
    for (const b of blobs) {
      const ct = (b.contentType ?? "(none)").toLowerCase();
      byType[ct] = (byType[ct] ?? 0) + 1;
      if (isExecutableContentType(b.contentType)) {
        executable.push({
          storageId: b._id,
          contentType: b.contentType ?? "",
          size: b.size,
        });
      }
    }
    return { scanned: blobs.length, byType, executable };
  },
});

/**
 * Which row, if any, owns each executable blob.
 *
 * Remediation differs by owner: a referenced blob must keep its bytes and have
 * its row repointed, while an orphan (no row anywhere) can simply go. Deciding
 * that from a census alone would risk deleting data someone still owns.
 */
export const classifyExecutableBlobs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const blobs = await ctx.db.system.query("_storage").take(5000);
    const targets = blobs.filter((b) => isExecutableContentType(b.contentType));

    // The five tables that reference storage. attachments/userFiles have a
    // by_storage index; the rest are small enough to scan.
    const [artifacts, plainFiles, users] = await Promise.all([
      ctx.db.query("chatArtifacts").take(5000),
      ctx.db.query("files").take(5000),
      ctx.db.query("users").take(5000),
    ]);

    const out = [];
    for (const b of targets) {
      const att = await ctx.db
        .query("chatAttachments")
        .withIndex("by_storage", (q) => q.eq("storageId", b._id))
        .first();
      const uf = await ctx.db
        .query("userFiles")
        .withIndex("by_storage", (q) => q.eq("storageId", b._id))
        .first();
      const art = artifacts.find((r) => r.storageId === b._id);
      const pf = plainFiles.find((r) => r.storageId === b._id);
      const av = users.find((r) => r.imageId === b._id);

      const owner = att
        ? { table: "chatAttachments", id: att._id, name: att.name }
        : uf
          ? { table: "userFiles", id: uf._id, name: uf.name }
          : art
            ? { table: "chatArtifacts", id: art._id, name: art.filename }
            : pf
              ? { table: "files", id: pf._id, name: pf.name }
              : av
                ? { table: "users", id: av._id, name: "avatar" }
                : null;

      out.push({
        storageId: b._id,
        contentType: b.contentType ?? "",
        size: b.size,
        owner,
      });
    }
    return { executable: out.length, rows: out };
  },
});

/** Repoint one owning row at a re-stored, non-executable copy. */
export const repointBlob = internalMutation({
  args: {
    table: v.string(),
    id: v.string(),
    newStorageId: v.id("_storage"),
  },
  handler: async (ctx, { table, id, newStorageId }) => {
    // Narrow by table rather than trusting a caller-supplied generic id.
    if (table === "chatAttachments") {
      const row = await ctx.db.get(id as Id<"chatAttachments">);
      if (row) await ctx.db.patch(row._id, { storageId: newStorageId });
    } else if (table === "userFiles") {
      const row = await ctx.db.get(id as Id<"userFiles">);
      if (row) await ctx.db.patch(row._id, { storageId: newStorageId });
    } else if (table === "chatArtifacts") {
      const row = await ctx.db.get(id as Id<"chatArtifacts">);
      if (row) await ctx.db.patch(row._id, { storageId: newStorageId });
    } else if (table === "files") {
      const row = await ctx.db.get(id as Id<"files">);
      if (row) await ctx.db.patch(row._id, { storageId: newStorageId });
    } else if (table === "users") {
      const row = await ctx.db.get(id as Id<"users">);
      if (row) await ctx.db.patch(row._id, { imageId: newStorageId });
    }
  },
});

/**
 * Neutralise blobs a browser would execute, without losing anyone's bytes.
 *
 * PROSPECTIVE PROTECTION IS NOT ENOUGH. `getUrl()` hands out bearer URLs with no
 * expiry, so an executable blob stored before the registration guard stays
 * live — and revoking such a URL is only possible by removing the blob it points
 * at. Re-storing under a non-executable type and deleting the original does
 * exactly that: the old URL 404s, the bytes survive at a new id.
 *
 * Nothing user-visible changes. Both serving routes take their content-type from
 * the ROW (`/artifact/file` uses allowed.mime; attachments return a.contentType),
 * so a download still arrives correctly typed. Only the RAW getUrl path — the
 * one that renders same-origin — is neutered.
 *
 * Orphans (no row references them) are deleted outright; there is nothing to
 * preserve and deleting is what revokes them.
 *
 * Dry run by default. Pass { apply: true } to make changes.
 *
 * `only` narrows the run to explicitly named storage ids. A destructive sweep
 * whose target set is computed at call time is exactly the shape an operator (or
 * a reviewer) cannot check, so naming the blobs makes the intent auditable and
 * the blast radius exact. Omitted = every executable blob, as before.
 */
export const neutralizeExecutableBlobs = internalAction({
  args: { apply: v.optional(v.boolean()), only: v.optional(v.array(v.string())) },
  handler: async (ctx, { apply, only }) => {
    // Annotated to break the circular inference Convex hits when a function
    // runQuery's a sibling in its OWN module (TS7022/7023) — the same fix the
    // Projects work needed for dispatchPayload.
    type Row = {
      storageId: string;
      contentType: string;
      size: number;
      owner: { table: string; id: string; name: string } | null;
    };
    const { rows } = (await ctx.runQuery(
      internal.blobSafety.classifyExecutableBlobs,
      {},
    )) as { executable: number; rows: Row[] };
    const plan: Array<Record<string, unknown>> = [];
    let restored = 0;
    let deleted = 0;

    const targets =
      only && only.length > 0 ? rows.filter((r) => only.includes(r.storageId)) : rows;
    for (const r of targets) {
      if (!r.owner) {
        plan.push({ storageId: r.storageId, size: r.size, action: "delete-orphan" });
        if (apply) {
          await ctx.storage.delete(r.storageId as Id<"_storage">);
          deleted += 1;
        }
        continue;
      }
      plan.push({
        storageId: r.storageId,
        size: r.size,
        owner: `${r.owner.table}:${r.owner.name}`,
        action: "restore-as-text-plain",
      });
      if (!apply) continue;

      const blob = await ctx.storage.get(r.storageId as Id<"_storage">);
      if (!blob) continue;
      const safe = new Blob([await blob.arrayBuffer()], { type: "text/plain" });
      const newStorageId = await ctx.storage.store(safe);
      await ctx.runMutation(internal.blobSafety.repointBlob, {
        table: r.owner.table,
        id: r.owner.id,
        newStorageId,
      });
      // Only after the row points at the copy — otherwise a failure here would
      // leave a row pointing at nothing.
      await ctx.storage.delete(r.storageId as Id<"_storage">);
      restored += 1;
    }
    return { apply: !!apply, total: targets.length, restored, deleted, plan };
  },
});

/**
 * Does every row that references a blob still point at one that exists?
 *
 * The remediation above repoints a row and only then deletes the original, but
 * `repointBlob` resolves its target with a cast — and a cast that missed would
 * make the patch a silent no-op, after which the delete would strand the row.
 * This is the check that the remediation did not destroy anyone's access.
 */
export const auditDanglingBlobRefs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const dangling: Array<{ table: string; id: string; name: string }> = [];
    const check = async (table: string, id: string, name: string, sid: Id<"_storage"> | undefined) => {
      if (!sid) return;
      const meta = await ctx.db.system.get(sid);
      if (!meta) dangling.push({ table, id, name });
    };
    for (const r of await ctx.db.query("chatAttachments").take(5000)) {
      await check("chatAttachments", r._id, r.name, r.storageId);
    }
    for (const r of await ctx.db.query("chatArtifacts").take(5000)) {
      await check("chatArtifacts", r._id, r.filename, r.storageId);
    }
    for (const r of await ctx.db.query("userFiles").take(5000)) {
      await check("userFiles", r._id, r.name, r.storageId ?? undefined);
    }
    for (const r of await ctx.db.query("files").take(5000)) {
      await check("files", r._id, r.name, r.storageId);
    }
    return { dangling: dangling.length, rows: dangling.slice(0, 20) };
  },
});
