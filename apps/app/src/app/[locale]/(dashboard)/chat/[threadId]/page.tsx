import { ChatPane } from "../_components/chat-pane";

/**
 * Next 14 — `params` is sync here, not a Promise.
 *
 * The raw string is passed straight through. It must NOT be cast to
 * Id<"chatThreads">: every Convex function that takes it declares v.string()
 * and calls ctx.db.normalizeId, because a typo'd URL hitting a v.id() validator
 * throws ArgumentValidationError, which the Convex client logs via
 * console.error, which fails every e2e script's zero-console-error assertion.
 */
export default function ChatThreadPage({
  params,
}: {
  params: { locale: string; threadId: string };
}) {
  return <ChatPane threadId={params.threadId} />;
}
