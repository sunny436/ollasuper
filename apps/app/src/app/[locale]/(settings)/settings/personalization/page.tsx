"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import { Button } from "@v1/ui/button";
import { Switch } from "@v1/ui/switch";
import { Textarea } from "@v1/ui/textarea";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Personalization has no dedicated backend table — by design (see the approved
 * plan). The widgets are serialized into the EXISTING `customInstructionsStyle`
 * as parseable natural-language clauses, and the free-text box maps to
 * `customInstructionsAbout`. Both already reach the model:
 * stream.dispatchPayload → services/ai context.py renders <response_style> and
 * <about_the_user>. So every control here is persistent and model-connected.
 */

const TONES = ["Default", "Friendly", "Concise", "Formal", "Playful"] as const;
type Tone = (typeof TONES)[number];

// Each widget is one exact clause. Round-tripping is exact-substring match, so
// these strings are the contract — do not reword without a migration thought.
const CLAUSES = {
  warm: "Be warm and encouraging.",
  enthusiastic: "Be enthusiastic and energetic.",
  headers: "Use headers and lists to structure responses.",
  emoji: "Use emoji where appropriate.",
  fast: "Prefer fast, concise answers over exhaustive detail.",
} as const;

const CHARACTERISTICS: { key: keyof typeof CLAUSES; label: string }[] = [
  { key: "warm", label: "Warm" },
  { key: "enthusiastic", label: "Enthusiastic" },
  { key: "headers", label: "Headers & lists" },
  { key: "emoji", label: "Emoji" },
];

type Widgets = {
  tone: Tone;
  warm: boolean;
  enthusiastic: boolean;
  headers: boolean;
  emoji: boolean;
  fast: boolean;
};

const EMPTY: Widgets = {
  tone: "Default",
  warm: false,
  enthusiastic: false,
  headers: false,
  emoji: false,
  fast: false,
};

// Parse a stored style string back into widget state. Anything we don't
// recognise is returned as `extra` and preserved on save, so a style set
// elsewhere is never silently clobbered.
function parseStyle(style: string | null | undefined): {
  widgets: Widgets;
  extra: string;
} {
  let rest = style ?? "";
  const widgets: Widgets = { ...EMPTY };
  for (const [key, clause] of Object.entries(CLAUSES)) {
    if (rest.includes(clause)) {
      rest = rest.replace(clause, "");
      widgets[key as keyof typeof CLAUSES] = true;
    }
  }
  const tone = rest.match(/Tone:\s*([A-Za-z]+)\./);
  const toneVal = tone?.[1];
  if (tone && toneVal && (TONES as readonly string[]).includes(toneVal)) {
    widgets.tone = toneVal as Tone;
    rest = rest.replace(tone[0] ?? "", "");
  }
  return { widgets, extra: rest.replace(/\s+/g, " ").trim() };
}

function composeStyle(w: Widgets, extra: string): string {
  const parts: string[] = [];
  if (w.tone !== "Default") parts.push(`Tone: ${w.tone}.`);
  if (w.warm) parts.push(CLAUSES.warm);
  if (w.enthusiastic) parts.push(CLAUSES.enthusiastic);
  if (w.headers) parts.push(CLAUSES.headers);
  if (w.emoji) parts.push(CLAUSES.emoji);
  if (w.fast) parts.push(CLAUSES.fast);
  if (extra) parts.push(extra);
  return parts.join(" ").trim();
}

export default function PersonalizationSection() {
  const { current } = useWorkspace();
  const settings = useQuery(
    api.chat.settings.get,
    current ? { workspaceId: current } : "skip",
  );
  const upsert = useMutation(api.chat.settings.upsert);

  const [w, setW] = useState<Widgets>(EMPTY);
  const [about, setAbout] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  // Preserved verbatim across a save so a pre-existing style isn't clobbered.
  const extraRef = useRef("");
  // The persisted baseline, to compute dirty + reset.
  const baseline = useRef<{ w: Widgets; about: string }>({
    w: EMPTY,
    about: "",
  });

  useEffect(() => {
    if (settings === undefined || hydrated) return;
    const { widgets, extra } = parseStyle(settings.customInstructionsStyle);
    extraRef.current = extra;
    setW(widgets);
    setAbout(settings.customInstructionsAbout ?? "");
    baseline.current = { w: widgets, about: settings.customInstructionsAbout ?? "" };
    setHydrated(true);
  }, [settings, hydrated]);

  const dirty =
    JSON.stringify(w) !== JSON.stringify(baseline.current.w) ||
    about !== baseline.current.about;

  const reset = () => {
    setW(baseline.current.w);
    setAbout(baseline.current.about);
  };

  const onSave = async () => {
    if (!current || saving) return;
    setSaving(true);
    try {
      await upsert({
        workspaceId: current,
        customInstructionsStyle: composeStyle(w, extraRef.current) || null,
        customInstructionsAbout: about.trim() || null,
      });
      baseline.current = { w, about };
      toast.success("Personalization saved");
    } catch {
      toast.error("Couldn't save personalization");
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: keyof typeof CLAUSES) =>
    setW((p) => ({ ...p, [key]: !p[key] }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          Personalization
        </h1>
        <p className="mt-1 text-sm text-primary/55">
          Shape how the assistant writes. These preferences apply to every new
          response.
        </p>
      </div>

      {/* Base style */}
      <div className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium text-primary/80">Base style</h2>
        <p className="mt-1 text-xs text-primary/45">
          The overall tone of responses.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {TONES.map((tone) => {
            const active = w.tone === tone;
            return (
              <button
                key={tone}
                type="button"
                onClick={() => setW((p) => ({ ...p, tone }))}
                className={`rounded-full border px-4 py-1.5 text-sm transition ${
                  active
                    ? "border-brand/40 bg-brand/10 font-medium text-brand-ink"
                    : "border-border text-primary/60 hover:bg-card/40 hover:text-primary/90"
                }`}
              >
                {tone}
              </button>
            );
          })}
        </div>
      </div>

      {/* Characteristics */}
      <div className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium text-primary/80">Characteristics</h2>
        <p className="mt-1 text-xs text-primary/45">
          Optional traits layered on top of the base style.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {CHARACTERISTICS.map(({ key, label }) => {
            const active = w[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggle(key)}
                aria-pressed={active}
                className={`rounded-full border px-4 py-1.5 text-sm transition ${
                  active
                    ? "border-brand/40 bg-brand/10 font-medium text-brand-ink"
                    : "border-border text-primary/60 hover:bg-card/40 hover:text-primary/90"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Fast answers */}
      <div className="flex items-center justify-between rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
        <div className="pr-4">
          <h2 className="text-sm font-medium text-primary/80">Fast answers</h2>
          <p className="mt-1 text-xs text-primary/45">
            Prefer quick, concise replies over exhaustive detail.
          </p>
        </div>
        <Switch
          checked={w.fast}
          onCheckedChange={(v) => setW((p) => ({ ...p, fast: v }))}
          aria-label="Fast answers"
        />
      </div>

      {/* Custom instructions */}
      <div className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium text-primary/80">
          Custom instructions
        </h2>
        <p className="mt-1 text-xs text-primary/45">
          Anything else the assistant should know about you or how you like to
          work.
        </p>
        <Textarea
          value={about}
          maxLength={2000}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="e.g. I'm a backend engineer. Assume I know the fundamentals and skip the basics."
          className="mt-4 min-h-28 resize-y bg-transparent"
        />
        <p className="mt-1 text-right text-[11px] text-primary/35">
          {about.length}/2000
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!dirty || saving}
          onClick={reset}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving || !current}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
