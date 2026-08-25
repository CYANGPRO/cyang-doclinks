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
      title="Conditions for using Engaging Local 801"
      description="These requirements apply to the Engaging Local 801 website and mobile applications. Last updated August 25, 2026."
    />
    <SectionCard title="Authorized use only" description="The service is provided for approved Local 801 work, not general public use.">
      <p>You may access CAT only with the account approved for you and only for work permitted by your assigned role. Do not share an account, invitation, session, exported record, or access method with another person.</p>
    </SectionCard>
    <SectionCard title="Protect accounts and information" description="Users are responsible for following the workspace’s security and privacy requirements.">
      <ul className="policy-list">
        <li>Protect your password, authentication method, recovery information, and signed-in devices.</li>
        <li>Do not send protected records through personal email, unapproved chat, screenshots, cloud drives, or other unapproved locations.</li>
        <li>Use downloads and exports only when your role permits them and retain them only in approved protected locations.</li>
        <li>Report suspected loss, disclosure, incorrect access, or account compromise promptly.</li>
        <li>Do not attempt to bypass authorization, interfere with service security, or access another person’s account or records.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Records and service operation" description="Authorized activity may be retained for accountability and organizational requirements.">
      <p>Security-relevant and administrative activity is audited. Access may be changed, suspended, or removed when authorization changes, a security concern arises, or these requirements are not followed. Service features may change as Local 801 operational, security, legal, and records requirements evolve.</p>
    </SectionCard>
    <SectionCard title="Questions" description="Ask before using protected information in a new way.">
      <p>If you are unsure whether an action is permitted, stop and contact Local 801 application support or an administrator. The Privacy Notice explains what information the service processes and why.</p>
      <div className="page-actions">
        <Link className="button" href="/support">Contact support</Link>
        <Link className="button secondary" href="/legal/privacy">Read the privacy notice</Link>
      </div>
    </SectionCard>
  </div>;
}
