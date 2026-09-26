"use client";

import { useAuthToken } from "@convex-dev/auth/react";
import { useEffect, useMemo } from "react";
import { clearDisplayCaches, ownerFromToken } from "./display-cache";

/**
 * The verified user the display caches may be read for, or null.
 *
 * Null means signed out, expired or not yet known — and a null owner CLEARS
 * the persistent caches and the in-memory prefetch seeds, so a session that
 * ended any way other than the explicit sign-out button (expiry, revocation
 * while the tab was closed, displacement) still leaves nothing behind for the
 * next person at this browser (audit F-09).
 */
export function useCacheOwner(): string | null {
  const token = useAuthToken();
  const owner = useMemo(() => ownerFromToken(token), [token]);
  useEffect(() => {
    if (owner === null) clearDisplayCaches();
  }, [owner]);
  return owner;
}
