import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/DesignSystem";

export const metadata: Metadata = {
  title: "About | Engaging Local 801",
  description: "Purpose, audience, and operating principles for the Engaging Local 801 workspace.",
};

export default function AboutPage() {
  return <div className="content sign-in-content">
    <PageHeader
      eyebrow="About"
      title="A private workspace for Local 801 work"
      description="Engaging Local 801 helps approved users coordinate membership, representation, organizing, outreach, campaigns, documents, and CAT work in one protected service."
    />
    <SectionCard title="Who the service is for" description="Access is limited to people approved by Local 801 administrators.">
      <p>There is no public registration. Each user signs in through the approved Microsoft Entra guest identity, completes required verification, and receives only the permissions assigned to their CAT role.</p>
    </SectionCard>
    <SectionCard title="What the service supports" description="The workspace brings related Local 801 operations together without making protected records public.">
      <ul className="policy-list">
        <li>Membership and employee directory review, protected contact information, and data-quality work.</li>
        <li>Assigned outreach, conversations, follow-ups, campaigns, CAT actions, and action-readiness history.</li>
        <li>Role-controlled documents, reports, notifications, and administrative audit records.</li>
        <li>Mobile and field workflows that keep protected member information online and access controlled.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Operating principles" description="Privacy, least-privilege access, and accountable changes guide the service.">
      <p>CAT restricts access by organization and role, records security-relevant activity, and uses protected storage and identity services configured for Local 801. It does not sell personal information or use member records for advertising.</p>
      <div className="page-actions">
        <Link className="button" href="/sign-in">Go to sign in</Link>
        <Link className="button secondary" href="/support">Get support</Link>
      </div>
    </SectionCard>
  </div>;
}
