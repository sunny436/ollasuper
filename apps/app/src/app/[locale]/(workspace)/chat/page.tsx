import { ChatPane } from "./_components/chat-pane";

/** New-chat hero. threadId is null until the first message creates a thread. */
export default function ChatIndexPage() {
  return <ChatPane threadId={null} />;
}
