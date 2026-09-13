import type { Metadata } from "next";
import { PublicDoc, SUPPORT_EMAIL } from "../_components/public-doc";

export const metadata: Metadata = {
  title: "Terms of Service — OllaSuper",
  description: "The terms under which OllaSuper is provided.",
};

export default function TermsPage() {
  return (
    <PublicDoc title="Terms of Service" updated="13 September 2026">
      <p>
        These terms apply to your use of OllaSuper at app.ollasuper.com (the "Service"). By
        creating an account or using the Service you agree to them. If you use the Service on
        behalf of an organisation, you confirm you may bind that organisation.
      </p>

      <h2>The Service</h2>
      <p>
        OllaSuper is an AI workspace: a chat assistant, file storage, and optional connections to
        third-party apps (such as Slack, GitHub and Google) that the assistant can use on your
        behalf. AI output can be wrong; review it before relying on it, especially before letting
        the assistant post or change anything in a connected app.
      </p>

      <h2>Your account and content</h2>
      <ul>
        <li>You are responsible for your account credentials and for what is done with them.</li>
        <li>
          You keep ownership of the content you upload and the conversations you create. You grant
          us only the rights needed to store, process and display that content to provide the
          Service, as described in the <a href="/privacy">Privacy Policy</a>.
        </li>
        <li>
          You may only connect third-party accounts you are authorised to use, and you are bound by
          those services' own terms when the assistant acts on them for you.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <p>
        Do not use the Service to break the law, to access data you are not authorised to access,
        to send spam or abusive messages through connected apps, to probe or disrupt the Service or
        third-party services, or to attempt to extract other users' data. We may suspend accounts
        that do.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We work to keep the Service available but do not guarantee uninterrupted operation, and we
        may change or discontinue features. Third-party services may change or withdraw their
        integrations at any time; we are not responsible for their availability.
      </p>

      <h2>Fees</h2>
      <p>
        Where a paid plan applies, its price and billing terms are shown before you subscribe.
        Otherwise the Service is provided free of charge.
      </p>

      <h2>Disclaimer and liability</h2>
      <p>
        The Service is provided "as is". To the fullest extent permitted by law we disclaim implied
        warranties and are not liable for indirect or consequential loss, or for loss arising from
        AI output or actions the assistant took at your request. Our total liability for any claim
        is limited to the amount you paid for the Service in the twelve months before the claim.
      </p>

      <h2>Termination</h2>
      <p>
        You may stop using the Service and request deletion of your account at any time (see the
        Privacy Policy). We may suspend or terminate accounts that breach these terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </PublicDoc>
  );
}
