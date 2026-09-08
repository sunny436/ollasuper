"use client";

import { CACHE_KEYS } from "@/lib/display-cache";
import { api } from "@v1/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";

const KEY = CACHE_KEYS.user;

/** The slice of api.users.getUser the greeting + account footer actually read. */
type CachedUser = {
  name?: string;
  // getUser returns an explicit projection now, and its optional columns come
  // back as null rather than undefined — accept both.
  email?: string | null;
  avatarUrl?: string | null;
};

/**
 * api.users.getUser, but instant on reload.
 *
 * The live query resolves only after the Convex WebSocket reconnects and the
 * initial subscription batch lands (~2-3s cold through the tunnel), which is why
 * the greeting shows no name and the account footer shows "?" for a beat. This
 * hydrates those display fields from a localStorage copy of the last resolved
 * user, then hands back the live value the moment it arrives.
 *
 * Read happens in an EFFECT, not during render, so the first client render still
 * matches the server (no user) — no hydration mismatch, which every e2e asserts.
 * The cache is display-only; nothing security- or send-related depends on it.
 */
export function useCachedUser(): CachedUser | null | undefined {
  const live = useQuery(api.users.getUser);
  const [cached, setCached] = useState<CachedUser | null>(null);

  // Hydrate from cache once, post-mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setCached(JSON.parse(raw) as CachedUser);
    } catch {}
  }, []);

  // Refresh the cache whenever the live value resolves.
  useEffect(() => {
    if (!live || typeof window === "undefined") return;
    try {
      const slice: CachedUser = {
        name: live.name ?? undefined,
        email: live.email ?? undefined,
        avatarUrl: live.avatarUrl ?? undefined,
      };
      window.localStorage.setItem(KEY, JSON.stringify(slice));
    } catch {}
  }, [live]);

  // Live wins the instant it lands; until then, the cached copy.
  return live ?? cached;
}
