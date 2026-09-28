/**
 * File Library — the pure, server-side rules about a file (no database).
 *
 * The client never decides any of this: a browser's declared MIME and name are
 * inputs, not facts. `kind` only drives Library filters; what may EXECUTE or
 * RENDER is decided elsewhere, from stored bytes (blobSafety.ts, and the magic
 * check in `inlineImageType` below).
 */

export type FileKind =
  | "image"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "text"
  | "other";

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function baseType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "svg"]);
const DOC_EXT = new Set(["doc", "docx", "odt", "rtf", "pages"]);
const SHEET_EXT = new Set(["xls", "xlsx", "ods", "csv", "tsv", "numbers"]);
const SLIDE_EXT = new Set(["ppt", "pptx", "odp", "key"]);
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "xml", "html", "htm", "css", "scss", "less", "log", "py", "js", "ts", "tsx",
  "jsx", "go", "java", "rb", "rs", "c", "cc", "cpp", "h", "hpp", "cs", "php",
  "swift", "kt", "scala", "sh", "bash", "sql",
]);
/** Containers: stored only, never opened, never decompressed (no bombs, no depth). */
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst", "jar", "war", "iso", "dmg"]);
const ARCHIVE_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
  "application/java-archive",
]);

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isArchive(name: string, contentType: string): boolean {
  return ARCHIVE_EXT.has(extOf(name)) || ARCHIVE_TYPES.has(baseType(contentType));
}

/** The Library filter bucket. Display only — never a security decision. */
export function fileKind(name: string, contentType: string): FileKind {
  const ct = baseType(contentType);
  const ext = extOf(name);
  if (isArchive(name, contentType)) return "other";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ct.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (ct === PPTX || ct === "application/vnd.ms-powerpoint" || SLIDE_EXT.has(ext)) return "presentation";
  if (ct === XLSX || ct === "application/vnd.ms-excel" || ct === "text/csv" || SHEET_EXT.has(ext)) return "spreadsheet";
  if (ct === DOCX || ct === "application/msword" || DOC_EXT.has(ext)) return "document";
  if (ct.startsWith("text/") || ct === "application/json" || TEXT_EXT.has(ext)) return "text";
  return "other";
}

/**
 * Should this file go to the processing (extraction + embedding) pipeline?
 *
 * Mirrors what services/ai/app/ingest/detect.py can actually read; anything
 * else is kept as-is (`stored`). Archives NEVER go — the pipeline must never
 * see a container it might decompress. Python re-checks from the bytes and
 * refuses what it cannot parse, so erring towards `true` costs a `failed` row
 * with a reason, never a security property.
 */
export function isProcessable(name: string, contentType: string): boolean {
  if (isArchive(name, contentType)) return false;
  const ct = baseType(contentType);
  const ext = extOf(name);
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(ct)) return true;
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return true;
  if (ct === "application/pdf" || ext === "pdf") return true;
  if (ct === DOCX || ext === "docx") return true;
  if (ct === PPTX || ext === "pptx") return true;
  if (ct === XLSX || ext === "xlsx") return true;
  if (ct.startsWith("text/") || ct === "application/json") return true;
  return TEXT_EXT.has(ext) || ext === "csv" || ext === "tsv";
}

/**
 * Characters that must never reach a stored name: C0/C1 controls (CR/LF would
 * split a header), and the bidi overrides/isolates that make "gpj.exe" read as
 * "exe.jpg" in a file list — the classic extension-spoofing trick.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/** A display name that is safe to store, list and put in a header. */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .replace(UNSAFE_NAME, "")
    .replace(/[\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
  return cleaned || "untitled";
}

/** The name A–Z / Z–A sort key. */
export function nameKeyOf(name: string): string {
  return name.toLowerCase().slice(0, 255);
}

/** The chat-attachment bucket the Python plane understands. */
export function chatKindOf(kind: FileKind): "image" | "document" | "text" {
  if (kind === "image") return "image";
  if (kind === "text") return "text";
  if (kind === "spreadsheet") return "document";
  return "document";
}

/**
 * The ONLY types the Library ever renders inline — identified from the bytes,
 * never from the name or the stored type. Anything else (including SVG, HTML,
 * PDF, polyglots) is served as an attachment.
 */
export function inlineImageType(head: Uint8Array): string | null {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return "image/gif";
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/**
 * `Content-Disposition` for a stored name: an ASCII fallback plus the RFC 5987
 * UTF-8 form, so non-Latin names survive and nothing can break the header.
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const safe = sanitizeFileName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  const utf8 = encodeURIComponent(safe).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Convex's `_storage.sha256` is BASE64 (despite the "hex" wording in its type
 * comment — measured); Python and every other hash here are lower-case hex.
 * One normaliser, so a comparison between them can never silently always-fail.
 */
export function sha256Hex(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const raw = atob(value);
    if (raw.length !== 32) return undefined;
    return Array.from(raw, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}
