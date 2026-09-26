"use client";

import {
  CACHE_KEYS,
  readOwnedCache,
  writeOwnedCache,
} from "@/lib/display-cache";
import { useCacheOwner } from "@/lib/use-cache-owner";
import { api } from "@v1/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";

const KEY = CACHE_KEYS.user;

/** The slice of api.users.getUser the greeting + account footer actually read. */
type CachedUser = {
  name?: string;
  // The profile's Display name. `getUser` returns `name` as `username || name`,
  // so anything rendering `name` shows the USERNAME for anyone who has set one.
  // Cached alongside it so a cold start does not flash the username first.
  displayName?: string | null;
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
  const owner = useCacheOwner();
  const [cached, setCached] = useState<CachedUser | null>(null);

  // Hydrate from cache post-mount — and again whenever the verified owner
  // changes, so mounted state never outlives the account it was read for.
  useEffect(() => {
    setCached(readOwnedCache<CachedUser>(KEY, owner));
  }, [owner]);

  // Refresh the cache whenever the live value resolves; a live NULL means the
  // server does not recognise this session, so nothing may stay behind.
  useEffect(() => {
    if (live === null) {
      setCached(null);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(KEY);
        } catch {}
      }
      return;
    }
    if (!live) return;
    writeOwnedCache<CachedUser>(KEY, owner, {
      name: live.name ?? undefined,
      displayName: live.displayName ?? undefined,
      email: live.email ?? undefined,
      avatarUrl: live.avatarUrl ?? undefined,
    });
  }, [live, owner]);

  // Live wins the instant it lands — INCLUDING null (signed out: show nothing,
  // never the previous account). Until then, this owner's cached copy only.
  if (live !== undefined) return live;
  return owner ? cached : null;
}
