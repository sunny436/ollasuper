"use client";

import { ThemeToggle } from "@/components/theme-toggle";
import { ACCENTS, type AccentName } from "@/lib/theme/accent";
import { useTheme } from "@/lib/theme/theme-provider";
import { Check } from "lucide-react";

/**
 * Settings → Appearance.
 *
 * The light/dark control here is the SAME <ThemeToggle/> the chat header mounts,
 * rendered a second time. It holds no state — useTheme() owns the mode — so the
 * two instances cannot disagree, and the header toggle is untouched: nothing was
 * moved and nothing was removed.
 *
 * Accent writes through useTheme().setAccent, which applies it immediately and
 * caches it; ThemeSync persists it to chatSettings on the next tick. There is no
 * Save button because there is nothing to commit — the preview IS the setting.
 */
export default function AppearanceSection() {
  const { accent, setAccent } = useTheme();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          Appearance
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How OllaSuper looks. These settings are independent — changing one
          never changes the other.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-primary">Theme</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Light or dark. Also on the chat header, and Ctrl/Cmd+Shift+L.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-medium text-primary">Accent colour</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Used for buttons, selected items and highlights. Status colours,
          charts and the OllaSuper mark keep their own colours.
        </p>

        {/*
          A native radio group, not hand-rolled role="radio" buttons: arrow-key
          traversal, roving focus and the screen-reader group semantics all come
          from the platform, already correct, in every browser.

          Selection is marked by a ring AND a check glyph — never by hue alone,
          which would be invisible at Neutral and to a colour-blind user.
        */}
        <fieldset className="mt-4">
          <legend className="sr-only">Accent colour</legend>
          <div className="flex flex-wrap gap-3">
            {ACCENTS.map(({ name, label }) => {
              const selected = accent === name;
              return (
                <label
                  key={name}
                  className="group flex cursor-pointer flex-col items-center gap-1.5"
                >
                  <input
                    type="radio"
                    name="accent"
                    value={name}
                    checked={selected}
                    onChange={() => setAccent(name as AccentName)}
                    className="sr-only peer"
                  />
                  <span
                    aria-hidden
                    // `data-accent` on the swatch itself scopes the palette
                    // variables to this element, so each swatch paints its own
                    // accent without a single hard-coded colour here.
                    data-accent={name}
                    className="grid h-10 w-10 place-items-center rounded-full bg-brand ring-offset-2 ring-offset-card transition peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-checked:ring-2 peer-checked:ring-primary"
                  >
                    {selected ? (
                      <Check className="h-4 w-4 text-brand-foreground" />
                    ) : null}
                  </span>
                  <span
                    className={`text-[11px] ${selected ? "font-medium text-primary" : "text-muted-foreground"}`}
                  >
                    {label}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </section>
    </div>
  );
}
