/**
 * Is this file one the knowledge pipeline can actually READ?
 *
 * This is the single predicate that decides whether an upload becomes a
 * searchable `userFiles` row (ingested + embedded, answerable by the model) or a
 * plain `files` row (stored, downloadable, not searchable). It must give the
 * SAME answer from every upload door — the chat paperclip, Settings > Files and
 * the dashboard /files page — because the whole point is that a file's
 * searchability depends on the file, never on which button uploaded it.
 *
 * That is why it lives here rather than being copied per surface: a second copy
 * of a routing rule is a second thing to forget to update, and the drift is
 * silent (a file just quietly stops being answerable).
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

/** SHA-256 hex for per-user dedup of the persistent knowledge file. */
export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
