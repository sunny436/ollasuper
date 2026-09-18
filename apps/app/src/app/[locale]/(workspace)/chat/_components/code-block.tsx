"use client";

import { Check, Copy, Download } from "lucide-react";
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

  // Filename extension for the download, keyed by the fence language. Falls
  // back to .txt for prose / unknown languages.
  const EXT: Record<string, string> = {
    typescript: "ts", javascript: "js", tsx: "tsx", jsx: "jsx", json: "json",
    python: "py", bash: "sh", shell: "sh", sql: "sql", html: "html", css: "css",
    scss: "scss", yaml: "yml", yml: "yml", markdown: "md", md: "md", rust: "rs",
    go: "go", c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", "c#": "cs", cs: "cs",
    java: "java", swift: "swift", kotlin: "kt", kt: "kt", php: "php", ruby: "rb",
    rb: "rb", r: "r", dart: "dart", lua: "lua", perl: "pl", asm: "asm", matlab: "m",
    xml: "xml", svg: "svg", graphql: "graphql", powershell: "ps1", batch: "bat",
    toml: "toml", csv: "csv", tsv: "tsv", docker: "dockerfile", dockerfile: "dockerfile",
    ini: "ini", dotenv: "env", nginx: "conf", make: "mk", makefile: "mk",
    diff: "diff", patch: "diff", mermaid: "mmd",
  };

  const onDownload = () => {
    try {
      const ext = (lang && EXT[lang.toLowerCase()]) || "txt";
      const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `snippet.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* download blocked — nothing useful to say, and never console.error */
    }
  };

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
        <span className="text-[11px] uppercase tracking-wide text-primary/60">
          {lang ?? "text"}
        </span>
        <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onDownload}
          aria-label="Download code"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary/65 transition hover:bg-primary/5 hover:text-primary/80"
        >
          <Download className="h-3 w-3" /> Download
        </button>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary/65 transition hover:bg-primary/5 hover:text-primary/80"
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
