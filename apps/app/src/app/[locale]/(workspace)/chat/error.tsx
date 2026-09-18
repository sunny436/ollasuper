"use client";

import { useEffect } from "react";

/**
 * Scoped to the chat subtree so a crash keeps the dashboard shell and the
 * conversation sidebar alive. Mirrors [locale]/error.tsx.
 */
export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Reported to Sentry by the global handler; nothing to do here but keep
    // the message off the console (e2e asserts zero console errors).
  }, [error]);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-medium text-primary">
          Something went wrong in chat
        </h2>
        <p className="mt-2 text-sm text-primary/60">
          Your conversations are safe — this was a display error.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition hover:opacity-90"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
