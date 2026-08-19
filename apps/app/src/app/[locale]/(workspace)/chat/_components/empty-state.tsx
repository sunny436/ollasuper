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

/**
 * The empty new-chat hero: just the personalised gradient greeting. The subtitle
 * and the suggestion chips were removed for the minimal Gemini look — only the
 * greeting sits above the composer now.
 */
export function EmptyHero() {
  const [greeting, setGreeting] = useState("");
  const user = useCachedUser();

  // Computed in an effect, never during render: a server-rendered time of day
  // can differ from the client's, which is a hydration mismatch, which React
  // reports via console.error — and every e2e script asserts zero of those.
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, []);

  const firstName = user?.name?.split(" ")[0] ?? "";
  const headline = greeting ? `${greeting}${firstName ? `, ${firstName}` : ""}` : "";

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
