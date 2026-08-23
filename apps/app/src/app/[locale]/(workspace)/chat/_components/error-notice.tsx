"use client";

import { RotateCcw } from "lucide-react";
import { errorCopy } from "../_lib/agent-events";
import { Disclosure } from "./agent-primitives";

/**
 * User-facing error for a failed turn. Maps the backend `errorCode` to friendly
 * copy (agent-events.ERROR_COPY), keeps the raw technical message behind a
 * disclosure, and hides Retry for non-retryable failures. Never surfaces stack
 * traces / URLs / secrets — the backend already caps `error` to 500 chars and
 * the copy map replaces it for known codes.
 */
export function ErrorNotice({
  code,
  message,
  onRetry,
}: {
  code?: string | null;
  message?: string | null;
  onRetry: () => void;
}) {
  const { message: friendly, retryable } = errorCopy(code, message);
  // Only show the raw details disclosure when we actually replaced the message
  // with mapped copy (i.e. a known code) and the raw text adds information.
  const showRaw = Boolean(code && message && message !== friendly);

  return (
    <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p className="text-primary/80">{friendly}</p>
      {showRaw && (
        <Disclosure
          className="mt-1"
          summary={
            <span className="text-[11px] text-primary/40 hover:text-primary/60">
              Details
            </span>
          }
        >
          <p className="text-[12px] text-primary/50 [overflow-wrap:anywhere]">
            {message}
          </p>
        </Disclosure>
      )}
      {retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 rounded text-xs text-brand-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <RotateCcw className="h-3 w-3" aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}
