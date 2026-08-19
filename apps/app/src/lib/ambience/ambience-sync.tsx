"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { useWorkspace } from "@/lib/workspace-provider";
import { useAmbience } from "./ambience-provider";

const TS_KEY = "ambience-ts";
const readTs = () => {
  try {
    return Number(localStorage.getItem(TS_KEY) || 0);
  } catch {
    return 0;
  }
};
const writeTs = (t: number) => {
  try {
    localStorage.setItem(TS_KEY, String(t));
  } catch {}
};

/**
 * Cross-device ambience sync. Renders nothing. Mounted under WorkspaceProvider +
 * ConvexClientProvider (the AmbienceProvider stays Convex-free, above them).
 *
 * Last-write-wins by timestamp so a device NEVER loses a fresh local change to a
 * stale server value: localStorage still wins the instant pre-paint render (no
 * flash); on the first server resolution we adopt the server value only if it is
 * newer (another device changed it more recently), else we push the local value
 * up. Afterwards we adopt live pushes from other devices — but only when the
 * ambience VALUE actually differs (guarding against `updatedAt` bumps from other
 * settings fields). Local changes upsert debounced; a drag coalesces to one write.
 */
export function AmbienceSync() {
  const { current } = useWorkspace();
  const { intensity, setIntensityAnimated } = useAmbience();
  const settings = useQuery(
    api.chat.settings.get,
    current ? { workspaceId: current } : "skip",
  );
  const upsert = useMutation(api.chat.settings.upsert);
  const lastServer = useRef<number | null>(null);
  const decided = useRef(false);

  const serverA = settings?.ambience ?? null;
  const serverTs = settings?.updatedAt ?? 0;

  // Reconcile local <-> server.
  useEffect(() => {
    if (!current || settings === undefined) return;

    if (!decided.current) {
      decided.current = true;
      if (serverA != null && serverTs > readTs()) {
        lastServer.current = serverA;
        writeTs(serverTs);
        setIntensityAnimated(serverA);
      } else if (intensity !== serverA) {
        lastServer.current = intensity;
        writeTs(Date.now());
        upsert({ workspaceId: current, ambience: intensity }).catch(() => {});
      } else {
        lastServer.current = serverA;
      }
      return;
    }

    // A live push from another device (value actually changed + newer).
    if (serverA != null && serverA !== lastServer.current && serverTs > readTs()) {
      lastServer.current = serverA;
      writeTs(serverTs);
      setIntensityAnimated(serverA);
    }
  }, [settings, current, serverA, serverTs, setIntensityAnimated, upsert, intensity]);

  // Local change → push up (debounced), skipping the value we just adopted.
  useEffect(() => {
    if (!decided.current || !current) return;
    if (intensity === lastServer.current) return;
    const id = setTimeout(() => {
      lastServer.current = intensity;
      writeTs(Date.now());
      upsert({ workspaceId: current, ambience: intensity }).catch(() => {});
    }, 1000);
    return () => clearTimeout(id);
  }, [intensity, current, upsert]);

  return null;
}
