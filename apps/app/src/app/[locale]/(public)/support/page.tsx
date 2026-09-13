import type { Metadata } from "next";
import { PublicDoc, SUPPORT_EMAIL } from "../_components/public-doc";

export const metadata: Metadata = {
  title: "Support — OllaSuper",
  description: "Get help with OllaSuper and its connected apps.",
};

export default function SupportPage() {
  return (
    <PublicDoc title="Support">
      <p>
        Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — no account needed. We
        answer within two business days. Include the app you were connecting (Slack, GitHub,
        Google…) and roughly when it happened, and we can look up what went wrong.
      </p>

      <h2>Connecting an app</h2>
      <ol>
        <li>Sign in to OllaSuper and open Settings → Connectors.</li>
        <li>Choose the app and click Connect.</li>
        <li>Sign in to the app in the window that opens and approve the access it lists.</li>
        <li>Back in OllaSuper the app shows Connected, with the tools it offers.</li>
      </ol>

      <h2>Common questions</h2>
      <h3>"Authentication required" or "Waiting for authorization"</h3>
      <p>
        The sign-in window was closed before finishing, or the app withdrew access. Click the
        action on the connector page to sign in again.
      </p>
      <h3>The assistant says it cannot reach an app</h3>
      <p>
        Open Settings → Connectors and check the app's status. If it shows an error, use Retry;
        if that fails, Disconnect and Connect again. If the app itself is restricting access
        (for example a Slack workspace that requires admin approval for apps), the message from
        the app is shown on the connector page.
      </p>
      <h3>Disconnecting and removing access</h3>
      <p>
        Settings → Connectors → the app → Disconnect. This deletes the stored token at once. You
        can also remove OllaSuper from the app's own settings; see the{" "}
        <a href="/privacy">Privacy Policy</a> for where.
      </p>
      <h3>Slack</h3>
      <p>
        See the <a href="/slack">Slack connector page</a> for what it can do, the permissions it
        asks for, and how to install it in your workspace.
      </p>
    </PublicDoc>
  );
}
