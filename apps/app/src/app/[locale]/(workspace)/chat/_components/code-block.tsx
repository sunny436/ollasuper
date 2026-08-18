"use client";

import { Check, Copy } from "lucide-react";
import { type ReactNode, memo, useEffect, useRef, useState } from "react";
import { highlight } from "../_lib/highlighter";

/**
 * The plain and highlighted renders MUST share these classes exactly.
 * The swap then changes colour only — same font, size, line-height and
 * padding — so there is no reflow and therefore no scroll displacement when
 * highlighting lands.
 */
const PRE =
  "overflow-x-auto rounded-lg bg-black/[0.045] p-4 font-geist-mono text-[12.5px] leading-[1.7] dark:bg-white/[0.04] md:text-[13px]";

function CodeBlockImpl({
  code,
  lang,
  complete,
}: {
  code: string;
  lang?: string;
  complete: boolean;
}) {
  const [nodes, setNodes] = useState<ReactNode | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Highlight exactly once, when the fence closes. Never during streaming:
    // re-highlighting a growing string is expensive and visibly flickers.
    if (!complete) {
      setNodes(null);
      return;
    }
    let cancelled = false;
    highlight(code, lang).then((n) => {
      if (!cancelled) setNodes(n);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, complete]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      },
      () => {
        /* clipboard denied — nothing useful to say, and never console.error */
      },
    );
  };

  return (
    <div className="group relative my-3 -mx-4 md:mx-0">
      <div className="flex items-center justify-between rounded-t-lg border-b border-border/60 bg-black/[0.03] px-3 py-1.5 dark:bg-white/[0.03] md:rounded-t-lg">
        <span className="font-geist-mono text-[11px] uppercase tracking-wide text-primary/40">
          {lang ?? "text"}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary/50 transition hover:bg-primary/5 hover:text-primary/80"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      {nodes ? (
        <div className={`${PRE} rounded-t-none [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0`}>
          {nodes}
        </div>
      ) : (
        <pre className={`${PRE} rounded-t-none`}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

export const CodeBlock = memo(
  CodeBlockImpl,
  (a, b) => a.code === b.code && a.lang === b.lang && a.complete === b.complete,
);
