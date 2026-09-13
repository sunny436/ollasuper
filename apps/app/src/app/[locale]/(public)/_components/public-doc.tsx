import Link from "next/link";
import type { ReactNode } from "react";

/** The one address every public page points support at. */
export const SUPPORT_EMAIL = "support@ollasuper.com";

/**
 * A plain, unauthenticated document page: privacy policy, support, connector
 * landing pages. Server-rendered, no client JS, no Convex — the pages an app
 * marketplace reviewer or a signed-out visitor must be able to open.
 */
export function PublicDoc({
  title,
  updated,
  children,
}: {
  title: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12 text-[15px] leading-7 text-foreground">
      <header className="mb-8 border-b pb-6">
        <Link href="/" className="text-sm font-medium text-muted-foreground">
          OllaSuper
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        {updated ? (
          <p className="mt-1 text-sm text-muted-foreground">Last updated: {updated}</p>
        ) : null}
      </header>
      <article className="space-y-6 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:underline">
        {children}
      </article>
      <footer className="mt-12 border-t pt-6 text-sm text-muted-foreground">
        <Link href="/privacy">Privacy</Link> · <Link href="/support">Support</Link> ·{" "}
        <Link href="/slack">Slack</Link> ·{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </footer>
    </main>
  );
}
