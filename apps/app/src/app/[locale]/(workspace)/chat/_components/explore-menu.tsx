"use client";

import { api } from "@v1/backend/convex/_generated/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@v1/ui/dropdown-menu";
import { useAction } from "convex/react";
import {
  BarChart,
  Briefcase,
  Code,
  DollarSign,
  FileOutput,
  FileText,
  Globe,
  LayoutGrid,
  Megaphone,
  PenTool,
  Search,
  Settings,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Explore — capability discovery above the composer.
 *
 * The landing screen advertises nothing by design (empty-state.tsx records that
 * the suggestion chips were removed for the minimal look), which leaves every
 * capability beyond plain chat undiscoverable. This adds one control and no
 * permanent surface: the idle screen is byte-identical until it is clicked.
 *
 * PRESENTATION LIVES HERE, AVAILABILITY COMES FROM THE SERVER. The label,
 * description, icon, column and starter prompt below are product copy; the
 * server returns only which capability IDS this deployment has. Deriving the
 * names from the server instead would render "Research Methodology / rigorous
 * multi-source research" where the design says "Research — Rigorous
 * multi-source, evidence-first research with cited synthesis", and would put
 * two sources of truth on the same user-facing string.
 *
 * SELECTING SEEDS THE COMPOSER. No persistent badge: what the user sees in the
 * box is exactly what will be sent, so the UI cannot imply a mode the backend
 * does not have.
 */

type Column = "business" | "tech" | "research";

type Capability = {
  id: string;
  label: string;
  desc: string;
  icon: typeof Search;
  column: Column;
  /** Dropped into the composer on select — editable, and visibly what is sent. */
  seed: string;
};

const COLUMNS: { key: Column; title: string }[] = [
  { key: "business", title: "Business & Strategy" },
  { key: "tech", title: "Tech & Data" },
  { key: "research", title: "Research & Content" },
];

const CAPABILITIES: Capability[] = [
  {
    id: "finance",
    label: "Finance",
    desc: "Statements, DCF valuation, forecasting, SaaS metrics & equity research.",
    icon: DollarSign,
    column: "business",
    seed: "Help me with a financial analysis. Here's the context: ",
  },
  {
    id: "sales",
    label: "Sales",
    desc: "Account research, call prep, pipeline review & competitive intelligence.",
    icon: Briefcase,
    column: "business",
    seed: "Help me with sales. Here's what I'm working on: ",
  },
  {
    id: "marketing",
    label: "Marketing",
    desc: "GTM strategy, positioning, paid media, CRO & marketing analytics.",
    icon: Megaphone,
    column: "business",
    seed: "Help me with marketing. Here's the context: ",
  },
  {
    id: "hr",
    label: "Human Resources",
    desc: "Recruiting, HR policies, compensation analysis & org planning.",
    icon: Users,
    column: "business",
    seed: "Help me with an HR task. Here's the situation: ",
  },
  {
    id: "ops",
    label: "Operations",
    desc: "Vendor evaluation, SOPs, resource planning & compliance tracking.",
    icon: Settings,
    column: "business",
    seed: "Help me with an operations task. Here's the context: ",
  },
  {
    id: "coding",
    label: "Coding",
    desc: "Write, debug & review software engineering code.",
    icon: Code,
    column: "tech",
    seed: "Help me with some code. Here's what I need: ",
  },
  {
    id: "data",
    label: "Data & Analytics",
    desc: "Analyze CSV/Excel data and create inline charts.",
    icon: BarChart,
    column: "tech",
    seed: "Analyse this data for me. (Attach a CSV or Excel file, then describe what you want to know.) ",
  },
  {
    id: "seo",
    label: "SEO & Web",
    desc: "Evidence-backed technical SEO audits and analysis.",
    icon: Zap,
    column: "tech",
    seed: "Run an SEO audit. Here's the page or site: ",
  },
  {
    id: "web",
    label: "Web Search",
    desc: "Current web information, news, prices and fast-changing data.",
    icon: Globe,
    column: "tech",
    seed: "Look up the latest on: ",
  },
  {
    id: "research",
    label: "Research",
    desc: "Rigorous multi-source, evidence-first research with cited synthesis.",
    icon: Search,
    column: "research",
    seed: "Research this thoroughly and cite your sources: ",
  },
  {
    id: "writing",
    label: "Content & Writing",
    desc: "Structured reports, blogs and content optimization.",
    icon: PenTool,
    column: "research",
    seed: "Write this for me. Here's the topic and audience: ",
  },
  {
    id: "docs",
    label: "Documents",
    desc: "Create PPTs, extract PDF data, OCR scans and merge files.",
    icon: FileOutput,
    column: "research",
    seed: "Help me with a document. Here's what I need: ",
  },
  {
    id: "files",
    label: "Files & Knowledge",
    desc: "Analyze uploaded files and search the OllaSuper knowledge base.",
    icon: FileText,
    column: "research",
    seed: "Using my uploaded files, ",
  },
];

const FALLBACK_HINT =
  "Hover over a capability to learn more, or select one to start.";

export function ExploreMenu({
  onOpenChange,
  onSelect,
  disabled,
}: {
  /** Lifted so chat-layout can raise the stack and dim the greeting. */
  onOpenChange: (open: boolean) => void;
  onSelect: (seed: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [fetched, setFetched] = useState(false);
  const listCapabilities = useAction(api.chat.capabilities.list);

  // Fetched LAZILY, on first open. A user who never clicks Explore pays nothing,
  // and the landing screen makes no request it did not need.
  useEffect(() => {
    if (!open || fetched) return;
    setFetched(true);
    void listCapabilities({})
      .then((ids) => setEnabled(ids ?? null))
      .catch(() => setEnabled(null));
  }, [open, fetched, listCapabilities]);

  // `enabled === null` means "not known yet, or the lookup failed" and shows the
  // full list. Discovery degrading to "may offer something unavailable" is far
  // better than an empty menu that says OllaSuper does nothing.
  const visible = enabled
    ? CAPABILITIES.filter((c) => enabled.includes(c.id))
    : CAPABILITIES;

  const change = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
      if (!next) setHint(null);
    },
    [onOpenChange],
  );

  return (
    <>
      {/*
        THE DIM LIVES IN chat-layout, NOT HERE.

        A body-portalled overlay was tried and reverted: the chat pane is
        `relative isolate` (chat-layout, so the ambience backdrop's -z-10 stays
        contained), which makes it a stacking context. Anything at body level
        therefore paints above EVERYTHING inside it, and no z-index on the
        composer can escape its isolated ancestor — production showed the
        overlay covering the input. The overlay has to be a sibling inside that
        same context, which is what chat-layout does with the flag below.
      */}

      <DropdownMenu open={open} onOpenChange={change}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Explore capabilities"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-primary/55 transition hover:bg-primary/5 hover:text-primary/80 disabled:opacity-40"
          >
            <Sparkles className="h-3 w-3" />
            Explore
          </button>
        </DropdownMenuTrigger>

        {/*
          `workspace` because Radix portals to document.body, outside the element
          that scopes the surface tokens — the same reason model-picker.tsx
          carries it. collisionPadding + max-h so a short viewport scrolls the
          panel instead of clipping it.
        */}
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={12}
          collisionPadding={16}
          // Radix returns focus to the trigger when the menu closes, which
          // landed the caret on the Explore button instead of the composer it
          // had just seeded. The seed is only useful if the user can type.
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="workspace z-50 max-h-[70vh] w-[min(46rem,calc(100vw-2rem))] overflow-hidden p-0"
        >
          <div className="flex items-center justify-between border-b border-border bg-primary/[0.03] px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary/45">
              <LayoutGrid className="h-3.5 w-3.5" />
              AI capabilities
            </span>
            <span className="rounded bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary/35">
              ESC to close
            </span>
          </div>

          {/*
            Column-major: each column is its own DOM block, so Radix's LINEAR
            roving focus walks a column top-to-bottom and then moves to the next
            — which reads as the visual order. A row-major grid would make Down
            jump between columns.
          */}
          <div className="grid max-h-[calc(70vh-6rem)] grid-cols-1 gap-x-1 overflow-y-auto overscroll-contain p-2 sm:grid-cols-3">
            {COLUMNS.map((col) => {
              const items = visible.filter((c) => c.column === col.key);
              if (items.length === 0) return null;
              return (
                <div key={col.key} className="min-w-0">
                  <div className="px-3 py-2 text-[11px] font-semibold text-primary/35">
                    {col.title}
                  </div>
                  {items.map((c) => {
                    const Icon = c.icon;
                    return (
                      <DropdownMenuItem
                        key={c.id}
                        // Hover AND focus: the reference only handles hover,
                        // which leaves a keyboard user with no description at
                        // all as they arrow through.
                        onFocus={() => setHint(`${c.label}: ${c.desc}`)}
                        onPointerEnter={() => setHint(`${c.label}: ${c.desc}`)}
                        onSelect={() => onSelect(c.seed)}
                        className="cursor-pointer gap-3 rounded-xl px-3 py-2"
                      >
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/5">
                          <Icon className="h-3.5 w-3.5 text-brand-ink" />
                        </span>
                        <span className="truncate text-[13px] font-medium text-primary/80">
                          {c.label}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* ONE shared description line, not a card or tooltip per item. */}
          <div className="flex min-h-[2.75rem] items-center border-t border-border bg-primary/[0.03] px-4 py-2.5">
            <p className="line-clamp-2 text-[12px] leading-snug text-primary/60">
              {hint ?? (
                <span className="flex items-center gap-1.5 italic text-primary/35">
                  <Sparkles className="h-3.5 w-3.5" />
                  {FALLBACK_HINT}
                </span>
              )}
            </p>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
