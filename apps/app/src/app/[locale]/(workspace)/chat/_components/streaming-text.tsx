"use client";

import { LazyMarkdown } from "./lazy-markdown";
import { TypingIndicator } from "./typing-indicator";

/**
 * The body of an assistant turn, streaming or settled.
 *
 * Deliberately PRESENTATIONAL: it receives text that has already been through
 * the reveal buffer rather than running one itself. The reveal lives in
 * MessageList (see use-reveal.ts) because two things need the same value — the
 * text rendered here, and useStickToBottom's dependency list. If the hook ran
 * down here the scroller would be keyed on the raw stream while the DOM showed
 * the lagging slice, so auto-scroll would run ahead of the visible text.
 *
 * The caret is the one already used across the app (animate-caret-blink,
 * keyframes in packages/ui/tailwind.config.ts), not the prototype's gradient
 * motion.span: it costs no JS, composites on the GPU, and already honours
 * reduced motion.
 */
export function StreamingText({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  // Nothing revealed yet — the request is in flight, or the first characters
  // are still landing. Showing an empty bubble here reads as a hang.
  if (isStreaming && !text) return <TypingIndicator />;

  return (
    <div
      // polite + non-atomic so a screen reader announces increments as they
      // stream instead of re-reading the whole message per token.
      aria-live={isStreaming ? "polite" : "off"}
      aria-atomic="false"
      aria-busy={isStreaming}
    >
      <LazyMarkdown content={text} streaming={isStreaming} />
      {isStreaming && (
        <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-brand animate-caret-blink motion-reduce:animate-none" />
      )}
    </div>
  );
}
