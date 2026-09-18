"use client";

import { useEffect } from "react";

/**
 * Scoped to the projects subtree so a crash keeps the workspace shell and the
 * conversation rail alive. Mirrors chat/error.tsx — without a boundary here an
 * uncaught query error escapes to [locale]/error.tsx and takes down the whole
 * workspace, rail included.
 */
export default function ProjectsError({
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
          Something went wrong in projects
        </h2>
        <p className="mt-2 text-sm text-primary/60">
          Your projects and chats are safe — this was a display error.
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
