"use client";

/**
 * Scoped to the Library so a crash keeps the workspace shell and the rail
 * alive (mirrors projects/error.tsx). No console output: e2e asserts zero
 * console errors, and the global handler already reports it.
 */
export default function LibraryError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-medium text-primary">Something went wrong in your Library</h2>
        <p className="mt-2 text-sm text-primary/60">Your files are safe — this was a display error.</p>
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
