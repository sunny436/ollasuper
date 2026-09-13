import type { Metadata } from "next";
import { PublicDoc, SUPPORT_EMAIL } from "../_components/public-doc";

export const metadata: Metadata = {
  title: "OllaSuper for Slack",
  description:
    "Ask OllaSuper's AI assistant about your Slack — search messages, read channels and threads, and post on your behalf.",
};

/** What the connector asks Slack for, in the user's words. Mirrors the operator
 *  scope allowlist; a scope not listed here is not requested. */
const PERMISSIONS: [string, string][] = [
  ["channels:read, groups:read, im:read, mpim:read", "See which channels and conversations you are in"],
  [
    "channels:history, groups:history, im:history, mpim:history",
    "Read messages in conversations you are a member of",
  ],
  ["search:read.public, search:read.private, search:read.im, search:read.mpim", "Search messages"],
  ["users:read", "Look up people in your workspace"],
  ["files:read", "Read files shared in conversations"],
  ["reactions:read", "See reactions on messages"],
  ["chat:write", "Send messages as you — only after you approve each one in chat"],
];

export default function SlackPage() {
  return (
    <PublicDoc title="OllaSuper for Slack">
      <p>
        Connect Slack to OllaSuper and ask the assistant, in plain language, about your
        workspace: <em>"What did the design channel decide yesterday?"</em>, <em>"Find the
        thread about the Q3 launch"</em>, <em>"Who is on the platform team?"</em>, or{" "}
        <em>"Post a summary of this conversation to #general"</em> — with every message you send
        approved by you first.
      </p>

      <h2>What it can do</h2>
      <ul>
        <li>Search public and private messages you have access to, and read channels and threads.</li>
        <li>List your channels and channel members; look up user profiles.</li>
        <li>Read files, canvases and lists shared with you.</li>
        <li>Send or schedule messages, add reactions, and create canvases or lists — each write is shown to you for approval before it runs.</li>
      </ul>
      <p>
        OllaSuper uses Slack's official MCP server. It acts as <strong>you</strong>: it can only
        see what your Slack account can see, and it only runs when one of your chat requests
        needs it — never in the background.
      </p>

      <h2>Install</h2>
      <ol>
        <li>
          Sign in at <a href="https://app.ollasuper.com">app.ollasuper.com</a> (or create an
          account).
        </li>
        <li>Open Settings → Connectors → Slack and click Connect.</li>
        <li>Sign in to your Slack workspace in the window that opens and click Allow.</li>
        <li>That's it — ask the assistant something about your Slack.</li>
      </ol>
      <p>
        Your workspace admin may need to approve OllaSuper first if your workspace restricts app
        installs; Slack shows a request button in that case.
      </p>

      <h2>Permissions it asks for</h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 pr-4 font-semibold">Slack scope</th>
            <th className="py-2 font-semibold">What it is for</th>
          </tr>
        </thead>
        <tbody>
          {PERMISSIONS.map(([scope, why]) => (
            <tr key={scope} className="border-b align-top">
              <td className="py-2 pr-4 font-mono text-xs">{scope}</td>
              <td className="py-2">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Disconnect</h2>
      <p>
        Settings → Connectors → Slack → Disconnect deletes the stored token immediately. You can
        also remove OllaSuper in Slack under Workspace settings → Apps. See the{" "}
        <a href="/privacy">Privacy Policy</a> for how connected-app data is handled.
      </p>

      <h2>Support</h2>
      <p>
        <a href="/support">Support page</a> · <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
    </PublicDoc>
  );
}
