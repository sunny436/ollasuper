"use client";

import { type ComponentType, useEffect, useState } from "react";

type MarkdownProps = { content: string; streaming: boolean };

// The markdown renderer pulls in react-markdown + micromark + remark (~45KB gz)
// plus shiki/mermaid/katex loaders. None of it is needed on the empty new-chat
// landing, which renders no messages — yet a static import would put it in the
// /chat first-load and slow hydration (which gates the Convex WebSocket, and thus
// the whole reload). So it lives in its own chunk, preloaded off the critical path
// before any message needs it.

let Loaded: ComponentType<MarkdownProps> | null = null;
let loadPromise: Promise<ComponentType<MarkdownProps>> | null = null;

/** Kick the chunk download. Idempotent; safe to call from many places. */
export function preloadMarkdown(): Promise<ComponentType<MarkdownProps>> {
  if (!loadPromise) {
    loadPromise = import("./markdown").then(
      (m) => {
        Loaded = m.Markdown as ComponentType<MarkdownProps>;
        return Loaded;
      },
      (e) => {
        // Not cached on failure (offline): without this every message stayed raw
        // text for the rest of the session.
        loadPromise = null;
        throw e;
      },
    );
  }
  return loadPromise;
}

/**
 * Renders <Markdown> once its chunk is loaded, else the raw text (same size) as a
 * seamless placeholder. Preloading (composer focus, message-list mount, an idle
 * callback) means the chunk is almost always ready before this mounts, so the
 * fallback is rarely — often never — seen.
 */
export function LazyMarkdown({ content, streaming }: MarkdownProps) {
  const [Comp, setComp] = useState<ComponentType<MarkdownProps> | null>(
    () => Loaded,
  );

  useEffect(() => {
    if (Comp) return;
    let on = true;
    const load = () =>
      preloadMarkdown().then(
        (c) => {
          if (on) setComp(() => c);
        },
        () => {
          /* offline: retried when the browser comes back online */
        },
      );
    load();
    window.addEventListener("online", load);
    return () => {
      on = false;
      window.removeEventListener("online", load);
    };
  }, [Comp]);

  if (Comp) return <Comp content={content} streaming={streaming} />;
  return (
    <div className="whitespace-pre-wrap break-words text-[15.5px] leading-[1.7] text-primary/90">
      {content}
    </div>
  );
}
