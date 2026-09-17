/**
 * Atmospheric layer behind the Settings shell: a faint constellation grid and
 * two drifting auroras in the brand's sky→indigo→purple family.
 *
 * A sibling copy of (dashboard)/_components/ambient-backdrop.tsx (same technique,
 * theme-aware palette), kept local so this route group stays self-contained —
 * matching the existing convention where auth, workspace and dashboard each own
 * a copy.
 *
 * Purely decorative: pointer-events-none so it can never intercept a click,
 * aria-hidden so it adds nothing for screen readers, and -z-10 so it sits under
 * the shell without a stacking hack (the parent is `isolate`, so it cannot
 * escape the layout).
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

      <div className="glow-orb absolute -left-40 -top-48 h-[620px] w-[620px] rounded-full bg-gradient-to-br from-sky-500/20 via-indigo-600/15 to-transparent blur-[170px] [--glow-from:rgb(14_165_233/0.14)] [--glow-via:rgb(79_70_229/0.09)] dark:from-sky-500/25 dark:via-indigo-600/20 dark:[--glow-from:rgb(14_165_233/0.17)] dark:[--glow-via:rgb(79_70_229/0.12)]" />
      <div className="glow-orb absolute -bottom-48 -right-40 h-[560px] w-[560px] rounded-full bg-gradient-to-tr from-purple-500/15 via-indigo-600/15 to-transparent blur-[180px] [--glow-from:rgb(168_85_247/0.1)] [--glow-via:rgb(79_70_229/0.09)] dark:from-purple-500/25 dark:via-indigo-600/20 dark:[--glow-from:rgb(168_85_247/0.17)] dark:[--glow-via:rgb(79_70_229/0.12)]" />
    </div>
  );
}
