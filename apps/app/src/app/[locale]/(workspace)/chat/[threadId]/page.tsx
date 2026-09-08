import { ChatPane } from "../_components/chat-pane";

/**
 * Next 15 — `params` is a Promise and must be awaited.
 *
 * The raw string is passed straight through. It must NOT be cast to
 * Id<"chatThreads">: every Convex function that takes it declares v.string()
 * and calls ctx.db.normalizeId, because a typo'd URL hitting a v.id() validator
 * throws ArgumentValidationError, which the Convex client logs via
 * console.error, which fails every e2e script's zero-console-error assertion.
 */
export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ locale: string; threadId: string }>;
}) {
  const { threadId } = await params;
  return <ChatPane threadId={threadId} />;
}
