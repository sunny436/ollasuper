"use client";

import { IntelligenceCoreFallback } from "@/components/auth/intelligence-core-fallback";
import dynamic from "next/dynamic";

/**
 * The brand orb — the rail's mark, and the avatar on a live assistant turn.
 *
 * This file is only a loader. The renderer itself is the existing
 * components/auth/intelligence-core.tsx — reused rather than reimplemented,
 * because that one already handles the things a fresh copy gets wrong:
 * ResizeObserver-driven sizing (setSize(w,h,false) alone leaves the canvas at
 * its intrinsic size, which is what made an earlier orb sit off-centre and
 * clip), forceContextLoss() on unmount (browsers cap live WebGL contexts, so
 * leaking one per remount silently stops rendering), StrictMode-safe cleanup,
 * and prefers-reduced-motion.
 *
 * ssr:false is what keeps three.js (~150kB gz) in its own chunk and out of the
 * first load of /chat — which, since / redirects here, is the app's landing
 * route. It is legal only because this file is a client component.
 *
 * EVERY INSTANCE IS A LIVE WebGL CONTEXT, and browsers cap those at roughly 16
 * before they start dropping the oldest. That is why message-list.tsx renders
 * one only next to the message that is currently streaming, and settled turns
 * keep a flat glyph instead.
 */
const Core = dynamic(
  () =>
    import("@/components/auth/intelligence-core").then(
      (m) => m.IntelligenceCore,
    ),
  {
    ssr: false,
    loading: () => <IntelligenceCoreFallback className="rounded-[14px]" />,
  },
);

export function IntelligenceCore({
  /** Tailwind size utilities. The rail uses the default; a turn avatar is smaller. */
  className = "h-9 w-9",
}: {
  className?: string;
}) {
  return (
    <div
      className={`relative shrink-0 rounded-2xl bg-gradient-to-tr from-sky-400 via-indigo-500 to-purple-500 p-[1.5px] shadow-[0_0_20px_hsl(var(--brand)/0.35)] ${className}`}
    >
      <div className="h-full w-full overflow-hidden rounded-[14px] bg-card">
        <Core className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[14px]" />
      </div>
    </div>
  );
}
