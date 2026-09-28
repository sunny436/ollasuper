/**
 * Is this file one a CHAT can actually read?
 *
 * The chat composer refuses anything else up front. It no longer routes
 * uploads anywhere: every upload, from every door, is a File Library file, and
 * the SERVER decides whether it is processed (convex/fileKind.ts isProcessable)
 * or only kept — so the Library page accepts any file, and this predicate only
 * gives the composer an instant, clear refusal.
 *
 * Kept deliberately in step with the SERVER, which is the authority:
 *   - mime allowlist mirrors convex/chat/attachments.ts
 *   - the `text/*` + extension fallbacks mirror services/ai/app/ingest/detect.py,
 *     whose text branch returns "text" for ANYTHING that decodes as UTF-8. That
 *     is why code files are admitted: .py/.sql/.yaml ingest fine as text, and an
 *     extension allowlist copied from detect.py's `_EXT` table would wrongly
 *     demote them. detect.py only gives up on undecodable bytes with no known
 *     magic AND no known extension (.zip, .mp4, .exe) — which is what this
 *     predicate rejects.
 *
 * Erring towards `false` is safe: the file still uploads, it just lands in plain
 * storage, which is what every non-chat surface did before this was shared.
 */

// Mirrors the allowlist enforced server-side in chat/attachments.ts. The server
// is the authority; this only gives immediate feedback.
const ACCEPTED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// Code/text files often arrive with an empty or application/octet-stream MIME
// (e.g. .py). They ingest as plain text, so accept them by EXTENSION too.
const CODE_EXT = new Set([
  "py", "js", "ts", "tsx", "jsx", "go", "java", "rb", "rs", "c", "cc", "cpp",
  "h", "hpp", "cs", "php", "swift", "kt", "scala", "sh", "bash", "sql", "yaml",
  "yml", "toml", "ini", "cfg", "conf", "xml", "css", "scss", "less", "log",
  "txt", "md", "markdown", "json", "csv", "tsv", "html", "htm",
]);

export function accepted(file: File): boolean {
  const t = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ACCEPTED.has(t) || t.startsWith("text/")) return true;
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  return CODE_EXT.has(ext);
}

/** SHA-256 hex of a file's bytes — the "you already have this file" check. */
export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
