"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { useWorkspace } from "@/lib/workspace-provider";
import { legacyFromMode, modeFromLegacy } from "./legacy-ambience";
import { applyMode, currentMode, readCachedAt, writeCachedMode } from "./mode";
import { useTheme } from "./theme-provider";

/**
 * Cross-device theme sync. Renders nothing.
 *
 * PRECEDENCE, enforced here because this is the only layer that can see both
 * sources: an explicit ACCOUNT preference outranks the localStorage cache, which
 * outranks the OS. The cache still wins the pre-paint render — that is what
 * avoids the flash — and is corrected here within a frame of the query
 * resolving, if the account disagrees.
 *
 * WHAT IT REFUSES TO DO:
 *  - adopt "no preference" as a preference. `settings === undefined` is IN
 *    FLIGHT and `ambience === null`/the legacy default is NOT CHOSEN; treating
 *    either as a value is what flips a theme on a slow connection.
 *  - overwrite a legacy row on load. A row is rewritten only when the user
 *    actually toggles, so the 53 production rows sitting on the old engine's
 *    default keep following the OS instead of being pinned to light.
 *  - flip when the backend is unreachable: the query simply stays undefined and
 *    the local theme is kept.
 *
 * Last-write-wins by timestamp, so a device never loses a fresh local change to
 * a stale server value.
 */
export function ThemeSync() {
  const { current } = useWorkspace();
  const { setMode } = useTheme();
  const settings = useQuery(
    api.chat.settings.get,
    current ? { workspaceId: current } : "skip",
  );
  const upsert = useMutation(api.chat.settings.upsert);
  const lastServer = useRef<number | null>(null);
  const decided = useRef(false);

  const serverMode = modeFromLegacy(settings?.ambience);
  const serverTs = settings?.updatedAt ?? 0;

  useEffect(() => {
    if (!current || settings === undefined) return; // still loading: keep local
    const local = currentMode();

    if (!decided.current) {
      decided.current = true;
      if (serverMode && serverTs > readCachedAt()) {
        // Another device chose more recently — adopt it and cache it.
        lastServer.current = settings.ambience ?? null;
        writeCachedMode(serverMode, serverTs);
        setMode(serverMode);
      } else if (serverMode && serverMode !== local) {
        // Our cache is newer: push it up rather than adopting a stale value.
        lastServer.current = legacyFromMode(local);
        upsert({ workspaceId: current, ambience: legacyFromMode(local) }).catch(
          () => undefined,
        );
      } else {
        // No explicit account preference: leave the row alone. Nothing is
        // written until the user actually toggles.
        lastServer.current = settings.ambience ?? null;
      }
      return;
    }

    // Live push from another device — only when the VALUE really changed (other
    // settings fields also bump updatedAt) and is newer than our own write.
    const raw = settings.ambience ?? null;
    if (serverMode && raw !== lastServer.current && serverTs > readCachedAt()) {
      lastServer.current = raw;
      writeCachedMode(serverMode, serverTs);
      applyMode(serverMode);
      setMode(serverMode);
    }
  }, [settings, current, serverMode, serverTs, setMode, upsert]);

  // A local toggle: persist it. Skips the value we just adopted from the server,
  // so an adopted push does not echo back as a new write.
  const { mode } = useTheme();
  useEffect(() => {
    if (!decided.current || !current) return;
    const value = legacyFromMode(mode);
    if (value === lastServer.current) return;
    lastServer.current = value;
    writeCachedMode(mode);
    upsert({ workspaceId: current, ambience: value }).catch(() => undefined);
  }, [mode, current, upsert]);

  return null;
}
