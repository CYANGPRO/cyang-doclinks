import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/DesignSystem";

export const metadata: Metadata = {
  title: "About | Engaging Local 801",
  description: "What Engaging Local 801 is, who it is for, and how it protects Local 801 information.",
};

export default function AboutPage() {
  return <div className="content sign-in-content">
    <PageHeader
      eyebrow="About"
      title="One place for Local 801 work"
      description="Engaging Local 801 brings membership, outreach, organizing, campaigns, documents, and CAT work together in a private workspace."
    />
    <SectionCard title="Who can use CAT" description="A Local 801 administrator must approve every account.">
      <p>CAT does not offer public sign-up. Each person signs in with the Microsoft account named in their invitation, completes MFA, and sees only the work allowed by their CAT role.</p>
    </SectionCard>
    <SectionCard title="What you can do" description="The pages you see depend on your role and assignments.">
      <ul className="policy-list">
        <li>Membership and employee directory review, protected contact information, and data-quality work.</li>
        <li>Assigned outreach, conversations, follow-ups, campaigns, CAT actions, and action-readiness history.</li>
        <li>Role-controlled documents, reports, notifications, and administrative audit records.</li>
        <li>Mobile and field work without storing protected member information offline.</li>
      </ul>
    </SectionCard>
    <SectionCard title="How CAT protects the work" description="Access is limited, important changes are recorded, and protected information stays in approved systems.">
      <p>CAT checks each person’s organization, role, and assignment before showing protected records. It records important security and administrative activity. CAT does not sell personal information or use member records for advertising.</p>
      <div className="page-actions">
        <Link className="button" href="/sign-in">Go to sign in</Link>
        <Link className="button secondary" href="/support">Get support</Link>
      </div>
    </SectionCard>
  </div>;
}
