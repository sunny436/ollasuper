"use client";

import { ChevronDown } from "lucide-react";

/**
 * Kept mounted and hidden with opacity so the transition actually runs;
 * unmounting would make it pop.
 */
export function ScrollToBottom({
  visible,
  hasNew,
  onClick,
}: {
  visible: boolean;
  hasNew: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Scroll to latest message"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={`absolute bottom-[calc(100%+0.75rem)] left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-primary/80 shadow-md transition-opacity duration-150 ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      {hasNew && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
      <ChevronDown className="h-3.5 w-3.5" />
      {hasNew ? "New message" : "Latest"}
    </button>
  );
}
