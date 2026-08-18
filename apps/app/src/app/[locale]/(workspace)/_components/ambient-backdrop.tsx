/**
 * Atmospheric layer behind the workspace: a faint constellation grid and two
 * drifting auroras in the brand's sky→indigo→purple family.
 *
 * A sibling of components/auth/ambient-backdrop.tsx rather than a reuse of it:
 * that one is dark-only (white/[0.06] overlays) and carries auth-specific status
 * badges, which would float over the transcript here. The technique is the same,
 * the palette is theme-aware.
 *
 * Purely decorative: pointer-events-none so it can never intercept a click meant
 * for the transcript, aria-hidden so it adds nothing for screen readers, and
 * -z-10 so it sits under the rail and the pane without needing a stacking hack
 * (the parent is `isolate`, so this cannot escape the layout).
 *
 * No framer-motion here for the same reason it is absent from the auth backdrop:
 * a 180px blur over a 600px element is already expensive to composite, and
 * driving it from JS repaints every frame for no visual gain.
 */
export function AmbientBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      {/* Constellation grid. currentColor picks up --foreground, so it inverts
          with the theme instead of needing two hardcoded rgba values. */}
      <div
        className="absolute inset-0 text-foreground opacity-[0.04] dark:opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(circle, currentColor 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="absolute -left-40 -top-48 h-[620px] w-[620px] rounded-full bg-gradient-to-br from-sky-500/20 via-indigo-600/15 to-transparent blur-[170px] dark:from-sky-500/25 dark:via-indigo-600/20" />
      <div className="absolute -bottom-48 -right-40 h-[560px] w-[560px] rounded-full bg-gradient-to-tr from-purple-500/15 via-indigo-600/15 to-transparent blur-[180px] dark:from-purple-500/25 dark:via-indigo-600/20" />
    </div>
  );
}
