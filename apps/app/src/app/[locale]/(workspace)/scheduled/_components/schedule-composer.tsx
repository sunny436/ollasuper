"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { ArrowUp, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCachedUser } from "../../chat/_hooks/use-cached-user";
import {
  type ScheduleSpec,
  browserZone,
  scheduleSummary,
} from "../_lib/schedule-format";
import { ScheduleFields, emptySpec } from "./schedule-fields";

/**
 * The scheduling composer.
 *
 * A bounded DRAFT CONVERSATION that always ends in an explicit, editable
 * confirmation. Say "every Monday and Friday at 9am, search AI news", correct it
 * with "actually make it 8am and add Wednesday", then press Create.
 *
 * Two properties are deliberate:
 *
 *  - NOTHING IS PERSISTED UNTIL CONFIRM. The draft lives in React (mirrored to
 *    sessionStorage so a refresh does not lose it); no scheduledTasks row
 *    exists during the conversation, so abandoning it leaves nothing behind.
 *  - THE CARD IS THE AUTHORITY, not the parser. Confirm submits the fields as
 *    shown, and every parser failure — timeout, rate limit, malformed reply —
 *    degrades to the same editable form rather than blocking the user.
 */

type Turn = { role: "user" | "assistant"; content: string };
type Phase = "idle" | "parsing" | "draft" | "creating";

interface Draft {
  title: string;
  prompt: string;
  spec: ScheduleSpec;
  needs: string[];
  question: string | null;
}

const MAX_TEXT = 2_000;

export function ScheduleComposer({
  onCreated,
}: {
  onCreated: (id: Id<"scheduledTasks">) => void;
}) {
  const { current } = useWorkspace();
  const user = useCachedUser();
  const parse = useAction(api.scheduled.parse.parse);
  const create = useMutation(api.scheduled.tasks.create);

  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Scoped to the user AND workspace: a shared browser must never surface one
  // person's half-written task to the next.
  const storageKey = `scheduled:draft:${user?.email ?? "anon"}:${current ?? "none"}`;

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { turns: Turn[]; draft: Draft };
      if (saved?.draft) {
        setTurns(saved.turns ?? []);
        setDraft(saved.draft);
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
    setText("");
    setPhase("parsing");

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

    if (!res.ok || !("schedule" in res) || !res.schedule) {
      // Every failure lands in the same place: an editable form seeded with
      // what the user typed. Parsing is never on the critical path.
      const fallback: Draft = draft ?? {
        title: message.slice(0, 60),
        prompt: message,
        spec: emptySpec(),
        needs: [],
        question: null,
      };
      setDraft(fallback);
      setPhase("draft");
      persist(nextTurns, fallback);
      setTurns([
        ...nextTurns,
        {
          role: "assistant",
          content:
            "reason" in res && res.reason === "rate_limited"
              ? "You've scheduled a lot just now — set the details below and I'll create it."
              : "I couldn't read that as a schedule. Set the details below and I'll create it.",
        },
      ]);
      return;
    }

    const parsed = res.schedule as Record<string, unknown>;
    const spec = specFromParsed(parsed, draft?.spec ?? emptySpec());
    const next: Draft = {
      title:
        (typeof parsed.title === "string" && parsed.title.trim()) ||
        draft?.title ||
        message.slice(0, 60),
      prompt:
        (typeof parsed.prompt === "string" && parsed.prompt.trim()) ||
        draft?.prompt ||
        message,
      spec,
      needs: Array.isArray(res.needs) ? (res.needs as string[]) : [],
      question: typeof res.question === "string" ? res.question : null,
    };
    setDraft(next);
    setPhase("draft");
    persist(nextTurns, next);
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
        <button
          type="button"
          onClick={() => void send()}
          disabled={!text.trim() || phase === "parsing" || phase === "creating"}
          aria-label="Interpret schedule"
          className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground transition disabled:opacity-30"
        >
          {phase === "parsing" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </div>

      {turns.length > 0 && (
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
        </div>
      )}

      {draft && (
        <div className="rounded-2xl border border-brand/30 bg-brand/[0.04] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-primary">
                {draft.title || "Untitled task"}
              </p>
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
            onChange={(e) => {
              const next = { ...draft, prompt: e.target.value };
              setDraft(next);
              persist(turns, next);
            }}
            rows={3}
            maxLength={8000}
            aria-label="Task instruction"
            className="mt-3 w-full resize-y rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-primary outline-none focus:border-brand/40"
          />

          <div className="mt-3">
            <ScheduleFields
              value={draft.spec}
              highlight={draft.needs}
              onChange={(spec) => {
                const next = { ...draft, spec, needs: [] };
                setDraft(next);
                persist(turns, next);
              }}
            />
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
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
              disabled={phase === "creating"}
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
  const tz =
    typeof parsed.timezone === "string" && parsed.timezone
      ? parsed.timezone
      : previous.timezone;
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
      weekdays: days.length
        ? days
        : previous.kind === "weekly"
          ? previous.weekdays
          : [0],
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
