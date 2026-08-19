"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useCachedUser } from "../_hooks/use-cached-user";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/**
 * The greeting, revealed character by character on a gradient — the signature
 * Gemini landing motion. Each glyph lifts and un-rotates into place on a
 * staggered spring, then settles to `transform: none` so no residual 3D context
 * clips the descenders (the 'g'/'y' tails). Reduced-motion renders final state.
 */
function AnimatedHeadline({ text }: { text: string }) {
  const reduced = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(false);
  // The stagger plays exactly ONCE. A later text change (name arriving after the
  // greeting) snaps to the final state rather than re-animating.
  const animatedOnce = useRef(false);

  useEffect(() => {
    if (!text || animatedOnce.current) return;
    animatedOnce.current = true;
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, [text]);

  const settled = revealed || animatedOnce.current;
  const chars = useMemo(() => Array.from(text), [text]);

  return (
    <h1 className="pb-3 text-4xl font-medium leading-[1.35] sm:text-5xl">
      {chars.map((char, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length glyph run
          key={i}
          className="inline-block bg-gradient-to-br from-sky-500 via-indigo-500 to-purple-500 bg-clip-text text-transparent dark:from-sky-300 dark:via-indigo-300 dark:to-fuchsia-300"
          style={
            reduced
              ? undefined
              : {
                  opacity: settled ? 1 : 0,
                  // `none` once settled — a lingering rotateX(0) keeps a 3D
                  // rendering context that clips the glyph box and eats the
                  // descenders.
                  transform: settled ? "none" : "translateY(20px) rotateX(-20deg)",
                  transition: `opacity 0.5s ease, transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) ${0.06 + i * 0.03}s`,
                }
          }
        >
          {char === " " ? " " : char}
        </span>
      ))}
    </h1>
  );
}

type Bucket = "morning" | "afternoon" | "evening" | "night";

// 20 greetings (5 per time bucket), name-aware and readable when the name is not
// yet known. One is picked at random per new-chat load.
const GREETINGS: Record<Bucket, ((n: string) => string)[]> = {
  morning: [
    (n) => (n ? `Good morning, ${n}` : "Good morning"),
    (n) => (n ? `Rise and shine, ${n}` : "Rise and shine"),
    (n) => (n ? `Morning, ${n}` : "Morning"),
    (n) => (n ? `Top of the morning, ${n}` : "Top of the morning"),
    (n) => (n ? `A fresh start, ${n}` : "A fresh start"),
  ],
  afternoon: [
    (n) => (n ? `Good afternoon, ${n}` : "Good afternoon"),
    (n) => (n ? `Afternoon, ${n}` : "Afternoon"),
    (n) => (n ? `Hope your day's going well, ${n}` : "Hope your day's going well"),
    (n) => (n ? `Back at it, ${n}?` : "Back at it?"),
    (n) => (n ? `Good to see you, ${n}` : "Good to see you"),
  ],
  evening: [
    (n) => (n ? `Good evening, ${n}` : "Good evening"),
    (n) => (n ? `Evening, ${n}` : "Evening"),
    (n) => (n ? `Winding down, ${n}?` : "Winding down?"),
    (n) => (n ? `Welcome back, ${n}` : "Welcome back"),
    (n) => (n ? `How was your day, ${n}?` : "How was your day?"),
  ],
  night: [
    (n) => (n ? `Working late, ${n}?` : "Working late?"),
    (n) => (n ? `Burning the midnight oil, ${n}?` : "Burning the midnight oil?"),
    (n) => (n ? `Still up, ${n}?` : "Still up?"),
    (n) => (n ? `Late night, ${n}?` : "Late night?"),
    (n) => (n ? `The quiet hours, ${n}` : "The quiet hours"),
  ],
};

function bucketFor(hour: number): Bucket {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/**
 * The empty new-chat hero: just the personalised gradient greeting. The subtitle
 * and the suggestion chips were removed for the minimal Gemini look — only the
 * greeting sits above the composer now.
 */
export function EmptyHero() {
  const user = useCachedUser();
  // Pick the time bucket + a random greeting ONCE, client-side (Math.random and
  // local time in an effect → no hydration mismatch; every e2e asserts zero
  // console errors). The name is folded in during render below, so it fills in
  // when useCachedUser resolves without changing which greeting was chosen.
  const [pick, setPick] = useState<{ bucket: Bucket; index: number } | null>(null);
  useEffect(() => {
    const bucket = bucketFor(new Date().getHours());
    const index = Math.floor(Math.random() * GREETINGS[bucket].length);
    setPick({ bucket, index });
  }, []);

  const firstName = user?.name?.split(" ")[0] ?? "";
  const headline = pick ? (GREETINGS[pick.bucket][pick.index]?.(firstName) ?? "") : "";

  return (
    <div className="w-full text-center">
      {/* Reserve the line height (overflow-visible so descenders are never
          clipped) so the pill below does not jump when the greeting resolves. */}
      <div className="min-h-[4.5rem] overflow-visible sm:min-h-[5.25rem]">
        {headline && <AnimatedHeadline text={headline} />}
      </div>
    </div>
  );
}
