import type { Metadata } from "next";
import { PublicDoc, SUPPORT_EMAIL } from "../_components/public-doc";

export const metadata: Metadata = {
  title: "Privacy Policy — OllaSuper",
  description: "How OllaSuper handles your account, conversations and connected apps.",
};

export default function PrivacyPage() {
  return (
    <PublicDoc title="Privacy Policy" updated="13 September 2026">
      <p>
        OllaSuper is a private AI workspace: you chat with an AI assistant, upload files,
        and can connect third-party apps (such as Slack, GitHub and Google) so the assistant
        can use them on your behalf. This policy explains what we collect, why, and what you
        control.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account</strong> — your email address and name, and the workspace you belong
          to. If you sign in with Google, we receive your Google account email and name.
        </li>
        <li>
          <strong>Conversations and files</strong> — the messages you send, the assistant's
          replies, and the files you upload. These are stored so you can return to them.
        </li>
        <li>
          <strong>Connected apps</strong> — when you connect an app, the app issues OllaSuper an
          access token. We store that token encrypted (AES-256-GCM, keys held only on our
          servers) and use it solely to act on your own requests.
        </li>
        <li>
          <strong>Operational logs</strong> — technical logs (timestamps, request identifiers,
          error types) needed to run and secure the service. Logs never contain your tokens or
          message contents.
        </li>
      </ul>

      <h2>How connected apps are used</h2>
      <p>
        A connected app is used only when one of your chat requests needs it — for example,
        asking the assistant to find a message in Slack, list your GitHub pull requests, or look
        up a place on Google Maps. The assistant calls the app's tools with your token, and the
        results become part of that conversation, which is stored like any other message. Tools
        that write (sending a message, creating an issue) require your explicit approval in the
        chat before they run.
      </p>
      <p>
        We request the narrowest permissions each app offers for what OllaSuper does. We do not
        read your data in the background, build profiles from it, or use it for advertising. We
        never sell personal data.
      </p>
      <p>
        <strong>Google user data.</strong> OllaSuper's use of information received from Google
        APIs adheres to the{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noreferrer"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Google user data is used only to provide the
        features you ask for in chat, is never transferred to others except as needed to provide
        those features, and is never used for advertising.
      </p>

      <h2>AI model providers</h2>
      <p>
        To generate replies, the content of your conversation — including any results a
        connected app returned for that request — is sent to the AI model providers we use as
        data processors. They process it to produce the reply and do not use it to train models
        under our agreements with them.
      </p>

      <h2>Your controls</h2>
      <ul>
        <li>
          <strong>Disconnect an app</strong> at any time in Settings → Connectors. Disconnecting
          deletes the stored token immediately. You can also revoke OllaSuper from the app's own
          side (Slack: Workspace settings → Apps; Google: myaccount.google.com → Security →
          Third-party access; GitHub: Settings → Applications).
        </li>
        <li>
          <strong>Delete conversations</strong> from the workspace; deleted conversations are
          removed from our database.
        </li>
        <li>
          <strong>Delete your account</strong> by emailing{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We delete your account data
          and tokens within 30 days.
        </li>
      </ul>

      <h2>Retention and security</h2>
      <p>
        Conversations and files are kept until you delete them. App tokens are kept until you
        disconnect the app. Data is stored on servers we operate, transmitted over TLS, and
        access is limited to what running the service requires.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We will update this page when our practices change. Questions about this policy or your
        data: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </PublicDoc>
  );
}
