"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useComposer } from "../_hooks/use-composer";
import { useSendMessage } from "../_hooks/use-send-message";

/**
 * A flat, curated set of starter prompts, shown as Gemini-style suggestion
 * chips below the composer. (The old Write/Code/Visuals mode tabs were dropped
 * with the Gemini restyle — Gemini has no such switcher.) "Summarise a document"
 * is kept as the first chip; the chat e2e asserts it renders.
 */
const SUGGESTIONS: { title: string; hint: string; prompt: string }[] = [
  {
    title: "Summarise a document",
    hint: "Paste it and get the key points",
    prompt: "Summarise the following document into five key points:\n\n",
  },
  {
    title: "Write code",
    hint: "Explain, debug or refactor",
    prompt: "Write code that ",
  },
  {
    title: "Draft an email",
    hint: "Professional, to the point",
    prompt: "Draft a short, professional email that ",
  },
  {
    title: "Explain simply",
    hint: "Plain language, no jargon",
    prompt: "Explain this in plain language, assuming no background knowledge:\n\n",
  },
];

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
 * staggered spring. Reduced-motion renders the final state with no transform.
 */
function AnimatedHeadline({ text }: { text: string }) {
  const reduced = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(false);

  // Re-trigger whenever the text resolves (greeting + name arrive async), so the
  // reveal plays on the real string rather than an empty placeholder.
  useEffect(() => {
    if (!text) return;
    setRevealed(false);
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, [text]);

  const chars = useMemo(() => Array.from(text), [text]);

  return (
    <h1 className="text-4xl font-medium leading-tight sm:text-5xl">
      {chars.map((char, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length glyph run
          key={i}
          className="inline-block bg-gradient-to-br from-sky-500 via-indigo-500 to-purple-500 bg-clip-text text-transparent will-change-transform dark:from-sky-300 dark:via-indigo-300 dark:to-fuchsia-300"
          style={
            reduced
              ? undefined
              : {
                  opacity: revealed ? 1 : 0,
                  transform: revealed
                    ? "translateY(0) rotateX(0deg)"
                    : "translateY(20px) rotateX(-20deg)",
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
 * Split into two halves on purpose.
 *
 * chat-layout.tsx centres greeting -> COMPOSER -> suggestion chips on an empty
 * thread, so the composer sits between these two blocks and cannot be a child of
 * either.
 */
export function EmptyHero() {
  const [greeting, setGreeting] = useState("");
  const user = useQuery(api.users.getUser);

  // Computed in an effect, never during render: a server-rendered time of day
  // can differ from the client's, which is a hydration mismatch, which React
  // reports via console.error — and every e2e script asserts zero of those.
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, []);

  // getUser resolves this as (username || name), so it survives username being
  // optional — and picks up the name Google supplies or the one captured at
  // sign-up.
  const firstName = user?.name?.split(" ")[0] ?? "";
  const headline = greeting ? `${greeting}${firstName ? `, ${firstName}` : ""}` : "";

  return (
    <div className="w-full text-center">
      {/* Reserve the line height so the pill below does not jump when the
          greeting resolves and the animation runs. */}
      <div className="min-h-[3rem] sm:min-h-[3.5rem]">
        {headline && <AnimatedHeadline text={headline} />}
      </div>
      <p className="mt-2 text-sm text-primary/55">
        What would you like to make today?
      </p>
    </div>
  );
}

export function EmptyPrompts({ threadId }: { threadId: string | null }) {
  const { setDraft } = useComposer();
  const { send } = useSendMessage(threadId);

  return (
    <div className="flex w-full flex-wrap justify-center gap-2">
      {SUGGESTIONS.map((s) => (
        <div
          key={s.title}
          className="group relative flex items-center rounded-2xl border border-border bg-card/60 py-2 pl-3.5 pr-9 backdrop-blur-sm transition-colors hover:border-brand/40 hover:bg-primary/5"
        >
          <button
            type="button"
            // Card body fills the composer rather than sending: people almost
            // always tweak a suggestion, and auto-sending burns a request and an
            // inference bill on a prompt they did not finish writing.
            onClick={() => setDraft(s.prompt)}
            className="text-left"
            title={s.hint}
          >
            <span className="block text-sm text-primary/85">{s.title}</span>
          </button>
          <button
            type="button"
            onClick={() => void send(s.prompt)}
            aria-label={`Send: ${s.title}`}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-primary/25 transition group-hover:text-brand-ink hover:bg-primary/5"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
