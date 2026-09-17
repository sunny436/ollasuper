"use client";

import { memo, useEffect, useState } from "react";

/**
 * Mermaid diagram, rendered only once the fenced block is complete.
 *
 * SECURITY: this component contains the ONLY dangerouslySetInnerHTML in the chat
 * tree, and it is deliberate and scoped. The injected string is NOT model HTML —
 * it is the SVG that mermaid's own parser generates from the diagram DSL, run
 * with `securityLevel: "strict"`, which escapes every label, forbids inline
 * event handlers, and blocks click-through. Model-authored raw HTML elsewhere is
 * still never parsed (react-markdown has no rehype-raw). Mermaid never sees, and
 * never emits, arbitrary model markup — only the shapes/edges/labels of a valid
 * graph, with the labels escaped. See CLAUDE.md.
 *
 * The engine (~500KB) is behind a dynamic import so it never lands in /chat's
 * first load, exactly like shiki and three.js.
 */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
// A monotonically increasing id keeps mermaid's internal <marker> ids unique
// across diagrams without needing Math.random (which is fine here, but a counter
// is deterministic and cheap).
let renderSeq = 0;

function isDark(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

async function getMermaid(dark: boolean) {
  if (!mermaidPromise) {
    // A failed import (offline, a deploy replacing chunks) must not be cached.
    mermaidPromise = import("mermaid").then(
      (m) => m.default,
      (e) => {
        mermaidPromise = null;
        throw e;
      },
    );
  }
  const mermaid = await mermaidPromise;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    fontFamily: "inherit",
  });
  return mermaid;
}

function MermaidImpl({ code, complete }: { code: string; complete: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-render when the theme flips so colours track light/dark.
  const [dark, setDark] = useState<boolean>(isDark);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(isDark()));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    // Never parse an in-flight diagram: an incomplete graph throws, and
    // re-rendering per token is expensive. Show the source until it settles.
    if (!complete || !code.trim()) {
      setSvg(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    renderSeq = (renderSeq + 1) | 0;
    const id = `mmd-${renderSeq}`;
    getMermaid(dark)
      .then(async (mermaid) => {
        // parse first so a malformed diagram fails cleanly to the code fallback
        // instead of leaving mermaid's error SVG in the transcript.
        await mermaid.parse(code);
        const { svg: out } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(out);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, complete, dark]);

  if (svg) {
    return (
      <div
        className="my-3 flex justify-center overflow-x-auto rounded-lg border border-border bg-card/40 p-3 [&_svg]:max-w-full [&_svg]:h-auto"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid-generated SVG only, securityLevel:"strict"; see file header + CLAUDE.md
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  // Not yet rendered (streaming), or invalid diagram — show the source so the
  // content is never lost.
  return (
    <pre className="my-3 overflow-x-auto rounded-lg bg-black/[0.045] p-4 font-geist-mono text-[12.5px] leading-[1.7] dark:bg-white/[0.04] md:text-[13px]">
      <code>{code}</code>
      {failed && (
        <span className="mt-2 block text-[11px] text-primary/40">
          (mermaid: diagram could not be rendered)
        </span>
      )}
    </pre>
  );
}

export const Mermaid = memo(
  MermaidImpl,
  (a, b) => a.code === b.code && a.complete === b.complete,
);
