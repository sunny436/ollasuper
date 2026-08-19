"use client";

import { useEffect, useRef, useState } from "react";
import { useAmbience } from "@/lib/ambience/ambience-provider";
import { useParallax } from "../_hooks/use-parallax";
import { makeStars, phaseWeights, type Star } from "../_lib/ambience";

/**
 * The empty-landing ambient layer: three crossfading blurred glow orbs (with
 * mouse parallax) and a starfield that fades in for the dark phase.
 *
 * `-z-10` (NOT z-0): a z-0 positioned layer paints above the in-flow header and
 * would cover its text. At -z-10 it sits behind the header, whose
 * bg-card/50 backdrop-blur-xl turns the orbs into glass. The ChatLayout root is
 * `isolate` so this negative-z stays contained. Rendered only when the composer
 * is centred (new-chat landing); unmounts on first send.
 */
export function AmbienceBackdrop() {
  const { intensity } = useAmbience();
  const orbRef = useRef<HTMLDivElement>(null);
  useParallax(orbRef, { enabled: true, maxPx: 22 });

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <GlowOrbs orbRef={orbRef} weights={phaseWeights(intensity)} />
      <Starfield intensity={intensity} />
    </div>
  );
}

function GlowOrbs({
  orbRef,
  weights,
}: {
  orbRef: React.RefObject<HTMLDivElement>;
  weights: ReturnType<typeof phaseWeights>;
}) {
  return (
    <div ref={orbRef} className="absolute inset-0" style={{ willChange: "transform" }}>
      {/* Daylight — sky blue, upper-left */}
      <div
        className="absolute rounded-full blur-[140px]"
        style={{
          top: "-10%",
          left: "-5%",
          width: "70vw",
          height: "70vh",
          background:
            "radial-gradient(circle, rgba(186,220,255,0.9) 0%, rgba(186,220,255,0) 70%)",
          opacity: weights.day,
        }}
      />
      {/* Amber — honey, center-right */}
      <div
        className="absolute rounded-full blur-[140px]"
        style={{
          top: "8%",
          right: "-10%",
          width: "75vw",
          height: "75vh",
          background:
            "radial-gradient(circle, rgba(253,224,184,0.85) 0%, rgba(251,191,36,0.12) 45%, transparent 70%)",
          opacity: weights.dusk,
        }}
      />
      {/* Midnight — indigo, lower */}
      <div
        className="absolute rounded-full blur-[140px]"
        style={{
          bottom: "-15%",
          left: "18%",
          width: "80vw",
          height: "70vh",
          background:
            "radial-gradient(circle, rgba(79,70,229,0.35) 0%, rgba(56,189,248,0.14) 45%, transparent 70%)",
          opacity: weights.night,
        }}
      />
    </div>
  );
}

function Starfield({ intensity }: { intensity: number }) {
  // Positions use Math.random → seed in an effect, empty on first render
  // (matches SSR), so no hydration mismatch.
  const [stars, setStars] = useState<Star[]>([]);
  useEffect(() => {
    setStars(makeStars(38));
  }, []);

  const opacity = Math.max(0, (intensity - 60) / 40);
  if (opacity <= 0) return null;

  return (
    <div
      className="absolute inset-0 transition-opacity duration-500"
      style={{ opacity }}
    >
      {stars.map((s, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, effect-seeded list
          key={i}
          className={`absolute rounded-full bg-white ${s.kind === "ping" ? "animate-ping" : "animate-pulse"} motion-reduce:animate-none`}
          style={{
            top: `${s.top}%`,
            left: `${s.left}%`,
            width: s.size,
            height: s.size,
            animationDelay: `${s.delay}s`,
            animationDuration: s.kind === "ping" ? "3.5s" : "4.5s",
          }}
        />
      ))}
    </div>
  );
}
