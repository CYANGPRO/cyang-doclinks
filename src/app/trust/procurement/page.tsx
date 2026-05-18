import type { Metadata } from "next";
import { PolicyPageShell } from "@/app/components/PolicyPageShell";
import { DocumentIndexList, PremiumCard, Section, SectionHeader } from "@/app/components/PublicPrimitives";
import { SiteShell } from "@/app/components/SiteShell";
import InquiryForm from "@/app/contact/InquiryForm";
import { getSecurityEmail, getSupportEmail } from "@/lib/legal";

export const runtime = "nodejs";
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Procurement Package - cyang.io",
  description:
    "Procurement-ready trust package for cyang.io and Doclinks, including security, privacy, reliability, DPA, subprocessors, and disclosure surfaces.",
};

const DOCUMENTS = [
  { href: "/legal/security-policy", title: "Security Policy", body: "Customer-facing security posture and controls." },
  { href: "/legal/data-processing-addendum", title: "DPA", body: "Processor terms for business review." },
  { href: "/legal/subprocessors", title: "Subprocessors", body: "Vendor and data-processing transparency." },
  { href: "/legal/service-level-agreement", title: "SLA", body: "Availability commitment and credit process." },
  { href: "/privacy", title: "Privacy Policy", body: "Data handling baseline and rights information." },
  { href: "/terms", title: "Terms of Service", body: "Commercial and service framework." },
];

export default function ProcurementTrustPage() {
  const supportEmail = getSupportEmail();
  const securityEmail = getSecurityEmail();
  const legalEmail = "legal@cyang.io";

  return (
    <SiteShell maxWidth="full">
      <PolicyPageShell
        breadcrumbs={[
          { label: "cyang.io", href: "/" },
          { label: "Trust", href: "/trust" },
          { label: "Procurement Package" },
        ]}
        eyebrow="Procurement Package"
        title="Business-ready trust review, organized for speed."
        body="This page collects the core legal, privacy, security, and reliability documents buyers usually need when evaluating Doclinks or cyang.io."
        actions={[
          { href: "#procurement-request", label: "Request package", tone: "primary" },
          { href: "/contact", label: "Contact", tone: "secondary" },
        ]}
        meta={[
          { label: "Primary contact", value: legalEmail },
          { label: "Audience", value: "Security, legal, privacy, procurement, and IT reviewers" },
        ]}
        aside={
          <div className="space-y-3 text-sm text-[var(--text-secondary)]">
            <div>1. Review Security Policy, Privacy, and Terms for baseline fit.</div>
            <div>2. Move to DPA, SLA, and Subprocessors for deeper business review.</div>
            <div>3. Use contact routing for open procurement questions.</div>
          </div>
        }
      />

      <Section>
        <SectionHeader
          eyebrow="Document matrix"
          title="Core review documents, kept in one place."
          body="Use the list below to route security, privacy, procurement, and legal reviewers quickly."
        />
        <div className="mt-8">
          <DocumentIndexList items={DOCUMENTS} funnelAction="trust_doc_open" funnelLocation="procurement" />
        </div>
      </Section>

      <Section id="procurement-request">
        <InquiryForm
          source="procurement"
          defaultTopic="procurement"
          title="Request the package with context attached."
          body="Share the team, review stage, and what you need next. This keeps procurement follow-up attached to the right context instead of forcing buyers into a blank email."
          submitLabel="Request procurement follow-up"
        />
      </Section>

      <Section>
        <div className="grid gap-4 md:grid-cols-3">
          <PremiumCard>
            <div className="text-xl font-semibold text-slate-950">Security package</div>
            <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">Security policy, disclosure path, and public operational posture.</p>
          </PremiumCard>
          <PremiumCard>
            <div className="text-xl font-semibold text-slate-950">Privacy package</div>
            <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">Privacy, DPA, retention expectations, and subprocessor transparency.</p>
          </PremiumCard>
          <PremiumCard>
            <div className="text-xl font-semibold text-slate-950">Reliability package</div>
            <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">Status and SLA surfaces that keep operating expectations clear.</p>
          </PremiumCard>
        </div>
      </Section>

      <Section>
        <PremiumCard strong className="grid gap-4 md:grid-cols-3">
          <div>
            <div className="text-sm font-semibold text-slate-950">Legal</div>
            <div className="mt-2 text-sm text-[var(--text-secondary)]">{legalEmail}</div>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-950">Security</div>
            <div className="mt-2 text-sm text-[var(--text-secondary)]">{securityEmail}</div>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-950">Support</div>
            <div className="mt-2 text-sm text-[var(--text-secondary)]">{supportEmail}</div>
          </div>
        </PremiumCard>
      </Section>
    </SiteShell>
  );
}
