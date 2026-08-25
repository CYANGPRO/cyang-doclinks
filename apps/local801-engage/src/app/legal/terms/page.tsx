import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/DesignSystem";

export const metadata: Metadata = {
  title: "Terms & Acceptable Use | Engaging Local 801",
  description: "Public terms and acceptable-use requirements for the Engaging Local 801 service.",
};

export default function TermsPage() {
  return <div className="content sign-in-content">
    <PageHeader
      eyebrow="Terms & acceptable use"
      title="Rules for using Engaging Local 801"
      description="These requirements apply to the Engaging Local 801 website and mobile applications. Last updated August 25, 2026."
    />
    <SectionCard title="Use CAT only for approved Local 801 work" description="CAT is not a public service.">
      <p>Use only the account approved for you, and only for work allowed by your role. Do not share an account, invitation, signed-in session, exported record, or access method with anyone else.</p>
    </SectionCard>
    <SectionCard title="Protect your account and Local 801 information" description="Every CAT user is responsible for following the workspace’s security and privacy rules.">
      <ul className="policy-list">
        <li>Protect your password, authentication method, recovery information, and signed-in devices.</li>
        <li>Do not send protected records through personal email, unapproved chat, screenshots, cloud drives, or other unapproved locations.</li>
        <li>Download or export information only when your role allows it, and keep it only in approved protected locations.</li>
        <li>Report suspected loss, disclosure, incorrect access, or account compromise promptly.</li>
        <li>Do not attempt to bypass authorization, interfere with service security, or access another person’s account or records.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Activity records and changes to access" description="CAT keeps records of important security and administrative activity.">
      <p>Access may be changed, suspended, or removed when a person’s responsibilities change, a security concern arises, or these rules are not followed. CAT features may also change as Local 801’s operational, security, legal, and records needs change.</p>
    </SectionCard>
    <SectionCard title="Questions" description="Ask before using protected information in a new way.">
      <p>If you are unsure whether an action is allowed, stop and ask Local 801 application support or an administrator. The Privacy Notice explains what information CAT uses and why.</p>
      <div className="page-actions">
        <Link className="button" href="/support">Contact support</Link>
        <Link className="button secondary" href="/legal/privacy">Read the privacy notice</Link>
      </div>
    </SectionCard>
  </div>;
}
