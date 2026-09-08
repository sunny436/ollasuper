import { ChatPane } from "./_components/chat-pane";

/**
 * New-chat hero. threadId is null until the first message creates a thread.
 *
 * This is a SERVER component, so it receives searchParams directly -- no
 * useSearchParams, which would force a client-side-rendering bailout on this
 * route and need a Suspense boundary.
 *
 * ?project=<id> is how "New chat in Project" carries its Project through to the
 * first send. The value is passed on as a RAW STRING and is never trusted here:
 * threads.create resolves and authorizes it server-side.
 */
export default async function ChatIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{ project?: string }>;
}) {
  const sp = await searchParams;
  return <ChatPane threadId={null} pendingProjectId={sp?.project ?? null} />;
}
