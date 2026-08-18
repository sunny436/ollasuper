"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { ArrowUpRight, Code2, ImageIcon, PenLine, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useComposer } from "../_hooks/use-composer";
import { useSendMessage } from "../_hooks/use-send-message";

export type Mode = "text" | "code" | "image";

const MODES: { id: Mode; label: string; caption: string; Icon: typeof Code2 }[] = [
  { id: "text", label: "Write", caption: "Draft, summarise, translate", Icon: PenLine },
  { id: "code", label: "Code", caption: "Write, explain or debug", Icon: Code2 },
  { id: "image", label: "Visuals", caption: "Describe and analyse", Icon: ImageIcon },
];

const SUGGESTIONS: Record<Mode, { title: string; hint: string; prompt: string }[]> = {
  text: [
    {
      title: "Summarise a document",
      hint: "Paste it and get the key points",
      prompt: "Summarise the following document into five key points:\n\n",
    },
    {
      title: "Rewrite for clarity",
      hint: "Tighten prose without losing meaning",
      prompt: "Rewrite this so it is clearer and more concise, keeping the meaning:\n\n",
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
  ],
  code: [
    {
      title: "Explain this code",
      hint: "Line by line, with the why",
      prompt: "Explain what this code does and why it is written this way:\n\n```\n\n```",
    },
    {
      title: "Find the bug",
      hint: "Describe the symptom, get a diagnosis",
      prompt: "This code misbehaves. Find the bug and explain the fix:\n\n```\n\n```",
    },
    {
      title: "Write a test",
      hint: "Covering the edge cases",
      prompt: "Write tests for the following, covering the edge cases:\n\n```\n\n```",
    },
    {
      title: "Refactor",
      hint: "Same behaviour, better shape",
      prompt: "Refactor this for readability without changing behaviour:\n\n```\n\n```",
    },
  ],
  image: [
    {
      title: "Describe an image",
      hint: "Attach one and ask",
      prompt: "Describe what is in this image in detail.",
    },
    {
      title: "Extract text",
      hint: "Read a screenshot or scan",
      prompt: "Transcribe all the text visible in this image.",
    },
    {
      title: "Explain a diagram",
      hint: "Architecture, charts, flows",
      prompt: "Explain what this diagram shows and how the pieces relate.",
    },
    {
      title: "Critique a design",
      hint: "Concrete, actionable feedback",
      prompt: "Give concrete, actionable feedback on this UI design.",
    },
  ],
};

function PromptCard({
  title,
  hint,
  onPick,
  onSend,
}: {
  title: string;
  hint: string;
  onPick: () => void;
  onSend: () => void;
}) {
  return (
    <div className="group relative rounded-2xl border border-border bg-card/60 p-3.5 backdrop-blur-sm transition-colors hover:border-brand/40 hover:bg-primary/5">
      <button type="button" onClick={onPick} className="block w-full text-left">
        <span className="block text-sm text-primary/85">{title}</span>
        <span className="mt-0.5 block text-xs text-primary/45">{hint}</span>
      </button>
      <button
        type="button"
        onClick={onSend}
        aria-label={`Send: ${title}`}
        className="absolute right-2 top-2 rounded-md p-1 text-primary/25 transition group-hover:text-brand-ink hover:bg-primary/5"
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Split into two halves on purpose.
 *
 * chat-layout.tsx centres greeting -> mode picker -> COMPOSER -> prompt cards
 * on an empty thread, so the composer sits between these two blocks and cannot
 * be a child of either. `mode` therefore lives in chat-layout and is passed
 * down, which also keeps the two halves in sync for free.
 */
export function EmptyHero({
  mode,
  onModeChange,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
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
  // sign-up. Reading the raw `username` field here would greet most users
  // anonymously now that onboarding no longer forces one.
  const firstName = user?.name?.split(" ")[0] ?? "";

  return (
    <div className="w-full">
      <div className="h-12 w-12 rounded-2xl bg-gradient-to-tr from-sky-400 via-indigo-500 to-purple-500 p-[1.5px] shadow-[0_0_36px_hsl(var(--brand)/0.3)]">
        <div className="grid h-full w-full place-items-center rounded-[14px] bg-card">
          <Sparkles className="h-5 w-5 text-brand-ink" />
        </div>
      </div>

      <h1 className="mt-4 text-2xl font-medium text-primary">
        {greeting}
        {greeting && firstName ? `, ${firstName}` : ""}
      </h1>
      <p className="mt-1 text-sm text-primary/60">
        What would you like to make today?
      </p>

      <div
        role="radiogroup"
        aria-label="What do you want to create?"
        className="mt-6 grid grid-cols-3 gap-2"
      >
        {MODES.map(({ id, label, caption, Icon }) => {
          const selected = mode === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onModeChange(id)}
              className={`rounded-xl border p-3 text-left transition ${
                selected
                  ? "border-brand/40 bg-brand/10 text-brand-ink ring-1 ring-brand/30"
                  : "border-border bg-card/60 text-primary/70 backdrop-blur-sm hover:border-brand/25 hover:bg-primary/5"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="mt-2 block text-sm font-medium">{label}</span>
              <span className="mt-0.5 block text-[11px] text-primary/45">
                {caption}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function EmptyPrompts({
  mode,
  threadId,
}: {
  mode: Mode;
  threadId: string | null;
}) {
  const { setDraft } = useComposer();
  const { send } = useSendMessage(threadId);

  return (
    <div className="grid w-full gap-2.5 sm:grid-cols-2">
      {SUGGESTIONS[mode].map((s) => (
        <PromptCard
          key={s.title}
          title={s.title}
          hint={s.hint}
          // Card body fills the composer rather than sending: people almost
          // always tweak a suggestion, and auto-sending burns a request and
          // an inference bill on a prompt they did not finish writing.
          onPick={() => setDraft(s.prompt)}
          onSend={() => void send(s.prompt)}
        />
      ))}
    </div>
  );
}
