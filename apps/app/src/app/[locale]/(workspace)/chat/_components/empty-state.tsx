"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { useAmbience } from "@/lib/ambience/ambience-provider";
import { useCachedUser } from "../_hooks/use-cached-user";

/**
 * The greeting, revealed by a pure-CSS gradient sweep (`.greeting-sweep` in
 * globals.css): a soft mask wipes the text in left→right while an
 * indigo→magenta→rose beam rides the reveal edge, then every letter settles to
 * the ambience-adaptive foreground. The settle colour is passed in as
 * `--greeting-ink` so the CSS stays ambience-adaptive (legible across
 * daylight/amber/midnight) without a hardcoded hex — the old fixed sky→indigo
 * gradient clashed on amber and washed out on daylight. Runs once on mount.
 * Reduced motion and the no-`background-clip` fallback both resolve to solid,
 * fully-visible text (see the @supports / @media guards in globals.css).
 * `inline-block` shrink-wraps the glyph run so the mask/beam geometry maps to
 * the text, not the full-width centred line box (it still centres via the
 * parent's `text-center`). No transform / 3D context, so descenders are never
 * clipped.
 */
function AnimatedHeadline({ text }: { text: string }) {
  const { colors } = useAmbience();
  return (
    <h1
      // Wraps (balanced) below sm: nowrap clipped long greetings — "What would you like
      // to accomplish?", or any greeting carrying a long name — off a 375 px screen.
      className="greeting-sweep inline-block max-w-full whitespace-normal pb-3 text-2xl font-medium leading-[1.35] [text-wrap:balance] sm:whitespace-nowrap sm:text-4xl"
      style={{ "--greeting-ink": colors.text } as CSSProperties}
    >
      {text}
    </h1>
  );
}

type Bucket = "morning" | "afternoon" | "evening" | "night";

// Time-of-day greetings (5 per bucket), name-aware and readable when the name is
// not yet known. The current bucket's five are mixed into the pool alongside the
// time-agnostic GENERIC list below, and one is picked at random per new-chat load.
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

// Time-agnostic greetings — shown at any hour, mixed into the pool alongside the
// current bucket's time greetings above. A handful fold the name in; the rest read
// the same for everyone. Kept short-to-medium so they stay on one line.
const GENERIC: ((n: string) => string)[] = [
  // Direct / helpful
  () => "What can I help you with?",
  () => "What are you working on?",
  () => "What's on your mind?",
  (n) => (n ? `How can I help today, ${n}?` : "How can I help today?"),
  (n) => (n ? `Where should we start, ${n}?` : "Where should we start?"),
  () => "What would you like to explore?",
  () => "What can we work on together?",
  () => "What would you like to accomplish?",
  () => "What can I help you figure out?",
  (n) => (n ? `What's on your agenda today, ${n}?` : "What's on your agenda today?"),
  // Friendly / conversational
  () => "Got something on your mind?",
  () => "What would you like to know?",
  () => "Need a hand with something?",
  () => "Tell me what you're thinking.",
  (n) => (n ? `What can we tackle today, ${n}?` : "What can we tackle today?"),
  () => "What would you like to do?",
  () => "What should we dive into?",
  () => "Have a question? Ask away.",
  (n) => (n ? `Ready to get started, ${n}?` : "Ready to get started?"),
  // Modern / product
  () => "Turn your ideas into action.",
  () => "Let's make something happen.",
  () => "Bring your next idea to life.",
  () => "Think. Ask. Create.",
  () => "Your next idea starts here.",
  () => "Let's build something great.",
  () => "Explore. Create. Get things done.",
  () => "Start with an idea.",
  () => "Your AI workspace starts here.",
  (n) => (n ? `What will we build today, ${n}?` : "What will we build today?"),
];

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
  // Pick ONE greeting at random, ONCE, client-side (Math.random + local time in an
  // effect → no hydration mismatch; every e2e asserts zero console errors). The
  // pool is the current time bucket's five greetings plus the time-agnostic GENERIC
  // list, so a load may land on a personalised "Good evening, Sunny" or a neutral
  // "What's on your mind?". The chosen fn is stored and called with the name during
  // render, so the name fills in when useCachedUser resolves without re-picking.
  const [greet, setGreet] = useState<((n: string) => string) | null>(null);
  useEffect(() => {
    const bucket = bucketFor(new Date().getHours());
    const pool = [...GREETINGS[bucket], ...GENERIC];
    const fn = pool[Math.floor(Math.random() * pool.length)] ?? null;
    setGreet(() => fn);
  }, []);

  const firstName = user?.name?.split(" ")[0] ?? "";
  const headline = greet ? greet(firstName) : "";

  return (
    <div className="w-full text-center">
      {/* Reserve the line height (overflow-visible so descenders are never
          clipped) so the pill below does not jump when the greeting resolves. */}
      <div className="min-h-[3.25rem] overflow-visible sm:min-h-[4rem]">
        {headline && <AnimatedHeadline text={headline} />}
      </div>
    </div>
  );
}
