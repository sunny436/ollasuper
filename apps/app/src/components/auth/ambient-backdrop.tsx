import { Brain, Cpu } from "lucide-react";

/**
 * Atmospheric layer behind the auth card: two drifting auroras, a constellation
 * grid, and two floating status badges.
 *
 * Entirely decorative and non-interactive — `pointer-events-none` throughout, so
 * it can never intercept a click meant for the form, and `aria-hidden` so it adds
 * nothing for screen readers. Rendered by the panel, which owns the page ground.
 *
 * The auroras animate with Tailwind's `animate-pulse` rather than framer-motion:
 * a 180px blur over a 700px element is already expensive to composite, and
 * driving it from JS would repaint on every frame for no visual gain.
 */
export function AmbientBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Constellation grid */}
      <div
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(255,255,255,0.35) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      {/* Auroras */}
      <div className="absolute -top-40 -left-32 h-[620px] w-[620px] rounded-full bg-gradient-to-br from-cyan-500/30 via-purple-600/25 to-transparent blur-[180px]" />
      <div className="absolute -right-32 -bottom-40 h-[560px] w-[560px] rounded-full bg-gradient-to-tr from-pink-500/25 via-purple-600/25 to-transparent blur-[190px]" />

      {/* Floating status badges */}
      <div className="absolute top-[14%] left-[6%] hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-[11px] text-white/70 backdrop-blur-md lg:flex">
        <Cpu className="h-3.5 w-3.5 text-cyan-300" />
        <span className="font-medium">Olla Core v3.4 Active</span>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
      </div>
      <div className="absolute right-[7%] bottom-[16%] hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-[11px] text-white/70 backdrop-blur-md lg:flex">
        <Brain className="h-3.5 w-3.5 text-fuchsia-300" />
        <span className="font-medium">100K Multimodal Context</span>
      </div>
    </div>
  );
}
