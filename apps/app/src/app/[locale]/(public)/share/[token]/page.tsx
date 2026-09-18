import { api } from "@v1/backend/convex/_generated/api";
import { fetchQuery } from "convex/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import { Markdown } from "@/app/[locale]/(workspace)/chat/_components/markdown";
import { ShareAttachment } from "./_components/share-attachment";

// Server-side Convex URL (internal on the VM, public elsewhere) — mirrors middleware.
const SERVER_CONVEX_URL =
  process.env.CONVEX_SERVER_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;

/** Browser-reachable Convex SITE origin, where the /share/file proxy lives. */
function convexSite(): string {
  const u = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  if (u.includes("/__cvx")) return u.replace("/__cvx", "/__cvx-site");
  return u.replace(/\.convex\.cloud$/, ".convex.site");
}

type ShareResult =
  | { state: "invalid" | "revoked" | "expired" }
  | {
      state: "ok";
      share: {
        type: "full_chat" | "single_turn";
        title: string;
        createdAt: number;
        expiresAt: number;
        messages: {
          role: "user" | "assistant";
          content: string;
          attachments: {
            name: string;
            contentType: string;
            kind: string;
            size: number;
          }[];
        }[];
      };
    };

async function load(token: string): Promise<ShareResult> {
  try {
    return (await fetchQuery(
      api.chat.shares.getByToken,
      { token },
      { url: SERVER_CONVEX_URL },
    )) as ShareResult;
  } catch {
    return { state: "invalid" };
  }
}

const DESCRIPTION = "A shared AI conversation.";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const res = await load(token);
  // Never index shared pages; never put message content in metadata.
  const robots = { index: false, follow: false };
  if (res.state !== "ok") {
    return { title: "Shared conversation", description: DESCRIPTION, robots };
  }
  const title = res.share.title?.trim() || "Shared conversation";
  return {
    title,
    description: DESCRIPTION,
    robots,
    // og:image comes from the colocated opengraph-image.tsx, which Next merges
    // in automatically. It used to be "/logo.png" - a 1.6 MB raster of the old mark.
    openGraph: {
      title,
      description: DESCRIPTION,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: DESCRIPTION,
    },
  };
}

/** Fixed UTC so server render == any later render (no hydration mismatch). */
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function StatePage({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="workspace flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-medium text-primary">{heading}</h1>
        <p className="mt-2 text-sm text-primary/60">{body}</p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition hover:opacity-90"
        >
          Start your own chat
        </Link>
      </div>
    </div>
  );
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const res = await load(token);
  if (res.state === "expired") {
    return (
      <StatePage
        heading="This shared link has expired"
        body="Shared links are available for 7 days. Ask the owner for a fresh link."
      />
    );
  }
  if (res.state === "revoked") {
    return (
      <StatePage
        heading="This shared link is no longer available"
        body="The owner has revoked access to this conversation."
      />
    );
  }
  if (res.state !== "ok") {
    return (
      <StatePage
        heading="Shared conversation not found"
        body="This link is invalid or has been removed."
      />
    );
  }

  const { share } = res;
  const site = convexSite();

  return (
    <div className="workspace min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <header className="mb-8 border-b border-border pb-6">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-ink">
            {share.type === "single_turn"
              ? "Shared response"
              : "Shared conversation"}
          </p>
          <h1 className="mt-1 text-2xl font-medium text-primary">
            {share.title?.trim() || "Shared conversation"}
          </h1>
          <p className="mt-2 text-xs text-primary/65">
            Shared on {fmtDate(share.createdAt)} · read-only
          </p>
        </header>

        <div className="space-y-7">
          {share.messages.map((m, mi) =>
            m.role === "user" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static frozen snapshot
              <div key={mi} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-[15px] leading-[1.7] text-brand-foreground">
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  {m.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.attachments.map((a, ai) => (
                        <ShareAttachment
                          // biome-ignore lint/suspicious/noArrayIndexKey: static list
                          key={ai}
                          att={a}
                          url={`${site}/share/file?t=${token}&m=${mi}&a=${ai}`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: static frozen snapshot
              <div key={mi} className="w-full">
                <Markdown content={m.content} streaming={false} />
                {m.attachments.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {m.attachments.map((a, ai) => (
                      <ShareAttachment
                        // biome-ignore lint/suspicious/noArrayIndexKey: static list
                        key={ai}
                        att={a}
                        url={`${site}/share/file?t=${token}&m=${mi}&a=${ai}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
        </div>

        <footer className="mt-12 border-t border-border pt-6 text-center">
          <p className="text-xs text-primary/60">
            This is a read-only shared conversation.
          </p>
          <Link
            href="/"
            className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition hover:opacity-90"
          >
            Start your own chat
          </Link>
        </footer>
      </div>
    </div>
  );
}
