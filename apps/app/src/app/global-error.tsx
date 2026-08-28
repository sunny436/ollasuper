"use client";

import NextError from "next/error";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    // Load Sentry ONLY when a DSN is configured, and only on an actual error, so
    // the ~5 kB client never rides a common chunk on a DSN-free deployment. The
    // DSN is a build-time NEXT_PUBLIC_ inline, so with none set the dynamic import
    // is unreachable and never fetched.
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    void import("@sentry/nextjs").then((Sentry) =>
      Sentry.captureException(error),
    );
  }, [error]);

  return <NextError statusCode={0} />;
}
