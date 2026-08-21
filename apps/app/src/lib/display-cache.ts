"use client";

/**
 * Display-only localStorage caches that mask the Convex WebSocket cold-connect
 * (~2-3s through the tunnel) so chrome and transcript paint instantly on reload
 * instead of flashing a skeleton. Every value here is reconciled by a live query
 * the moment it lands; nothing security- or send-related reads from these keys.
 *
 * They MUST be cleared on sign-out. Otherwise the next account signed in on a
 * shared browser briefly sees the previous user's name, thread list and
 * transcript before the live queries overwrite them.
 */
export const CACHE_KEYS = {
  /** api.users.getUser display slice — see use-cached-user.ts. */
  user: "user",
  /** api.chat.threads.list first page — see use-cached-threads.ts. */
  threads: "chat:threads",
  /** The active thread's settled transcript — see use-cached-transcript.ts. */
  transcript: "chat:transcript",
} as const;

export function clearDisplayCaches(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.values(CACHE_KEYS)) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Private mode / blocked storage — nothing to clear.
  }
}
