"use client";

import { api } from "@v1/backend/convex/_generated/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@v1/ui/dropdown-menu";
import { useQuery } from "convex/react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { modelLabel, pricePerMillion } from "../_lib/models";

/**
 * How many matches to render at once.
 *
 * The catalogue is ~400 models; mounting that many Radix menu items makes the
 * dropdown visibly janky to open. Everything is still reachable — the filter
 * searches the whole list, this only bounds what is painted.
 */
const MAX_RENDERED = 50;

function priceHint(prompt: string, completion: string): string {
  const inPrice = pricePerMillion(prompt);
  const outPrice = pricePerMillion(completion);
  // Both null means OpenRouter reported "-1": one of the meta-routers, whose
  // price depends on which model it routes to.
  if (inPrice === null && outPrice === null) return "variable pricing";
  if (inPrice === 0 && outPrice === 0) return "free";
  const fmt = (n: number | null) =>
    n === null ? "?" : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(2)}`;
  return `${fmt(inPrice)} in · ${fmt(outPrice)} out /1M`;
}

export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const models = useQuery(api.chat.models.list, {});
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const list = models ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (m) =>
        m.modelId.toLowerCase().includes(needle) ||
        m.name.toLowerCase().includes(needle),
    );
  }, [models, q]);

  const shown = filtered.slice(0, MAX_RENDERED);
  const hidden = filtered.length - shown.length;

  // The catalogue carries a display name; fall back to deriving one from the id
  // so the trigger never renders a bare slug while the query is in flight.
  const current = models?.find((m) => m.modelId === value);

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQ("")}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Choose model"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-primary/50 transition hover:bg-primary/5 hover:text-primary/80 disabled:opacity-40"
        >
          {current?.name ?? modelLabel(value)}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>

      {/*
        `workspace` is repeated here because Radix portals this content to
        document.body, OUTSIDE the .workspace element that scopes the surface
        tokens. Without it the dropdown renders against the base palette.
      */}
      <DropdownMenuContent
        align="start"
        className="workspace w-[22rem] bg-popover p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-primary/35" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            // Radix DropdownMenu implements its own typeahead: without this it
            // swallows every keystroke to jump between items, and the field
            // cannot be typed into at all.
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search models…"
            aria-label="Search models"
            className="w-full bg-transparent text-xs text-primary outline-none placeholder:text-primary/35"
          />
        </div>

        <div className="max-h-72 overflow-y-auto overscroll-contain py-1">
          {models === undefined && (
            <p className="px-3 py-6 text-center text-xs text-primary/40">
              Loading models…
            </p>
          )}

          {models !== undefined && filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-primary/40">
              No model matches “{q}”
            </p>
          )}

          {shown.map((m) => (
            // Deliberately a plain button, not DropdownMenuItem: Radix items
            // grab focus on hover, which steals it back from the search input
            // after every keystroke.
            <button
              key={m.modelId}
              type="button"
              onClick={() => onChange(m.modelId)}
              className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-primary/5 ${
                value === m.modelId ? "bg-brand/10" : ""
              }`}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-primary/90">{m.name}</span>
                <span className="truncate font-geist-mono text-[10px] text-primary/40">
                  {m.modelId}
                </span>
                <span className="mt-0.5 text-[10px] text-primary/45">
                  {priceHint(m.promptPrice, m.completionPrice)}
                  {m.contextLength > 0 &&
                    ` · ${Math.round(m.contextLength / 1000)}k ctx`}
                  {m.vision && " · vision"}
                </span>
              </span>
              {value === m.modelId && (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-ink" />
              )}
            </button>
          ))}

          {hidden > 0 && (
            <p className="px-3 py-2 text-center text-[10px] text-primary/35">
              +{hidden} more — keep typing to narrow
            </p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
