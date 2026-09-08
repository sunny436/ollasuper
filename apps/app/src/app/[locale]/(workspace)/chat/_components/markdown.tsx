"use client";

import { type ReactNode, memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { type Block, splitBlocks } from "../_lib/split-blocks";
import { isLinkableImage, safeImageUrl, safeUrl } from "../_lib/url-guard";
import { ChartBlock } from "./chart-block";
import { CodeBlock } from "./code-block";
import { Mermaid } from "./mermaid";

/**
 * NOTE ON XSS: `rehype-raw` is deliberately absent from this plugin list.
 * Without it react-markdown never parses raw HTML into nodes, so model output
 * like <img src=x onerror=alert(1)> renders as literal text. That makes this
 * pipeline safe by construction, which is why no sanitiser is present.
 *
 * If anyone ever adds rehype-raw here, rehype-sanitize becomes MANDATORY.
 *
 * remark-math + rehype-katex are safe additions: katex builds its output from
 * the PARSED math AST, not from raw HTML, and never emits script or event
 * handlers (throwOnError:false so a half-typed `$$` during streaming degrades
 * to text instead of throwing). remark-breaks only turns soft line breaks into
 * <br>. Neither opens an HTML passthrough. The one place SVG/HTML is injected is
 * mermaid.tsx — see its header.
 *
 * `singleDollarTextMath:false`: math requires `$$…$$` (block); a single `$` is
 * literal. Currency is far more common than inline math in this product, and the
 * default single-`$` mode mangled prices — "$10/user → $100/month" was parsed as
 * one math span and rendered as a broken KaTeX stack. Block `$$` math is unchanged.
 */
// biome-ignore lint/suspicious/noExplicitAny: react-markdown plugin-tuple typing
const REMARK_PLUGINS: any = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkBreaks,
];
// Stable empty default so blocks memoise while no math is present.
// biome-ignore lint/suspicious/noExplicitAny: rehype plugin tuple typing
const NO_REHYPE: any = [];

// katex is ~75KB gz, so it is loaded (with its CSS) ONLY when a message actually
// contains math — never on the /chat critical path. remark-math itself is a tiny
// parser and stays static; without the rehype plugin, math just renders as its
// raw source until this resolves, then upgrades in one re-render.
let katexPromise: Promise<unknown> | null = null;
function loadKatex(): Promise<unknown> {
  if (!katexPromise) {
    katexPromise = import("rehype-katex").then((m) => {
      // Side-effect: inject katex's stylesheet. CSS value-imports have no types.
      // @ts-expect-error no type declaration for a CSS module import
      void import("katex/dist/katex.min.css");
      // biome-ignore lint/suspicious/noExplicitAny: default export typing
      return (m as any).default;
    });
  }
  return katexPromise;
}

// A message that DEFINES a footnote must be parsed as one document, or the
// reference and the definition (which land in different splitter blocks) never
// link up. Detected narrowly so every non-footnote message keeps the exact
// block-by-block streaming path.
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/m;

/** Concatenate the text of arbitrary React children (for the <pre> router). */
function nodeText(children: ReactNode): string {
  if (children == null || children === false || children === true) return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) return children.map(nodeText).join("");
  // biome-ignore lint/suspicious/noExplicitAny: React element shape
  const props = (children as any)?.props;
  if (props && "children" in props) return nodeText(props.children);
  return "";
}

/** Pull `language-xxx` off a code element's className. */
function langOf(children: ReactNode): string | undefined {
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    // biome-ignore lint/suspicious/noExplicitAny: React element shape
    const cls: string = (c as any)?.props?.className ?? "";
    const m = /language-([\w+#.-]+)/.exec(cls);
    if (m) return m[1];
  }
  return undefined;
}

const components: Components = {
  a: ({ href, children, ...props }) => {
    const safe = safeUrl(href ?? "");
    if (!safe) return <span>{children}</span>;
    return (
      <a
        {...props}
        href={safe}
        target="_blank"
        // noopener/noreferrer defeats reverse tabnabbing.
        rel="noopener noreferrer nofollow"
        className="text-brand-ink underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt, ...props }) => {
    const raw = typeof src === "string" ? src : "";
    const safe = safeImageUrl(raw);
    if (!safe) {
      // An external image is NOT auto-loaded (that is the exfil channel). If it
      // is a valid http(s) URL, offer it as a click-through link so the user can
      // still open it deliberately; otherwise drop it.
      if (isLinkableImage(raw)) {
        const href = safeUrl(raw);
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-brand-ink underline underline-offset-2 hover:opacity-80"
          >
            {alt || "image"} ↗
          </a>
        );
      }
      return null;
    }
    return (
      <img
        {...props}
        src={safe}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="my-3 max-w-full rounded-lg border border-border"
      />
    );
  },
  // Wide tables must scroll inside their own container, or they blow out the
  // flex parent and scroll the whole pane horizontally — the single most
  // common chat-UI mobile bug.
  table: ({ children, ...props }) => (
    <div className="-mx-4 my-3 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table {...props} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      {...props}
      className="border border-border bg-primary/[0.04] px-3 py-1.5 text-left font-medium"
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td {...props} className="border border-border px-3 py-1.5 align-top">
      {children}
    </td>
  ),
  code: ({ className, children, ...props }) => (
    <code
      {...props}
      className={`rounded bg-primary/[0.07] px-1 py-0.5 font-geist-mono text-[0.87em] [overflow-wrap:anywhere] ${className ?? ""}`}
    >
      {children}
    </code>
  ),
  // The <pre> router. Fenced code is normally intercepted by the splitter, but
  // it still reaches here (a) for a message rendered as one document (footnotes)
  // and (b) for 4-SPACE INDENTED code blocks, which the splitter leaves inside a
  // text block. Either way, extract the language + text from the child <code>
  // and hand it to the same CodeBlock/Mermaid the fenced path uses, so there is
  // one rendering path and indented code finally gets a real code box.
  pre: ({ children }) => {
    const lang = langOf(children);
    const text = nodeText(children).replace(/\n$/, "");
    if (lang === "mermaid") return <Mermaid code={text} complete />;
    if (lang === "chart") return <ChartBlock spec={text} complete />;
    return <CodeBlock code={text} lang={lang} complete />;
  },
  p: ({ children, ...props }) => (
    <p {...props} className="my-3 break-words leading-[1.7] first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children, className, ...props }) => {
    const task = (className ?? "").includes("contains-task-list");
    return (
      <ul
        {...props}
        className={
          task
            ? "my-2 space-y-1.5 pl-1"
            : "my-2 list-disc space-y-1.5 pl-5"
        }
      >
        {children}
      </ul>
    );
  },
  ol: ({ children, ...props }) => (
    <ol {...props} className="my-2 list-decimal space-y-1.5 pl-5">
      {children}
    </ol>
  ),
  li: ({ children, className, ...props }) => {
    const task = (className ?? "").includes("task-list-item");
    return (
      <li
        {...props}
        className={task ? "flex list-none items-start gap-1.5" : undefined}
      >
        {children}
      </li>
    );
  },
  // Task-list checkbox (remark-gfm emits a disabled <input type=checkbox>).
  input: ({ type, checked, ...props }) =>
    type === "checkbox" ? (
      <input
        {...props}
        type="checkbox"
        checked={!!checked}
        readOnly
        disabled
        className="mt-[0.3em] h-3.5 w-3.5 shrink-0 rounded border-border accent-brand"
      />
    ) : null,
  h1: ({ children, ...props }) => (
    <h1 {...props} className="mb-3 mt-4 text-lg font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 {...props} className="mb-3 mt-4 text-base font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 {...props} className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 {...props} className="mb-1.5 mt-3 text-sm font-medium text-primary/90 first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children, ...props }) => (
    <h5
      {...props}
      className="mb-1 mt-2.5 text-[13px] font-medium text-primary/80 first:mt-0"
    >
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6
      {...props}
      className="mb-1 mt-2.5 text-xs font-medium uppercase tracking-wide text-primary/60 first:mt-0"
    >
      {children}
    </h6>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      {...props}
      className="my-3 rounded-md border-l-2 border-brand/40 bg-primary/[0.03] py-2 pl-3 pr-3 text-primary/70"
    >
      {children}
    </blockquote>
  ),
  sup: ({ children, ...props }) => (
    <sup {...props} className="text-[0.7em] text-brand-ink">
      {children}
    </sup>
  ),
  // GFM footnotes render a trailing <section class="footnotes">; give it a quiet
  // divider so it reads as an apparatus rather than body text.
  section: ({ children, className, ...props }) =>
    (className ?? "").includes("footnotes") ? (
      <section
        {...props}
        className="mt-4 border-t border-border pt-2 text-[13px] text-primary/60"
      >
        {children}
      </section>
    ) : (
      <section {...props} className={className}>
        {children}
      </section>
    ),
  hr: () => <hr className="my-4 border-border" />,
};

/**
 * One block. Memoised on its own source, so completed blocks — whose source is
 * frozen forever by the splitter — never re-render again.
 */
const MarkdownBlock = memo(
  // biome-ignore lint/suspicious/noExplicitAny: rehype plugin tuple typing
  ({ block, rehype }: { block: Block; rehype: any }) => {
    if (block.kind === "code") {
      const body = block.source
        .replace(/^\s*(`{3,}|~{3,}).*\n?/, "")
        .replace(/\n?\s*(`{3,}|~{3,})\s*$/, "");
      if (block.lang === "mermaid") {
        return <Mermaid code={body} complete={block.complete} />;
      }
      if (block.lang === "chart") {
        return <ChartBlock spec={body} complete={block.complete} />;
      }
      return (
        <CodeBlock code={body} lang={block.lang} complete={block.complete} />
      );
    }
    if (block.kind === "table-pending") {
      // Identical line metrics to the eventual <table> rows, so the one-time
      // switch when the |---| delimiter lands does not reflow the column.
      return (
        <pre className="my-3 whitespace-pre-wrap font-geist-mono text-[13px] leading-[1.7] text-primary/70">
          {block.source}
        </pre>
      );
    }
    return (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehype}
        components={components}
      >
        {block.source}
      </ReactMarkdown>
    );
  },
  (a, b) =>
    a.block.source === b.block.source &&
    a.block.complete === b.block.complete &&
    a.block.kind === b.block.kind &&
    // katex loads once; when it does, math-bearing completed blocks re-render.
    a.rehype === b.rehype,
);
MarkdownBlock.displayName = "MarkdownBlock";

function MarkdownImpl({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const blocks = useMemo(
    () => splitBlocks(content, streaming),
    [content, streaming],
  );

  // Pull in katex only when this message contains math, and only the plugin
  // (not the whole first-load bundle). Until it resolves, math renders as raw
  // source; the state flip re-renders it once, formatted.
  // Only `$$…$$` is math now (see REMARK_PLUGINS) — so a single `$` (currency)
  // must NOT pull in the 75KB katex bundle.
  const hasMath = useMemo(() => content.includes("$$"), [content]);
  // biome-ignore lint/suspicious/noExplicitAny: rehype plugin default export
  const [katex, setKatex] = useState<any>(null);
  useEffect(() => {
    if (!hasMath || katex) return;
    let on = true;
    loadKatex().then(
      (plugin) => {
        if (on) setKatex(() => plugin);
      },
      () => {},
    );
    return () => {
      on = false;
    };
  }, [hasMath, katex]);
  // biome-ignore lint/suspicious/noExplicitAny: rehype plugin tuple typing
  const rehype: any = useMemo(
    () => (katex ? [[katex, { throwOnError: false }]] : NO_REHYPE),
    [katex],
  );

  // Footnotes need a whole-document parse (defs and refs live in different
  // blocks). Only a settled message that actually defines one takes this path,
  // so every other message keeps the block-by-block streaming render unchanged.
  const wholeDoc = !streaming && FOOTNOTE_DEF.test(content);

  return (
    <div className="text-[15.5px] text-primary/90">
      {wholeDoc ? (
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={rehype}
          components={components}
        >
          {content}
        </ReactMarkdown>
      ) : (
        blocks.map((block, i) => (
          // Keyed by INDEX deliberately, never by a content hash: blocks are
          // append-only, so the index is stable for every completed block. A
          // hash key would change as the last block grows, unmounting and
          // remounting it — guaranteed flicker and lost scroll position.
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only list; see above
          <MarkdownBlock key={`b${i}`} block={block} rehype={rehype} />
        ))
      )}
    </div>
  );
}

export const Markdown = memo(
  MarkdownImpl,
  (a, b) => a.content === b.content && a.streaming === b.streaming,
);
