"use client";

import { createI18nClient } from "next-international/client";

const locales = {
  en: () => import("./en"),
  fr: () => import("./fr"),
  es: () => import("./es"),
};

export const {
  useI18n,
  useScopedI18n,
  I18nProviderClient,
  useChangeLocale,
  useCurrentLocale,
} = createI18nClient(locales);

/**
 * Warm a dictionary chunk before the route that needs it mounts.
 *
 * I18nProviderClient `use()`s the dynamic import above and suspends the WHOLE
 * settings shell (sidebar and section) until that chunk has arrived — on the
 * first Settings visit of a session that was one extra round trip between the
 * URL changing and anything painting (~300 ms from the US, more from India).
 * The chunk is 1 KB; loading it when the account menu opens (the only way
 * into Settings from the workspace) makes the later import resolve from
 * webpack's chunk registry. The provider is untouched.
 */
export function preloadLocale(locale: string | undefined): void {
  const load = locales[locale as keyof typeof locales];
  if (load) void load().catch(() => {});
}
