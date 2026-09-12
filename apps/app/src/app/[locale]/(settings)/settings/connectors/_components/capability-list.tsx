"use client";

import { ShieldAlert } from "lucide-react";

/**
 * Tools, resources and prompts as plain lists.
 *
 * EVERY STRING IS A TEXT NODE. Tool names, resource descriptions and prompt
 * descriptions are authored by a third-party server, and §73/§74/§75 all reduce
 * to one rule: they are React children, never HTML. That is safety by
 * construction in this codebase rather than by filtering — `rehype-raw` is
 * deliberately not installed and `dangerouslySetInnerHTML` appears in exactly
 * one audited place (mermaid), so there is no path here through which markup
 * could be parsed into nodes even if a server sent some.
 *
 * NO JSON SCHEMAS (§26). A tool's input schema is the model's business. Showing
 * it would put protocol detail in front of someone trying to decide whether an
 * app is useful, and it is the single largest thing a hostile server controls.
 *
 * `dropped` IS RENDERED WHEN NON-ZERO (§101). The backend counts what it refused
 * — over the cap, oversized schema, malformed — and hiding that would let a list
 * of twelve silently mean twelve of nine hundred.
 */

export function CapabilityList({
  title,
  items,
  loading,
  error,
  dropped = 0,
  empty,
  onRetry,
  renderItem,
}: {
  title: string;
  items: unknown[];
  loading: boolean;
  error: string | null;
  dropped?: number;
  empty: { title: string; body: string };
  onRetry?: () => void;
  renderItem: (item: never, index: number) => React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-primary/70">{title}</h3>

      {loading && (
        <div
          className="h-16 animate-pulse rounded-lg border border-border bg-card/40"
          aria-busy="true"
          aria-label={`Loading ${title.toLowerCase()}`}
        />
      )}

      {!loading && error && (
        // A failed listing, not an empty one. Different words, different action.
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <p className="text-xs text-primary/60">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1.5 text-xs font-medium text-brand-ink underline"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-4">
          <p className="text-xs font-medium text-primary/60">{empty.title}</p>
          <p className="mt-0.5 text-[11px] text-primary/45">{empty.body}</p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {items.map((item, i) => renderItem(item as never, i))}
        </ul>
      )}

      {dropped > 0 && (
        <p className="text-[11px] text-primary/45">
          {dropped} more were not shown because this app advertised more than
          OllaSuper accepts.
        </p>
      )}
    </section>
  );
}

/** One row. `meta` carries a type or a URI; `warn` marks something the user
 *  should notice without the row shouting. */
export function CapabilityRow({
  name,
  description,
  meta,
  warn,
  action,
}: {
  name: string;
  description?: string;
  meta?: string;
  warn?: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card/40 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-xs font-medium text-primary/80">
            {name}
          </span>
          {meta && (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-primary/45">
              {meta}
            </span>
          )}
          {warn && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <ShieldAlert aria-hidden className="h-3 w-3" />
              {warn}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-primary/50">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}
