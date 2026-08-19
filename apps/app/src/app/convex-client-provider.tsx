"use client";

import { env } from "@/env.mjs";
import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

// verbose logs every websocket frame in BOTH directions
// (convex/browser/sync/web_socket_manager.js:97,131), each line allocating a
// fresh new Date().toISOString() — i.e. a console write per token push during
// streaming. Useful in development, pure overhead in production.
const convex = new ConvexReactClient(env.NEXT_PUBLIC_CONVEX_URL, {
  verbose: process.env.NODE_ENV !== "production",
});

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
