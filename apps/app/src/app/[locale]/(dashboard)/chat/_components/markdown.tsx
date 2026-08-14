"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { type Block, splitBlocks } from "../_lib/split-blocks";
import { safeImageUrl, safeUrl } from "../_lib/url-guard";
import { CodeBlock } from "./code-block";

/**
 * NOTE ON XSS: `rehype-raw` is deliberately absent from this plugin list.
 * Without it react-markdown never parses raw HTML into nodes, so model output
 * like <img src=x onerror=alert(1)> renders as literal text. That makes this
 * pipeline safe by construction, which is why no sanitiser is present.
 *
 * If anyone ever adds rehype-raw here, rehype-sanitize becomes MANDATORY.
 */
const REMARK_PLUGINS = [remarkGfm];

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
    const safe = safeImageUrl(typeof src === "string" ? src : "");
    if (!safe) return null;
    return (
      // biome-ignore lint/a11y/useAltText: alt is forwarded from the markdown
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
  // Fenced code is handled by the splitter, so anything reaching `pre` here is
  // an edge case; render it plainly rather than nesting another <pre>.
  pre: ({ children }) => <>{children}</>,
  p: ({ children, ...props }) => (
    <p {...props} className="my-2 break-words leading-[1.7] first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul {...props} className="my-2 list-disc space-y-1 pl-5">
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol {...props} className="my-2 list-decimal space-y-1 pl-5">
      {children}
    </ol>
  ),
  h1: ({ children, ...props }) => (
    <h1 {...props} className="mb-2 mt-4 text-lg font-medium first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 {...props} className="mb-2 mt-4 text-base font-medium first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 {...props} className="mb-1.5 mt-3 text-sm font-medium first:mt-0">
      {children}
    </h3>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      {...props}
      className="my-3 border-l-2 border-brand/40 pl-3 text-primary/70"
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
};

/**
 * One block. Memoised on its own source, so completed blocks — whose source is
 * frozen forever by the splitter — never re-render again.
 */
const MarkdownBlock = memo(
  ({ block }: { block: Block }) => {
    if (block.kind === "code") {
      const body = block.source
        .replace(/^\s*(`{3,}|~{3,}).*\n?/, "")
        .replace(/\n?\s*(`{3,}|~{3,})\s*$/, "");
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
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {block.source}
      </ReactMarkdown>
    );
  },
  (a, b) =>
    a.block.source === b.block.source &&
    a.block.complete === b.block.complete &&
    a.block.kind === b.block.kind,
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
  return (
    <div className="text-[15px] text-primary/90">
      {blocks.map((block, i) => (
        // Keyed by INDEX deliberately, never by a content hash: blocks are
        // append-only, so the index is stable for every completed block. A
        // hash key would change as the last block grows, unmounting and
        // remounting it — guaranteed flicker and lost scroll position.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list; see above
        <MarkdownBlock key={`b${i}`} block={block} />
      ))}
    </div>
  );
}

export const Markdown = memo(
  MarkdownImpl,
  (a, b) => a.content === b.content && a.streaming === b.streaming,
);
