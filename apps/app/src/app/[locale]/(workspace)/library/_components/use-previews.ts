"use client";

import { libraryFileUrl } from "@/lib/library";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

/** A preview capability lives 5 minutes; re-mint a little before that. */
const FRESH_MS = 4 * 60_000;
/** A failing image is not re-minted more often than this. */
const RETRY_GAP_MS = 30_000;
const BATCH = 24;

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

/**
 * Thumbnail URLs for the image cards on screen.
 *
 * Each is a short-lived, single-file capability minted by the server after an
 * ownership check (library.mintPreviews) — never a storage URL. The server
 * serves the bytes inline only if they really are a PNG/JPEG/GIF/WebP. An image
 * that fails (an expired token after a remount) is re-minted, rate-limited per
 * file so a genuinely broken one cannot loop.
 */
export function usePreviews(ids: Id<"userFiles">[]) {
  const mint = useMutation(api.library.mintPreviews);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const mintedAt = useRef(new Map<string, number>());
  const triedAt = useRef(new Map<string, number>());
  const [bump, setBump] = useState(0);
  const key = ids.join(",");

  useEffect(() => {
    if (!key) return;
    const now = Date.now();
    const need = key
      .split(",")
      .filter((id) => {
        const fresh = now - (mintedAt.current.get(id) ?? 0) < FRESH_MS;
        const recent = now - (triedAt.current.get(id) ?? 0) < RETRY_GAP_MS;
        return !fresh && !recent;
      })
      .slice(0, BATCH) as Id<"userFiles">[];
    if (need.length === 0) return;
    for (const id of need) triedAt.current.set(id, now);
    let live = true;
    mint({ fileIds: need })
      .then((out) => {
        if (!live) return;
        const at = Date.now();
        const next: Record<string, string> = {};
        for (const o of out) {
          mintedAt.current.set(o.fileId, at);
          next[o.fileId] = libraryFileUrl(CONVEX_URL, o.token, "preview");
        }
        setUrls((prev) => ({ ...prev, ...next }));
      })
      .catch(() => {
        // Rate-limited or offline: the icon stays; the next change retries.
      });
    return () => {
      live = false;
    };
  }, [key, bump, mint]);

  const urlOf = useCallback((id: string) => urls[id], [urls]);
  const onError = useCallback((id: string) => {
    mintedAt.current.delete(id);
    setUrls((prev) => {
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
    setBump((b) => b + 1);
  }, []);

  return { urlOf, onError };
}
