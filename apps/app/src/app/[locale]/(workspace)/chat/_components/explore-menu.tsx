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
  Wand2,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

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
  anchorRef,
}: {
  /** Lifted so chat-layout can raise the stack and dim the greeting. */
  onOpenChange: (open: boolean) => void;
  onSelect: (seed: string) => void;
  disabled?: boolean;
  /**
   * The COMPOSER SHELL, which the panel is centred on and sized to.
   *
   * Radix anchors a menu to its trigger and exports no `Anchor` (Trigger /
   * Content / Portal only), and this trigger sits left-of-centre in the composer
   * — after the paperclip and the model picker — so an unadjusted panel lands
   * well right of centre. The correction is measured from this element rather
   * than hardcoded, because the trigger's own offset moves with the model
   * picker's label width ("DeepSeek V4 Flash" vs "GLM 5.2").
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // null until measured: the panel then falls back to its own width class and a
  // zero offset, i.e. exactly the pre-existing behaviour, rather than breaking.
  const [anchor, setAnchor] = useState<{ offset: number; width: number } | null>(
    null,
  );
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

  /**
   * Panel geometry, in the trigger's frame.
   *
   * `align="start"` is load-bearing and NOT interchangeable with `align="center"`:
   * Radix forwards `alignOffset` to floating-ui as `alignmentAxis`, which is
   * applied only `if (alignment && …)`. A centred placement has no alignment, so
   * the offset would be silently DISCARDED and the panel would not move at all.
   *
   * Matching the panel's width to the composer's is what removes the
   * `(composerWidth - panelWidth) / 2` term, so nothing here has to know the
   * panel's own width and no second copy of it can drift out of sync.
   *
   * LTR is assumed (locales are en/fr/es). Under RTL `align="start"` anchors the
   * RIGHT edges and this delta would need its sign flipped.
   */
  const measure = useCallback(() => {
    const shell = anchorRef?.current;
    const trigger = triggerRef.current;
    if (!shell || !trigger) return null;
    const s = shell.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    if (s.width === 0) return null;
    return { offset: Math.round(s.left - t.left), width: Math.round(s.width) };
  }, [anchorRef]);

  const change = useCallback(
    (next: boolean) => {
      // Measured HERE, in the open handler, and NOT in an effect. An effect runs
      // after the panel has already rendered, so the first open would paint at
      // offset 0 and then visibly snap across. Batched with setOpen, so the very
      // first render of the content already carries the right geometry.
      if (next) setAnchor(measure());
      setOpen(next);
      onOpenChange(next);
      if (!next) setHint(null);
    },
    [onOpenChange, measure],
  );

  // The composer is `mx-auto`, so its centre moves whenever the pane does.
  useEffect(() => {
    if (!open) return;
    const remeasure = () => setAnchor(measure());
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, [open, measure]);

  return (
    <>
      {/*
        THE DIM LIVES IN chat-layout, NOT HERE.

        A body-portalled overlay was tried and reverted: the chat pane is
        `relative isolate` (chat-layout, so this pane's own overlays stay
        contained), which makes it a stacking context. Anything at body level
        therefore paints above EVERYTHING inside it, and no z-index on the
        composer can escape its isolated ancestor — production showed the
        overlay covering the input. The overlay has to be a sibling inside that
        same context, which is what chat-layout does with the flag below.
      */}

      <DropdownMenu open={open} onOpenChange={change}>
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            // Kept in step with the visible label: an accessible name that says
            // something else fails WCAG 2.5.3 and breaks "click Skills" in voice
            // control. e2e/p-explore.js locates this button by this exact name.
            aria-label="Skills"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-primary/65 transition hover:bg-primary/5 hover:text-primary/80 disabled:opacity-40 [@media(pointer:coarse)]:min-h-11"
          >
            <Sparkles className="h-3 w-3" />
            Skills
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
          alignOffset={anchor?.offset ?? 0}
          sideOffset={12}
          collisionPadding={16}
          // Radix returns focus to the trigger when the menu closes, which
          // landed the caret on the Explore button instead of the composer it
          // had just seeded. The seed is only useful if the user can type.
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Inline width beats the class below; the class stays as the fallback
          // for the (defensive) unmeasured case.
          style={anchor ? { width: anchor.width } : undefined}
          className="workspace z-50 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] w-[min(46rem,calc(100vw-2rem))] overflow-hidden rounded-2xl p-0"
        >
          <div className="flex items-center justify-between border-b border-border bg-primary/[0.03] px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary/60">
              <LayoutGrid className="h-3.5 w-3.5" />
              AI capabilities
            </span>
            {/* No fill of its own. Stacked on the header's own 3% wash it made a
                #EBEBEB chip, and #6B6B6B on that is 4.47:1 - three hundredths under
                the bar, which is the kind of miss only a measurement finds. */}
            <span className="px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              ESC to close
            </span>
          </div>

          {/*
            Column-major: each column is its own DOM block, so Radix's LINEAR
            roving focus walks a column top-to-bottom and then moves to the next
            — which reads as the visual order. A row-major grid would make Down
            jump between columns.
          */}
          <div className="scrollbar-quiet grid max-h-[calc(70vh-6rem)] grid-cols-1 gap-x-1 overflow-y-auto overscroll-contain p-2 sm:grid-cols-3">
            {COLUMNS.map((col) => {
              const items = visible.filter((c) => c.column === col.key);
              if (items.length === 0) return null;
              return (
                <div key={col.key} className="min-w-0">
                  <div className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">
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

          {/*
            TWO DIFFERENT THINGS ARE CALLED "SKILLS", and this is where a user
            finds that out. Everything above is what this DEPLOYMENT can do:
            picking one types a starter prompt into the composer — it activates
            nothing and it is not owned by anyone. What the user WRITES lives in
            Settings. Naming the difference here is cheaper than letting someone
            hunt this menu for a skill they created.
          */}
          <DropdownMenuItem asChild>
            <Link
              href="/settings/skills"
              className="flex cursor-pointer items-center gap-2 border-t border-border px-4 py-2.5 text-[12px] text-primary/65 transition hover:text-primary/85"
            >
              <Wand2 className="h-3.5 w-3.5 shrink-0" />
              <span>
                Looking for skills you wrote? Manage them in{" "}
                <span className="font-medium text-primary/75">My Skills</span>.
              </span>
            </Link>
          </DropdownMenuItem>

          {/* ONE shared description line, not a card or tooltip per item. */}
          <div className="flex min-h-[2.75rem] items-center border-t border-border bg-primary/[0.03] px-4 py-2.5">
            <p className="line-clamp-2 text-[12px] leading-snug text-primary/60">
              {hint ?? (
                <span className="flex items-center gap-1.5 italic text-muted-foreground">
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
