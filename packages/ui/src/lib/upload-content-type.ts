/**
 * The content-type a blob may be STORED under.
 *
 * Convex serves a stored blob with the content-type given on the upload POST,
 * and `ctx.storage.getUrl()` returns a URL on the app's own origin — so a blob
 * stored as `text/html` is same-origin script execution against whoever opens
 * it. The backend refuses to register such a blob (convex/blobSafety.ts).
 *
 * That would also refuse a perfectly ordinary "upload my page.html", which is a
 * real thing this product does. So the bytes and the RECORDED type are kept
 * exactly as they are — only the type the blob is stored and later served under
 * is neutered. The file still uploads, still classifies as text, and the model
 * still reads it; a browser just will not execute it.
 */
const EXECUTABLE = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xslt+xml",
  "text/xsl",
]);

/** What to send as the upload POST's Content-Type. */
export function storageContentType(fileType: string): string {
  const t = (fileType || "").split(";")[0]?.trim().toLowerCase();
  if (!t) return "application/octet-stream";
  return EXECUTABLE.has(t) ? "text/plain" : fileType;
}
