"use client";

import { ERROR } from "../_lib/copy";

/**
 * "12 tools · 3 resources · 2 prompts" — or "Capabilities unavailable".
 *
 * NEVER BOTH, AND NEVER A FABRICATED ZERO. This is §44/§101 in one component.
 * `toolCount` is `null` when discovery did not complete, and the difference
 * between that and `0` is the whole point: `0 tools` asserts that the server
 * offers nothing, which is a claim nobody made. The one line of code that would
 * destroy this is `count ?? 0`, so counts arrive pre-resolved as `number | null`
 * from `dto.ts` and this component has no default to apply.
 *
 * RESOURCE AND PROMPT COUNTS ARE OPTIONAL because they are lazy: the detail page
 * passes them once their sections have loaded, and the summary simply shows
 * fewer facts until then rather than showing wrong ones.
 */
export function CapabilitySummary({
  toolCount,
  resourceCount,
  promptCount,
  onRetry,
}: {
  toolCount: number | null;
  resourceCount?: number | null;
  promptCount?: number | null;
  onRetry?: () => void;
}) {
  if (toolCount === null) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-primary/55">{ERROR.capabilities.body}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs font-medium text-brand-ink underline"
          >
            {ERROR.capabilities.action}
          </button>
        )}
      </div>
    );
  }

  const parts: string[] = [plural(toolCount, "tool")];
  if (typeof resourceCount === "number") {
    parts.push(plural(resourceCount, "resource"));
  }
  if (typeof promptCount === "number") {
    parts.push(plural(promptCount, "prompt"));
  }

  return (
    <p className="text-xs text-primary/55">{parts.join(" · ")}</p>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
