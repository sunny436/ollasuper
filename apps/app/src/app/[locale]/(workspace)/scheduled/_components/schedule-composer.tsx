"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { ArrowUp, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCachedUser } from "../../chat/_hooks/use-cached-user";
import {
  type ScheduleSpec,
  browserZone,
  isValidZone,
  scheduleSummary,
} from "../_lib/schedule-format";
import { ScheduleFields, emptySpec, specGaps } from "./schedule-fields";

/**
 * The scheduling composer.
 *
 * A bounded DRAFT CONVERSATION that always ends in an explicit, editable
 * confirmation. Say "every Monday and Friday at 9am, search AI news", correct it
 * with "actually make it 8am and add Wednesday", then press Create.
 *
 * Three properties are deliberate:
 *
 *  - NOTHING IS PERSISTED UNTIL CONFIRM. The draft lives in React (mirrored to
 *    sessionStorage so a refresh does not lose it); no scheduledTasks row
 *    exists during the conversation, so abandoning it leaves nothing behind.
 *  - THE CARD IS THE AUTHORITY, not the parser. Confirm submits the fields as
 *    shown, and every parser failure — timeout, rate limit, malformed reply —
 *    degrades to the same editable form rather than blocking the user.
 *  - A GAP IS A QUESTION, NEVER A GUESS. This one is newer, and it is the fix
 *    for a real defect. The parser reports what it could not determine; this
 *    file used to throw that away and substitute the raw sentence for the title
 *    and instruction, and weekday 0 — Monday — for the days. All three read as
 *    decisions the user had made. Now an undetermined field is SEEDED so it
 *    stays editable, but marked `unresolved`, and Create is refused until every
 *    one of them has been answered.
 */

type Turn = { role: "user" | "assistant"; content: string };
type Phase = "idle" | "parsing" | "draft" | "creating";

interface Draft {
  title: string;
  prompt: string;
  spec: ScheduleSpec;
  /**
   * Fields that are filled in but NOT answered — the parser could not determine
   * them, or admitted it guessed. Blocks Create; cleared field-by-field as the
   * user edits. A seeded value is not an answer.
   */
  unresolved: string[];
  /** The subset of `unresolved` that came back filled but unsafely ("at 8"). */
  ambiguous: string[];
  question: string | null;
  /**
   * Which field `question` was written to answer. The parser is asked for one
   * question about the FIRST thing it needs, so once that field is answered the
   * question is stale — showing it anyway asks for something already given.
   */
  questionFor: string | null;
  emailOnSuccess: boolean;
  attachPdf: boolean;
}

const MAX_TEXT = 2_000;

/** What to show beside a blocked Create when the parser sent no question. */
const FIELD_PROMPTS: Record<string, string> = {
  title: "Give the task a name",
  prompt: "Say what should happen on each run",
  kind: "Choose how often it repeats",
  hour: "Set the time — is that AM or PM?",
  weekdays: "Pick a day",
  dayOfMonth: "Pick a day of the month",
  runAt: "Set the date and time",
};

function blockingReason(draft: Draft): string | null {
  const first = draft.unresolved[0];
  if (!first) return null;
  // The parser's own wording, but only while it still addresses what is
  // missing. Once its field is answered the question is stale, and showing it
  // asks the user for something they have already given.
  if (draft.question && draft.questionFor === first) return draft.question;
  return FIELD_PROMPTS[first] ?? "A few details are missing";
}

/** Remove one field from `unresolved` — the user just answered it. */
function resolve(draft: Draft, ...fields: string[]): string[] {
  return draft.unresolved.filter((f) => !fields.includes(f));
}

export function ScheduleComposer({
  onCreated,
}: {
  onCreated: (id: Id<"scheduledTasks">) => void;
}) {
  const { current } = useWorkspace();
  const user = useCachedUser();
  const parse = useAction(api.scheduled.parse.parse);
  const create = useMutation(api.scheduled.tasks.create);
  const setNotifyPrefs = useMutation(api.scheduled.tasks.setNotifyPrefs);

  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * Monotonic id of the parse the UI is currently waiting for.
   *
   * There is NO application deadline on a parse any more (a complex one can
   * legitimately take tens of seconds), so a reply can land long after the user
   * has moved on — they cancelled, or typed and sent something else. Every
   * response checks its own id against this before touching state; a stale one
   * is dropped. Cancelling simply bumps the id, which is why it needs no
   * AbortController: Convex actions take no AbortSignal, so the in-flight server
   * work cannot actually be stopped, and pretending otherwise would be a lie.
   * It finishes upstream, wastes one call, and is ignored.
   *
   * This also closes an existing race: two rapid submissions could previously
   * resolve out of order and let the OLDER answer overwrite the newer one.
   */
  const parseId = useRef(0);
  /** The sentence sent for parsing, so Cancel returns it rather than eating it. */
  const pendingText = useRef("");

  // Scoped to the user AND workspace: a shared browser must never surface one
  // person's half-written task to the next.
  const storageKey = `scheduled:draft:${user?.email ?? "anon"}:${current ?? "none"}`;

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { turns: Turn[]; draft: Partial<Draft> };
      if (saved?.draft?.spec) {
        setTurns(saved.turns ?? []);
        // A draft stored before `unresolved` existed has no gap information, so
        // treat it as answered rather than blocking a user on a field they
        // cannot tell apart from the ones they already filled in.
        setDraft({
          title: saved.draft.title ?? "",
          prompt: saved.draft.prompt ?? "",
          spec: saved.draft.spec,
          unresolved: saved.draft.unresolved ?? [],
          ambiguous: saved.draft.ambiguous ?? [],
          question: saved.draft.question ?? null,
          questionFor: saved.draft.questionFor ?? null,
          emailOnSuccess: saved.draft.emailOnSuccess ?? false,
          attachPdf: saved.draft.attachPdf ?? false,
        });
        setPhase("draft");
      }
    } catch {
      // Private mode / corrupt entry: starting fresh is fine.
    }
  }, [storageKey]);

  const persist = useCallback(
    (nextTurns: Turn[], nextDraft: Draft | null) => {
      try {
        if (nextDraft) {
          window.sessionStorage.setItem(
            storageKey,
            JSON.stringify({ turns: nextTurns, draft: nextDraft }),
          );
        } else {
          window.sessionStorage.removeItem(storageKey);
        }
      } catch {
        // Non-fatal; the draft still works for this session.
      }
    },
    [storageKey],
  );

  /** One place to write a draft, so nothing can update state without saving. */
  const apply = useCallback(
    (next: Draft, nextTurns: Turn[] = turns) => {
      setDraft(next);
      persist(nextTurns, next);
    },
    [persist, turns],
  );

  function discard() {
    setTurns([]);
    setDraft(null);
    setPhase("idle");
    setText("");
    persist([], null);
  }

  async function send() {
    const message = text.trim();
    if (!message || !current || phase === "parsing" || phase === "creating") {
      return;
    }
    if (message.length > MAX_TEXT) {
      toast.error("That's a bit long for a schedule — try summarising it");
      return;
    }
    const nextTurns: Turn[] = [...turns, { role: "user", content: message }];
    setTurns(nextTurns);
    pendingText.current = message;
    setText("");
    setPhase("parsing");
    const myParse = ++parseId.current;

    let res: Awaited<ReturnType<typeof parse>>;
    try {
      res = await parse({
        workspaceId: current,
        text: message,
        turns: nextTurns.slice(-6),
        draft: draft
          ? { ...draft.spec, title: draft.title, prompt: draft.prompt }
          : undefined,
        timezone: browserZone(),
      });
    } catch {
      res = { ok: false, reason: "unavailable" };
    }
    // Cancelled, or superseded by a newer submission: this answer is no longer
    // the one the user is waiting for.
    if (myParse !== parseId.current) return;

    if (!res.ok || !("schedule" in res) || !res.schedule) {
      // Every failure lands in the same place: an editable form seeded with
      // what the user typed. Parsing is never on the critical path.
      //
      // But the seed is the RAW SENTENCE, and a task made from it is exactly
      // the reported bug — a run that asks the assistant to "create a
      // scheduler". So title and instruction are marked unresolved: the user
      // must write them, which is one edit each. The schedule itself is left
      // alone; "Daily at 9:00 AM" is a visible, conventional default sitting in
      // a form the user is already filling in, not a hidden guess.
      const fallback: Draft = draft ?? {
        title: message.slice(0, 60),
        prompt: message,
        spec: emptySpec(),
        unresolved: ["title", "prompt"],
        ambiguous: [],
        question: null,
        questionFor: null,
        emailOnSuccess: false,
        attachPdf: false,
      };
      const why =
        "reason" in res && res.reason === "rate_limited"
          ? "You've scheduled a lot just now — set the details below and I'll create it."
          : "reason" in res && res.reason === "unavailable"
            // NOT the user's fault, and "I couldn't read that" says it was. The
            // sentence was fine; the scheduling assistant could not be reached.
            // Telling them to rephrase would send them round a loop that cannot
            // succeed, so name the real state and what still works.
            ? "I couldn't reach the scheduling assistant just now. The fields below still work — set the name and what it should do, and I'll create it."
            : "I couldn't read that as a schedule. Fill in the name and what it should do, and I'll create it.";
      // ONE list, built before either setter. `apply` persists whatever it is
      // handed, so passing `nextTurns` here and adding the explanation to React
      // state afterwards wrote a transcript WITHOUT it: the reason showed once
      // and vanished on the next reload, leaving a blocked Create with nothing
      // on screen to explain it.
      const withWhy: Turn[] = [...nextTurns, { role: "assistant", content: why }];
      setPhase("draft");
      apply(fallback, withWhy);
      setTurns(withWhy);
      return;
    }

    const parsed = res.schedule as Record<string, unknown>;
    const spec = specFromParsed(parsed, draft?.spec ?? emptySpec());

    const parsedTitle =
      typeof parsed.title === "string" ? parsed.title.trim() : "";
    const parsedPrompt =
      typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";

    // Seed so the field stays editable; record that it was seeded, not answered.
    const unresolved = new Set<string>(
      Array.isArray(res.needs) ? (res.needs as string[]) : [],
    );
    if (!parsedTitle && (!draft?.title || draft.unresolved.includes("title"))) {
      unresolved.add("title");
    }
    if (
      !parsedPrompt &&
      (!draft?.prompt || draft.unresolved.includes("prompt"))
    ) {
      unresolved.add("prompt");
    }
    // A weekly draft with no day: the composer no longer invents Monday.
    for (const f of specGaps(spec)) unresolved.add(f);

    const next: Draft = {
      title: parsedTitle || draft?.title || message.slice(0, 60),
      prompt: parsedPrompt || draft?.prompt || message,
      spec,
      unresolved: [...unresolved],
      ambiguous: Array.isArray(res.ambiguous) ? (res.ambiguous as string[]) : [],
      question: typeof res.question === "string" ? res.question : null,
      // The parser answers the first item of its OWN needs list.
      questionFor:
        Array.isArray(res.needs) && res.needs.length
          ? (res.needs[0] as string)
          : null,
      emailOnSuccess: draft?.emailOnSuccess ?? false,
      attachPdf: draft?.attachPdf ?? false,
    };
    setPhase("draft");
    apply(next, nextTurns);
    setTurns([
      ...nextTurns,
      {
        role: "assistant",
        content: next.question ?? scheduleSummary(next.spec),
      },
    ]);
  }

  async function confirm() {
    if (!draft || !current) return;
    if (draft.unresolved.length > 0) return;
    if (!draft.prompt.trim()) {
      toast.error("A scheduled task needs an instruction");
      return;
    }
    setPhase("creating");
    try {
      const id = await create({
        workspaceId: current,
        title: draft.title || draft.prompt.slice(0, 60),
        prompt: draft.prompt,
        // biome-ignore lint/suspicious/noExplicitAny: the validator owns the shape
        spec: draft.spec as any,
      });
      // Delivery is a separate, already-existing mutation — creation does not
      // carry these, and a failure here must not look like a failed create.
      if (draft.emailOnSuccess || draft.attachPdf) {
        try {
          await setNotifyPrefs({
            taskId: id,
            emailOnSuccess: draft.emailOnSuccess,
            attachPdf: draft.attachPdf,
          });
        } catch {
          toast.warning("Task created — but its email setting didn't save");
        }
      }
      // Cleared only AFTER the mutation resolves, so a failure never leaves a
      // phantom task or an emptied composer.
      discard();
      toast.success("Scheduled task created");
      onCreated(id);
    } catch (e) {
      setPhase("draft");
      toast.error(e instanceof Error ? e.message : "Couldn't create the task");
    }
  }

  const reason = draft ? blockingReason(draft) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2.5 focus-within:border-brand/40">
        <Plus className="mb-1.5 h-4 w-4 shrink-0 text-primary/40" />
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          placeholder="Schedule a task"
          aria-label="Schedule a task"
          disabled={phase === "parsing" || phase === "creating"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm text-primary outline-none placeholder:text-primary/35 disabled:opacity-60"
        />
        {/*
          While parsing this is a CANCEL, not a dead spinner. Nothing bounds a
          parse from the application side any more, so without an escape a slow
          provider would leave the composer frozen with no way out. Cancelling
          stops the WAIT — the request itself finishes upstream unnoticed (see
          `parseId`).
        */}
        {phase === "parsing" ? (
          <button
            type="button"
            onClick={() => {
              parseId.current += 1; // orphan the in-flight reply
              setPhase("idle");
              setText(pendingText.current);
              // Drop the optimistic user turn: leaving it would show a question
              // in the transcript that now has no answer coming.
              setTurns((t) => t.slice(0, -1));
              inputRef.current?.focus();
            }}
            aria-label="Stop interpreting"
            title="Stop waiting"
            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-primary/60 transition hover:bg-primary/5 hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || phase === "creating"}
            aria-label="Interpret schedule"
            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground transition disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>

      {(turns.length > 0 || phase === "parsing") && (
        <div className="space-y-2 px-1">
          {turns.slice(-4).map((t, i) => (
            <p
              key={`${t.role}-${i}-${t.content.slice(0, 12)}`}
              className={`text-xs ${
                t.role === "user" ? "text-primary/70" : "text-muted-foreground"
              }`}
            >
              {t.role === "user" ? "You: " : ""}
              {t.content}
            </p>
          ))}
          {/*
            A parse can take several seconds. The input disables and the send
            arrow turns into a cancel X, but nothing on screen said work was
            happening, so the composer read as frozen and testers clicked again.
            This is the same <p> an assistant turn uses, driven by the `phase`
            state that already exists — no timer, no new state, and no invented
            progress figure.
          */}
          {phase === "parsing" && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Working out the schedule…
            </p>
          )}
        </div>
      )}

      {draft && (
        <div className="rounded-2xl border border-brand/30 bg-brand/[0.04] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {/* Editable: the name is one of the fields the parser can fail to
                  determine, so it must be answerable here. It used to be plain
                  text showing the raw sentence. */}
              <input
                value={draft.title}
                onChange={(e) =>
                  apply({
                    ...draft,
                    title: e.target.value,
                    unresolved: resolve(draft, "title"),
                  })
                }
                placeholder="Name this task"
                aria-label="Task name"
                maxLength={200}
                className={`w-full bg-transparent text-sm font-medium text-primary outline-none placeholder:text-primary/35 ${
                  draft.unresolved.includes("title")
                    ? "rounded-md bg-brand/10 px-1.5 py-0.5"
                    : ""
                }`}
              />
              <p className="mt-0.5 text-xs text-muted-foreground">
                {scheduleSummary(draft.spec)}
              </p>
            </div>
            <button
              type="button"
              onClick={discard}
              aria-label="Discard draft"
              className="shrink-0 rounded-md p-1 text-primary/40 hover:bg-primary/5 hover:text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <textarea
            value={draft.prompt}
            onChange={(e) =>
              apply({
                ...draft,
                prompt: e.target.value,
                unresolved: resolve(draft, "prompt"),
              })
            }
            rows={3}
            maxLength={8000}
            aria-label="Task instruction"
            placeholder="What should happen each time this runs?"
            className={`mt-3 w-full resize-y rounded-xl border bg-card px-3 py-2.5 text-sm text-primary outline-none focus:border-brand/40 ${
              draft.unresolved.includes("prompt")
                ? "border-brand/40 bg-brand/[0.06]"
                : "border-border"
            }`}
          />

          <div className="mt-3">
            <ScheduleFields
              value={draft.spec}
              highlight={draft.unresolved}
              onChange={(spec) => {
                // Touching the schedule answers its own gaps, except any the
                // spec still genuinely has (a weekly with no day chosen yet).
                const gaps = specGaps(spec);
                const cleared = resolve(
                  draft,
                  "kind",
                  "hour",
                  "weekdays",
                  "dayOfMonth",
                  "runAt",
                );
                apply({
                  ...draft,
                  spec,
                  unresolved: [...new Set([...cleared, ...gaps])],
                });
              }}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
            <Toggle
              label="Email me each result"
              checked={draft.emailOnSuccess}
              onChange={(v) =>
                apply({
                  ...draft,
                  emailOnSuccess: v,
                  attachPdf: v ? draft.attachPdf : false,
                })
              }
            />
            {draft.emailOnSuccess && (
              <Toggle
                label="Attach a PDF"
                checked={draft.attachPdf}
                onChange={(v) => apply({ ...draft, attachPdf: v })}
              />
            )}
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            {reason && (
              <p className="mr-auto text-xs text-primary/60">{reason}</p>
            )}
            <button
              type="button"
              onClick={discard}
              className="rounded-full border border-border px-4 py-1.5 text-sm text-primary/80 transition hover:bg-accent"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={phase === "creating" || draft.unresolved.length > 0}
              title={reason ?? undefined}
              className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-40"
            >
              {phase === "creating" ? "Creating…" : "Create task"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-primary/70">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-[hsl(var(--brand))]"
      />
      {label}
    </label>
  );
}

/**
 * Turn the parser's loose JSON into a spec Phase 1 will accept, keeping the
 * previous draft for anything it did not determine.
 */
function specFromParsed(
  parsed: Record<string, unknown>,
  previous: ScheduleSpec,
): ScheduleSpec {
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  // The parser is a MODEL, and a model asked to read a sentence will happily
  // return a timezone nobody mentioned — production holds an "Asia/Aden" task
  // created by a user who never typed it. The detected zone already travels to
  // the parser, so anything it hands back that this engine does not recognise
  // is discarded rather than persisted.
  const parsedTz =
    typeof parsed.timezone === "string" && parsed.timezone
      ? parsed.timezone
      : null;
  const tz =
    parsedTz && isValidZone(parsedTz) ? parsedTz : previous.timezone;
  const prevHour = previous.kind === "once" ? 9 : previous.hour;
  const prevMinute = previous.kind === "once" ? 0 : previous.minute;
  const hour = num(parsed.hour, prevHour);
  const minute = num(parsed.minute, prevMinute);
  const endsAt =
    typeof parsed.endsAt === "number" ? parsed.endsAt : undefined;
  const kind = parsed.kind;

  if (kind === "once") {
    return {
      kind: "once",
      timezone: tz,
      runAt: num(parsed.runAt, Date.now() + 3_600_000),
    };
  }
  if (kind === "weekly") {
    const days = Array.isArray(parsed.weekdays)
      ? (parsed.weekdays as unknown[])
          .filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
          .sort((a, b) => a - b)
      : [];
    return {
      kind: "weekly",
      timezone: tz,
      // NO DEFAULT DAY. This used to fall back to [0] — Monday — which is how
      // "every sunday" became a Monday task. An undetermined day is reported
      // through `specGaps` and blocks Create instead.
      weekdays: days.length
        ? days
        : previous.kind === "weekly"
          ? previous.weekdays
          : [],
      hour,
      minute,
      endsAt,
    };
  }
  if (kind === "monthly") {
    return {
      kind: "monthly",
      timezone: tz,
      dayOfMonth: num(
        parsed.dayOfMonth,
        previous.kind === "monthly" ? previous.dayOfMonth : 1,
      ),
      hour,
      minute,
      endsAt,
    };
  }
  return { kind: "daily", timezone: tz, hour, minute, endsAt };
}
