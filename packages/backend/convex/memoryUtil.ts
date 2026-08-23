/**
 * Phase 6 — pure helpers for long-term memory: caps, normalization, default
 * scope, and a conservative secret-scan. No Convex context; imported by
 * memories.ts (the server-side authority) and unit-tested directly.
 */

export const MAX_MEMORY_CHARS = 2000;
export const MEMORY_ACTIVE_CAP = 200;

export type MemoryKind =
  | "preference"
  | "instruction"
  | "fact"
  | "project_context";
export type MemoryScope = "user" | "workspace";
export type MemorySource = "explicit" | "inferred";

/** Personal tone/style is user-global; facts/project context are tenant-bound
 *  by default so they can't leak across workspaces (spec §15). */
export function defaultScopeForKind(kind: MemoryKind): MemoryScope {
  return kind === "preference" || kind === "instruction" ? "user" : "workspace";
}

/** Idempotency key: lowercase, collapse whitespace, drop trailing punctuation. */
export function normalizeMemory(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/g, "")
    .trim()
    .slice(0, MAX_MEMORY_CHARS);
}

export function strongestSource(
  a: MemorySource,
  b: MemorySource,
): MemorySource {
  return a === "explicit" || b === "explicit" ? "explicit" : "inferred";
}

// Reject keyword+delimiter+value and high-entropy / known-key shapes — NEVER a
// bare keyword. "I forgot my password" and "my manager is Priya" pass;
// "password: hunter2" and an API key do not. Fail-safe toward rejecting: a
// dropped memory is recoverable, a persisted plaintext secret is not.
const _SECRET_PATTERNS: RegExp[] = [
  /[A-Za-z0-9_\-]{40,}/, // long unbroken token (keys, JWT bodies)
  /\bsk-[A-Za-z0-9]{16,}/i,
  /\bpk-[A-Za-z0-9]{16,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_\-]{35}\b/,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._\-]{20,}/i,
  /\b(pass(word|wd)?|secret|api[_-]?key|token|credential|client[_-]?secret)\s*[:=]\s*\S{6,}/i,
  /\b(?:\d[ -]?){13,19}\b/, // card-like digit run
];

export function scanForSecret(content: string): boolean {
  return _SECRET_PATTERNS.some((re) => re.test(content));
}
