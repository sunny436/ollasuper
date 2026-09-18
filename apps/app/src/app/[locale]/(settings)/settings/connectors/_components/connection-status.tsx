"use client";

import { STATE } from "../_lib/copy";
import type { DisplayState } from "../_lib/state";

/**
 * THE status renderer. Catalogue, detail and connection list all use this one.
 *
 * §88 asks for one consistent status component so the same word cannot mean two
 * things in two places. The stronger reason is that status here is derived from
 * three backend fields by `deriveState`, and a second renderer would eventually
 * grow a second opinion about what "connected" means.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL (§123). Every state carries a glyph AND its
 * label in text. The glyph is `aria-hidden` because the label already says it —
 * announcing "circle Connected" helps nobody — and the tone maps to a design
 * token, never to a literal colour, so dark mode and the workspace palette both
 * follow automatically (§141).
 */

const TONE: Record<string, string> = {
  neutral: "text-primary/65",
  good: "text-success dark:text-success",
  warn: "text-warning dark:text-warning",
  bad: "text-destructive dark:text-destructive",
};

export function ConnectionStatus({
  state,
  size = "sm",
}: {
  state: DisplayState;
  size?: "sm" | "md";
}) {
  const s = STATE[state];
  const tone = TONE[s.tone] ?? TONE.neutral;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${
        size === "md" ? "text-sm" : "text-[11px]"
      } font-medium ${tone}`}
    >
      <span aria-hidden className="leading-none">
        {s.glyph}
      </span>
      {s.label}
    </span>
  );
}

/** The one-sentence explanation under a status. Separated so a dense card can
 *  show the status alone while the detail page shows both. */
export function ConnectionHint({ state }: { state: DisplayState }) {
  return <p className="text-xs text-primary/65">{STATE[state].hint}</p>;
}
