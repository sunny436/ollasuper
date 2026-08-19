"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { useWorkspace } from "@/lib/workspace-provider";
import { useAmbience } from "./ambience-provider";

/**
 * Cross-device ambience sync. Renders nothing. Mounted under WorkspaceProvider +
 * ConvexClientProvider (the AmbienceProvider itself stays Convex-free, above them),
 * so it can read the current workspace + Convex while driving the shared theme.
 *
 * Policy: localStorage still wins the instant pre-paint render (no flash). Once the
 * per-user/workspace server value resolves, if it differs — because another device
 * changed it — we smoothly tween to it. Local changes here upsert (debounced) so the
 * theme is one shared preference. The value we just adopted from the server is never
 * written back, so there is no echo loop; a drag coalesces to a single write.
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

  const serverAmbience = settings?.ambience ?? null;

  // Server → local: adopt a value set on another device (smooth, not a snap).
  useEffect(() => {
    if (serverAmbience == null || serverAmbience === lastServer.current) return;
    lastServer.current = serverAmbience;
    setIntensityAnimated(serverAmbience);
  }, [serverAmbience, setIntensityAnimated]);

  // Local → server (debounced). Skip the value we just adopted, and wait for the
  // initial query so we don't clobber the server before we've seen it.
  useEffect(() => {
    if (!current || settings === undefined) return;
    if (intensity === lastServer.current || intensity === serverAmbience) return;
    const id = setTimeout(() => {
      lastServer.current = intensity;
      upsert({ workspaceId: current, ambience: intensity }).catch(() => {});
    }, 1000);
    return () => clearTimeout(id);
  }, [intensity, current, settings, serverAmbience, upsert]);

  return null;
}
