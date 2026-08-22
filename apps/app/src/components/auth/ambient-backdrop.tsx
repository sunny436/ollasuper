/**
 * Atmospheric layer behind the auth shell: two drifting auroras and a faint
 * constellation grid — deliberately understated so it reads as subtle edge
 * texture under the near-full-page shell.
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
      {/* Faint constellation grid */}
      <div
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(255,255,255,0.35) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      {/* Auroras — toned down for subtle edge texture under the full-page shell. */}
      <div className="absolute -top-40 -left-32 h-[620px] w-[620px] rounded-full bg-gradient-to-br from-cyan-500/20 via-purple-600/15 to-transparent blur-[180px]" />
      <div className="absolute -right-32 -bottom-40 h-[560px] w-[560px] rounded-full bg-gradient-to-tr from-pink-500/15 via-purple-600/15 to-transparent blur-[190px]" />
    </div>
  );
}
