"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { Input } from "@v1/ui/input";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";

/**
 * Which existing capabilities a skill prefers to work with.
 *
 * A CLOSED LIST, never free text. The runtime accepts only capability intents
 * (`page.fetch`, `blog.serp_research`) — a stable naming layer the platform
 * owns — and refuses raw provider tool ids, which are OpenAPI operation ids
 * that change under us. Letting someone type here would mostly produce
 * declarations that silently resolve to nothing.
 *
 * DECLARING IS NOT GRANTING, and the copy has to earn that distinction rather
 * than assume it. Ticking a box makes a capability more likely to be OFFERED to
 * the model on a matching turn; whether it can actually run is decided later by
 * the same policy that governs every other tool call. Nothing here can widen
 * what the account is allowed to do.
 *
 * The catalogue is fetched, not hardcoded: it reflects THIS deployment's flags,
 * so a capability that is switched off is never offered. `null` means the AI
 * plane could not be reached — the section hides itself entirely, because an
 * empty picker and a broken picker look identical and only one is usually true.
 */

type Capability = { id: string; group: string };

export function CapabilityPicker({
  value,
  max,
  onChange,
}: {
  value: string[];
  max: number;
  onChange: (next: string[]) => void;
}) {
  const list = useAction(api.skillCapabilities.list);
  const [all, setAll] = useState<Capability[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    list({})
      .then((r) => {
        if (!alive) return;
        if (r) setAll(r);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [list]);

  // Unreachable catalogue, or a deployment with nothing to offer: show nothing.
  // A skill is perfectly valid without declaring any capability, so an error
  // state here would be noise on a field that is entirely optional.
  if (failed || !all || all.length === 0) return null;

  const q = filter.trim().toLowerCase();
  const shown = q ? all.filter((c) => c.id.toLowerCase().includes(q)) : all;
  const atLimit = value.length >= max;

  const toggle = (id: string) => {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
      return;
    }
    // Silently ignoring a click at the cap would read as a broken checkbox, so
    // the input is disabled instead and this is only a backstop.
    if (value.length < max) onChange([...value, id]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-sm font-medium text-primary/80">
          Capabilities
        </label>
        <span className="text-[11px] text-primary/35">
          {value.length}/{max}
        </span>
      </div>
      <p className="text-xs text-primary/60">
        Optional. What this skill prefers to work with, so those tools are more
        likely to be offered when it applies. It does not grant access — what
        the assistant may actually run is unchanged.
      </p>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {value.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              className="group flex items-center gap-1 rounded-full border border-border bg-primary/5 px-2 py-0.5 text-[11px] text-primary/70 transition hover:border-destructive hover:text-destructive"
              aria-label={`Remove ${id}`}
            >
              {id}
              <span aria-hidden className="text-primary/60 group-hover:text-destructive">
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      <Input
        value={filter}
        placeholder="Search capabilities…"
        onChange={(e) => setFilter(e.target.value)}
        className="mt-1 bg-transparent"
        aria-label="Search capabilities"
      />

      <div className="scrollbar-quiet max-h-44 overflow-y-auto rounded-lg border border-border">
        {shown.length === 0 && (
          <p className="p-3 text-center text-xs text-primary/60">
            Nothing matches “{filter}”.
          </p>
        )}
        {shown.map((c) => {
          const on = value.includes(c.id);
          return (
            <label
              key={c.id}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition hover:bg-primary/[0.04] ${
                on ? "text-primary/85" : "text-primary/60"
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!on && atLimit}
                onChange={() => toggle(c.id)}
                className="h-3.5 w-3.5 accent-current"
              />
              <span className="font-mono">{c.id}</span>
            </label>
          );
        })}
      </div>
      {atLimit && (
        <p className="text-[11px] text-primary/60">
          That is the maximum for one skill. Untick one to choose another.
        </p>
      )}
    </div>
  );
}
