"use client";

import { IntelligenceCoreFallback } from "@/components/auth/intelligence-core-fallback";
import dynamic from "next/dynamic";

/**
 * The brand orb for the Settings sidebar header — the same mark the chat rail
 * uses, so Settings reads as the same product.
 *
 * A settings-local loader (mirrors chat/_components/intelligence-core.tsx) so
 * this route group stays self-contained, while the RENDERER itself is the one
 * shared components/auth/intelligence-core.tsx — never reimplemented. It is
 * loaded only via next/dynamic({ssr:false}) so three.js (~150kB gz) stays in
 * its own chunk. EVERY INSTANCE IS A LIVE WebGL CONTEXT (browsers cap those at
 * ~16), so mount this EXACTLY ONCE here in the sidebar.
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

export function SettingsOrb({ className = "h-9 w-9" }: { className?: string }) {
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
