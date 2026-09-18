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
 * Personalization.
 *
 * The state on this page IS the stored shape — no translation layer. It used to
 * compose the widgets into one prose sentence ("Use emoji where appropriate.")
 * and read them back by substring match, so rewording a sentence silently
 * switched that widget off for every stored user, and the server could not tell
 * a base style from a characteristic at all. The server owns the wording now;
 * this page only owns the choice.
 */

type Personalization = {
  version: number;
  enabled: boolean;
  baseStyle: "default" | "friendly" | "concise" | "formal" | "playful";
  characteristics: ("warm" | "enthusiastic" | "headers" | "emoji")[];
  responseSpeed: "fast" | "balanced" | "thorough";
  responseLanguage: string;
};

const DEFAULTS: Personalization = {
  version: 1,
  enabled: true,
  baseStyle: "default",
  characteristics: [],
  responseSpeed: "balanced",
  responseLanguage: "auto",
};

const BASE_STYLES: { key: Personalization["baseStyle"]; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "friendly", label: "Friendly" },
  { key: "concise", label: "Concise" },
  { key: "formal", label: "Formal" },
  { key: "playful", label: "Playful" },
];

const CHARACTERISTICS: {
  key: Personalization["characteristics"][number];
  label: string;
}[] = [
  { key: "warm", label: "Warm" },
  { key: "enthusiastic", label: "Enthusiastic" },
  { key: "headers", label: "Headers & lists" },
  { key: "emoji", label: "Emoji" },
];

// "Auto" is the honest default: match whatever language the user writes in.
// The listed options mirror the app's own locales plus the languages most often
// asked for; anything else stays a future addition rather than a long menu.
const LANGUAGES = [
  { value: "auto", label: "Match my message" },
  { value: "English", label: "English" },
  { value: "Spanish", label: "Español" },
  { value: "French", label: "Français" },
  { value: "German", label: "Deutsch" },
  { value: "Hindi", label: "हिन्दी" },
  { value: "Portuguese", label: "Português" },
];

const MAX_ABOUT = 2000;

/** Stable compare: characteristic ORDER is not a preference. */
function same(a: Personalization, b: Personalization): boolean {
  return (
    a.enabled === b.enabled &&
    a.baseStyle === b.baseStyle &&
    a.responseSpeed === b.responseSpeed &&
    a.responseLanguage === b.responseLanguage &&
    [...a.characteristics].sort().join() === [...b.characteristics].sort().join()
  );
}

export default function PersonalizationSection() {
  const { current } = useWorkspace();
  const settings = useQuery(
    api.chat.settings.get,
    current ? { workspaceId: current } : "skip",
  );
  const upsert = useMutation(api.chat.settings.upsert);
  const resetServer = useMutation(api.chat.settings.resetPersonalization);

  const [p, setP] = useState<Personalization>(DEFAULTS);
  const [about, setAbout] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const baseline = useRef<{ p: Personalization; about: string }>({
    p: DEFAULTS,
    about: "",
  });

  // Adopt the server value on first load, AND whenever it changes while this
  // form is clean.
  //
  // Convex pushes the new row to every open tab, but adopting it
  // unconditionally would overwrite whatever the user is currently typing. So:
  // a dirty form is never touched (their edits are the truth), and a clean one
  // follows the server — which is what stops a second tab sitting on stale
  // preferences and then saving them back over a change made in the first.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!settings) return;
    if (hydrated && dirtyRef.current) return;
    // `responseLanguage` is optional in the stored shape (older rows predate
    // it); "auto" is the honest default for a row that never set one.
    const raw = settings.personalization;
    const next: Personalization = raw
      ? { ...raw, responseLanguage: raw.responseLanguage ?? "auto" }
      : DEFAULTS;
    setP(next);
    setAbout(settings.customInstructionsAbout ?? "");
    baseline.current = { p: next, about: settings.customInstructionsAbout ?? "" };
    setHydrated(true);
  }, [settings, hydrated]);

  // Trimmed on BOTH sides, so a stray space never enables a save that would
  // send nothing — and never leaves the form looking unsaved afterwards.
  const nextAbout = about.trim();
  const dirty =
    !same(p, baseline.current.p) || nextAbout !== baseline.current.about.trim();
  dirtyRef.current = dirty;

  const cancel = () => {
    setP(baseline.current.p);
    setAbout(baseline.current.about);
    setFailed(false);
  };

  const save = async () => {
    if (!current || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await upsert({
        workspaceId: current,
        personalization: p,
        customInstructionsAbout: nextAbout || null,
      });
      baseline.current = { p, about: nextAbout };
      setAbout(nextAbout);
      toast.success("Personalization saved");
    } catch {
      // Kept dirty on purpose: the user's edits are still the truth, and Retry
      // must resend exactly what they see rather than a silently reverted form.
      setFailed(true);
      toast.error("Couldn't save personalization");
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = async () => {
    if (!current || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await resetServer({ workspaceId: current });
      setP(DEFAULTS);
      baseline.current = { ...baseline.current, p: DEFAULTS };
      toast.success("Personalization reset to defaults");
    } catch {
      setFailed(true);
      toast.error("Couldn't reset personalization");
    } finally {
      setSaving(false);
    }
  };

  const toggleTrait = (key: Personalization["characteristics"][number]) =>
    setP((prev) => ({
      ...prev,
      characteristics: prev.characteristics.includes(key)
        ? prev.characteristics.filter((c) => c !== key)
        : [...prev.characteristics, key],
    }));

  // Loading is a real state: rendering defaults first would flash "Default"
  // at a user whose saved style is Formal.
  if (!hydrated) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">
            Personalization
          </h1>
          <p className="mt-1 text-sm text-primary/65">
            Shape how the assistant writes. These preferences apply to every new
            response.
          </p>
        </div>
        <div
          className="rounded-2xl border border-border bg-card/60 p-8 text-center text-sm text-primary/65 backdrop-blur-xl"
          aria-live="polite"
        >
          Loading your preferences…
        </div>
      </div>
    );
  }

  const off = !p.enabled;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          Personalization
        </h1>
        <p className="mt-1 text-sm text-primary/65">
          Shape how the assistant writes. These preferences apply to every new
          response.
        </p>
      </div>

      {/* Master switch. Turning it off IGNORES these preferences; it does not
          erase them, and it does not touch Memory or Projects. */}
      <div className="flex items-center justify-between rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
        <div className="pr-4">
          <h2 className="text-sm font-medium text-primary/80">
            Use personalization
          </h2>
          <p className="mt-1 text-xs text-primary/60">
            When off, replies use the default style. Your settings are kept, and
            Memory and Projects are unaffected.
          </p>
        </div>
        <Switch
          checked={p.enabled}
          onCheckedChange={(v) => setP((prev) => ({ ...prev, enabled: v }))}
          aria-label="Use personalization"
        />
      </div>

      <fieldset
        disabled={off}
        className={`flex flex-col gap-6 border-0 p-0 ${off ? "opacity-50" : ""}`}
      >
        {/* Base style — the REGISTER. Exactly one. */}
        <div className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
          <h2 className="text-sm font-medium text-primary/80">Base style</h2>
          <p className="mt-1 text-xs text-primary/60">
            The overall tone of responses.
          </p>
          <div
            className="mt-4 flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="Base style"
          >
            {BASE_STYLES.map(({ key, label }) => {
              const active = p.baseStyle === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setP((prev) => ({ ...prev, baseStyle: key }))}
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

        {/* Characteristics — they MODULATE the register, never replace it, which
            is why "Formal + Warm" is coherent rather than contradictory. */}
        <div className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
          <h2 className="text-sm font-medium text-primary/80">
            Characteristics
          </h2>
          <p className="mt-1 text-xs text-primary/60">
            Optional traits layered on top of the base style.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {CHARACTERISTICS.map(({ key, label }) => {
              const active = p.characteristics.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleTrait(key)}
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

        {/* Length — a different axis from tone, so "Concise + Thorough" is a
            concise register with fuller coverage, not a contradiction. */}
        <div className="flex items-center justify-between rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
          <div className="pr-4">
            <h2 className="text-sm font-medium text-primary/80">Fast answers</h2>
            <p className="mt-1 text-xs text-primary/60">
              Prefer quick, concise replies over exhaustive detail.
            </p>
          </div>
          <Switch
            checked={p.responseSpeed === "fast"}
            onCheckedChange={(v) =>
              setP((prev) => ({
                ...prev,
                responseSpeed: v ? "fast" : "balanced",
              }))
            }
            aria-label="Fast answers"
          />
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
          <div className="pr-4">
            <h2 className="text-sm font-medium text-primary/80">
              Response language
            </h2>
            <p className="mt-1 text-xs text-primary/60">
              Which language replies are written in.
            </p>
          </div>
          <select
            value={p.responseLanguage}
            aria-label="Response language"
            onChange={(e) =>
              setP((prev) => ({ ...prev, responseLanguage: e.target.value }))
            }
            className="rounded-lg border border-border bg-card/60 px-3 py-1.5 text-sm text-primary/80 outline-none transition focus:border-brand/40"
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
          <h2 className="text-sm font-medium text-primary/80">
            Custom instructions
          </h2>
          <p className="mt-1 text-xs text-primary/60">
            Anything else the assistant should know about you or how you like to
            work. A specific instruction here wins over the toggles above.
          </p>
          <Textarea
            value={about}
            maxLength={MAX_ABOUT}
            aria-label="Custom instructions"
            aria-describedby="about-count"
            onChange={(e) => setAbout(e.target.value)}
            placeholder="e.g. I'm a backend engineer. Assume I know the fundamentals and skip the basics."
            className="mt-4 min-h-28 resize-y bg-transparent"
          />
          <p
            id="about-count"
            className="mt-1 text-right text-[11px] text-primary/35"
          >
            {[...about].length}/{MAX_ABOUT}
          </p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {failed && (
          <p className="mr-auto text-xs text-red-600" role="alert">
            Couldn't reach the server. Your changes are still here — try again.
          </p>
        )}
        {!failed && dirty && (
          <p className="mr-auto text-xs text-primary/60" aria-live="polite">
            Unsaved changes
          </p>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={saving}
          onClick={() => void resetToDefaults()}
        >
          Reset to defaults
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!dirty || saving}
          onClick={cancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving || !current}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : failed ? "Retry" : "Save"}
        </Button>
      </div>
    </div>
  );
}
