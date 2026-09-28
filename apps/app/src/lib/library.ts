/**
 * File Library — the client half of an upload, and the "Free up space" rules.
 *
 * One path for every upload door (the Library page, the chat paperclip, a
 * Project's sources): beginUpload → POST the bytes → finishUpload. The server
 * decides everything that matters (size, type, quota, what may be deleted);
 * this module only drives the steps and turns "not enough space" into a
 * question for the user. Nothing here ever deletes a file on its own.
 */

import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { storageContentType } from "./upload-content-type";

export const QUOTA_LABEL = "100 MB";

export type SpacePlan = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  needBytes: number;
  shortBytes: number;
  canFit: boolean;
};

export type Candidate = {
  _id: Id<"userFiles">;
  name: string;
  size: number;
  kind: string;
  createdAt: number;
};

/** Why the upload is waiting on the user — the panel's heading depends on it. */
export type SpaceReason = "NEEDS_SPACE" | "CANNOT_FIT" | "QUOTA_EXCEEDED" | "QUOTA_PLAN_CHANGED";

export type SpaceRequest = {
  reason: SpaceReason;
  plan: SpacePlan;
  candidates: Candidate[];
};

export type UploadResult =
  | { ok: true; fileId: Id<"userFiles">; evicted: string[] }
  | { ok: false; space: SpaceRequest }
  | { ok: false; message: string };

type BeginResult =
  | { ok: true; intentId: Id<"uploadIntents">; uploadUrl: string }
  | { ok: false; reason: "NEEDS_SPACE" | "CANNOT_FIT"; plan: SpacePlan; candidates: Candidate[] };

type FinishResult =
  | { ok: true; fileId: Id<"userFiles">; evicted: string[] }
  | { ok: false; code: "QUOTA_EXCEEDED" | "QUOTA_PLAN_CHANGED"; plan: SpacePlan; candidates: Candidate[] }
  | { ok: false; code: string; message: string };

export type LibraryUploadDeps = {
  beginUpload: (a: {
    workspaceId: Id<"workspaces">;
    name: string;
    contentType: string;
    size: number;
    purpose: "library" | "chat";
    approvedDeletions?: Id<"userFiles">[];
  }) => Promise<BeginResult>;
  finishUpload: (a: {
    intentId: Id<"uploadIntents">;
    storageId: Id<"_storage">;
    name: string;
    contentType: string;
    approvedDeletions?: Id<"userFiles">[];
  }) => Promise<FinishResult>;
  abortUpload: (a: { intentId: Id<"uploadIntents">; storageId?: Id<"_storage"> }) => Promise<unknown>;
  /** POST the bytes; resolves the storage id. Injected so tests need no network. */
  send?: (url: string, file: File, contentType: string, onProgress?: (pct: number) => void) => Promise<string>;
};

/**
 * Upload one file into the caller's Library.
 *
 * `approvedDeletions` is the user's own choice from the Free-up-space panel,
 * passed on unchanged: the server re-checks every id and deletes only those,
 * in the same transaction as the new file. If the answer comes back asking for
 * space again (another tab changed things), the caller asks the user again.
 */
export async function uploadToLibrary(
  deps: LibraryUploadDeps,
  args: {
    workspaceId: Id<"workspaces">;
    file: File;
    purpose: "library" | "chat";
    approvedDeletions?: Id<"userFiles">[];
    onProgress?: (pct: number) => void;
  },
): Promise<UploadResult> {
  const { file } = args;
  // The declared type goes to the ROW; the stored type is neutralised so no
  // browser ever executes the blob (see upload-content-type).
  const contentType = file.type || "application/octet-stream";
  const begun = await deps.beginUpload({
    workspaceId: args.workspaceId,
    name: file.name,
    contentType: storageContentType(file.type),
    size: file.size,
    purpose: args.purpose,
    ...(args.approvedDeletions?.length ? { approvedDeletions: args.approvedDeletions } : {}),
  });
  if (!begun.ok) {
    return { ok: false, space: { reason: begun.reason, plan: begun.plan, candidates: begun.candidates } };
  }
  const send = deps.send ?? xhrUpload;
  let storageId: string;
  try {
    storageId = await send(begun.uploadUrl, file, storageContentType(contentType), args.onProgress);
  } catch (e) {
    // The session's reservation is released at once rather than at expiry.
    await deps.abortUpload({ intentId: begun.intentId }).catch(() => {});
    throw e;
  }
  const done = await deps.finishUpload({
    intentId: begun.intentId,
    storageId: storageId as Id<"_storage">,
    name: file.name,
    contentType: storageContentType(file.type),
    ...(args.approvedDeletions?.length ? { approvedDeletions: args.approvedDeletions } : {}),
  });
  if (done.ok) return done;
  if ("plan" in done) {
    // Not enough room after all (state changed since the question was asked).
    // The session and its blob are released; the user is asked again.
    await deps.abortUpload({ intentId: begun.intentId, storageId: storageId as Id<"_storage"> }).catch(() => {});
    return { ok: false, space: { reason: done.code, plan: done.plan, candidates: done.candidates } };
  }
  return { ok: false, message: done.message };
}

/** POST with real upload progress (fetch exposes none). */
export function xhrUpload(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 413) return reject(new Error("The file is too large."));
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`Upload failed (${xhr.status})`));
      try {
        resolve(JSON.parse(xhr.responseText).storageId);
      } catch {
        reject(new Error("Upload failed"));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

// ------------------------------------------------------------ free up space

export type CandidateSort = "oldest" | "largest";

export function sortCandidates(list: Candidate[], sort: CandidateSort): Candidate[] {
  const copy = [...list];
  return sort === "largest"
    ? copy.sort((a, b) => b.size - a.size || a.createdAt - b.createdAt)
    : copy.sort((a, b) => a.createdAt - b.createdAt);
}

/** The default selection: the oldest files, just enough to fit. */
export function preselect(list: Candidate[], shortBytes: number): Id<"userFiles">[] {
  const out: Id<"userFiles">[] = [];
  let freed = 0;
  for (const f of sortCandidates(list, "oldest")) {
    if (freed >= shortBytes) break;
    out.push(f._id);
    freed += f.size;
  }
  return out;
}

export function selectedBytes(list: Candidate[], selected: ReadonlySet<string>): number {
  return list.reduce((sum, f) => (selected.has(f._id) ? sum + f.size : sum), 0);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The /library/file URL for a capability token (served by the Convex site). */
export function libraryFileUrl(convexUrl: string, token: string, purpose: "download" | "preview"): string {
  const site = convexUrl.includes("/__cvx") ? convexUrl.replace("/__cvx", "/__cvx-site") : siteOf(convexUrl);
  const q = purpose === "preview" ? `t=${token}&p=preview` : `t=${token}`;
  return `${site.replace(/\/$/, "")}/library/file?${q}`;
}

/** Host form: https://x.convex.cloud → https://x.convex.site; :3210 → :3211. */
function siteOf(url: string): string {
  if (url.includes(".convex.cloud")) return url.replace(".convex.cloud", ".convex.site");
  return url.replace(/:3210(\/|$)/, ":3211$1");
}
