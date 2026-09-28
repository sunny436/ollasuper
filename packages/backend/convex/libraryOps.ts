import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import { sha256Hex } from "./fileKind";

/**
 * File Library operator tools that prove things about bytes:
 *
 *   * cleanupKnowledgeCopies — the knowledge DB still holds BYTEA copies of
 *     files (migration remnants from before the Convex blob became the only
 *     original). A copy is removed ONLY when Convex's own original is present
 *     and hashes to the same SHA-256. Anything unverified is kept — it might be
 *     the last copy. Dry run by default.
 *   * verifyStorageIntegrity — the restore drill's proof: every stored blob is
 *     read back and hashed against its record, and every Library row's blob
 *     must exist. Paged; the caller loops on the cursor.
 */

function aiConfig(): { base: string; key: string } | null {
  const base = process.env.AI_BASE_URL;
  const key = process.env.AI_SERVICE_KEY;
  return base && key ? { base: base.replace(/\/$/, ""), key } : null;
}

type Copy = { id: string; sha256: string };
type Verdict = { id: string; verdict: "verified" | "orphan" | "unverified"; why?: string };

/** For each copy: may it go? Only when the Convex original provably matches. */
export const judgeCopies = internalQuery({
  args: { copies: v.array(v.object({ id: v.string(), sha256: v.string() })) },
  handler: async (ctx, { copies }): Promise<Verdict[]> => {
    const out: Verdict[] = [];
    for (const c of copies.slice(0, 500)) {
      const f = await ctx.db
        .query("userFiles")
        .withIndex("by_ingestId", (q) => q.eq("ingestId", c.id))
        .unique();
      if (!f) {
        out.push({ id: c.id, verdict: "orphan" });
        continue;
      }
      if (!f.storageId) {
        out.push({ id: c.id, verdict: "unverified", why: "no Convex original" });
        continue;
      }
      const meta = await ctx.db.system.get(f.storageId);
      const convexHash = sha256Hex(meta?.sha256);
      const copyHash = c.sha256.toLowerCase();
      if (!meta || !convexHash) {
        out.push({ id: c.id, verdict: "unverified", why: "original unreadable" });
      } else if (convexHash !== copyHash || (f.sha256 && f.sha256 !== copyHash)) {
        out.push({ id: c.id, verdict: "unverified", why: "hash mismatch" });
      } else {
        out.push({ id: c.id, verdict: "verified" });
      }
    }
    return out;
  },
});

export const cleanupKnowledgeCopies = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { dryRun },
  ): Promise<{
    dryRun: boolean;
    scanned: number;
    verified: number;
    orphan: number;
    unverified: number;
    deleted: number;
    unverifiedSample: Verdict[];
  }> => {
    const dry = dryRun !== false;
    const cfg = aiConfig();
    if (!cfg) throw new Error("AI_BASE_URL / AI_SERVICE_KEY not configured");
    const totals = { scanned: 0, verified: 0, orphan: 0, unverified: 0, deleted: 0 };
    const unverifiedSample: Verdict[] = [];
    let after = "";
    for (let page = 0; page < 200; page++) {
      const res = await fetch(`${cfg.base}/v1/ingest/copies?limit=200&after=${encodeURIComponent(after)}`, {
        headers: { "x-service-key": cfg.key },
      });
      if (!res.ok) throw new Error(`copies listing failed: ${res.status}`);
      const body = (await res.json()) as { copies?: Copy[]; next?: string | null };
      const copies = (body.copies ?? []).filter((c) => typeof c.id === "string" && typeof c.sha256 === "string");
      totals.scanned += copies.length;
      const verdicts = await ctx.runQuery(internal.libraryOps.judgeCopies, { copies });
      for (const verdict of verdicts) {
        totals[verdict.verdict]++;
        if (verdict.verdict === "unverified" && unverifiedSample.length < 20) unverifiedSample.push(verdict);
        if (verdict.verdict !== "verified" || dry) continue;
        const del = await fetch(`${cfg.base}/v1/ingest/${encodeURIComponent(verdict.id)}/copy`, {
          method: "DELETE",
          headers: { "x-service-key": cfg.key },
        });
        if (del.ok) totals.deleted++;
      }
      if (!body.next) break;
      after = body.next;
    }
    console.log(JSON.stringify({ event: "LIB_COPIES_CLEANUP", dryRun: dry, ...totals }));
    return { dryRun: dry, ...totals, unverifiedSample };
  },
});

// ------------------------------------------------------------ integrity

export const storagePage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { cursor, numItems }) => {
    const res = await ctx.db.system.query("_storage").paginate({ cursor, numItems });
    return {
      page: res.page.map((s) => ({ id: s._id, sha256: s.sha256, size: s.size })),
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

export const libraryRowsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { cursor, numItems }) => {
    const res = await ctx.db.query("userFiles").paginate({ cursor, numItems });
    const missing: string[] = [];
    for (const f of res.page) {
      if (f.storageId && (await ctx.db.system.get(f.storageId)) === null) missing.push(f._id);
    }
    return { rows: res.page.length, missing, isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One page of the restore drill's byte proof: every blob in the page is read
 * back and hashed; its record's SHA-256 must match. Loop on continueCursor.
 */
export const verifyStorageIntegrity = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: async (
    ctx,
    { cursor, numItems },
  ): Promise<{
    checked: number;
    ok: number;
    mismatch: string[];
    unreadable: string[];
    bytes: number;
    isDone: boolean;
    continueCursor: string;
  }> => {
    const page = await ctx.runQuery(internal.libraryOps.storagePage, {
      cursor: cursor ?? null,
      numItems: Math.min(Math.max(numItems ?? 50, 1), 200),
    });
    const mismatch: string[] = [];
    const unreadable: string[] = [];
    let ok = 0;
    let bytes = 0;
    for (const s of page.page) {
      const blob = await ctx.storage.get(s.id as Id<"_storage">);
      if (!blob) {
        unreadable.push(s.id);
        continue;
      }
      const buf = await blob.arrayBuffer();
      bytes += buf.byteLength;
      const hex = toHex(await crypto.subtle.digest("SHA-256", buf));
      if (hex === sha256Hex(s.sha256) && buf.byteLength === s.size) ok++;
      else mismatch.push(s.id);
    }
    return {
      checked: page.page.length,
      ok,
      mismatch,
      unreadable,
      bytes,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
