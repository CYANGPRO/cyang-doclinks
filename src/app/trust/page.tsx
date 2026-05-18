import type { Metadata } from "next";
import { ScrollRevealFrame } from "@/app/components/CinematicClient";
import { AmbientScene, SectionTransition, StoryBand, VisualSignalCluster } from "@/app/components/CinematicScene";
import {
  CTAGroup,
  ContentRail,
  DocumentIndexList,
  Eyebrow,
  LinkTile,
  PremiumCard,
  Section,
} from "@/app/components/PublicPrimitives";
import { SiteShell } from "@/app/components/SiteShell";

export const metadata: Metadata = {
  title: "Trust - cyang.io",
  description:
    "Review the security, legal, privacy, status, procurement, and disclosure surfaces behind Doclinks secure document sharing.",
};

const PILLARS = [
  {
    href: "/legal/security-policy",
    title: "Security",
    body: "The controls and review context behind secure document sharing with Doclinks.",
    meta: "Controls",
  },
  {
    href: "/privacy",
    title: "Privacy",
    body: "Data handling, retention expectations, and how privacy requests are routed.",
    meta: "Data handling",
  },
  {
    href: "/legal",
    title: "Legal",
    body: "Terms, processor commitments, acceptable use boundaries, and supporting policy references.",
    meta: "Policies",
  },
  {
    href: "/status",
    title: "Status",
    body: "Public continuity signals for the product, platform, and current operational state.",
    meta: "Operations",
  },
  {
    href: "/trust/procurement",
    title: "Procurement",
    body: "A buyer-ready route into review materials, diligence context, and follow-up paths.",
    meta: "Buyer review",
  },
  {
    href: "/security-disclosure",
    title: "Responsible Disclosure",
    body: "Clear expectations for vulnerability reporting and private coordination.",
    meta: "Disclosure",
  },
];

const PRINCIPLES = [
  "Access rules stay enforced by the server after the link is sent.",
  "Scan-gated delivery blocks unsafe file states before recipients can open them.",
  "Expiry and revocation reduce stale exposure on shared private documents.",
  "Public status, legal, and disclosure surfaces support real buyer review.",
];

const DOCUMENTS = [
  { href: "/terms", title: "Terms", body: "Service agreement, account obligations, and commercial baseline." },
  { href: "/privacy", title: "Privacy", body: "Data collection, usage, rights, and safeguards." },
  { href: "/acceptable-use", title: "Acceptable Use", body: "Platform safety rules and abuse boundaries." },
  { href: "/legal/data-processing-addendum", title: "DPA", body: "Controller and processor terms for business review." },
  { href: "/legal/service-level-agreement", title: "SLA", body: "Availability commitments and service credit process." },
  { href: "/legal/subprocessors", title: "Subprocessors", body: "Third-party processing transparency." },
  { href: "/data-retention", title: "Data Retention", body: "Lifecycle and retention expectations." },
  { href: "/legal/security-policy", title: "Security Policy", body: "Control summary and response posture." },
  { href: "/security-disclosure", title: "Security Disclosure", body: "Responsible disclosure workflow." },
  { href: "/report", title: "Abuse reporting", body: "Report malware, policy abuse, or suspicious sharing." },
];

export default function TrustPage() {
  return (
    <SiteShell maxWidth="full">
      <section className="cinematic-bleed relative overflow-hidden pt-10 sm:pt-16 lg:pt-20">
        <AmbientScene tone="steel" className="opacity-90" />
        <ContentRail className="relative">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.06fr)_360px] lg:items-end">
            <ScrollRevealFrame>
              <div className="max-w-4xl">
                <Eyebrow>Trust hub</Eyebrow>
                <h1 className="mt-6 max-w-4xl text-balance font-editorial text-5xl leading-[0.95] tracking-[-0.05em] text-slate-950 sm:text-6xl lg:text-[5.4rem]">
                  Review the controls behind Doclinks.
                </h1>
                <p className="mt-6 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  Doclinks is easier to trust because the supporting security, legal, privacy, status, and procurement
                  surfaces are visible now instead of being hidden behind a sales process.
                </p>
                <CTAGroup
                  className="mt-8"
                  actions={[
                    { href: "/doclinks", label: "See Doclinks", tone: "primary" },
                    { href: "/status", label: "View Status", tone: "secondary" },
                  ]}
                />
              </div>
            </ScrollRevealFrame>

            <ScrollRevealFrame delay={140}>
              <VisualSignalCluster
                title="Review posture"
                items={[
                  { label: "Product", value: "Secure document sharing with visible supporting controls." },
                  { label: "Buyer review", value: "Legal, privacy, and procurement routes stay easy to reach." },
                  { label: "Continuity", value: "Status and disclosure remain public when they matter." },
                ]}
                className="min-h-[320px]"
              />
            </ScrollRevealFrame>
          </div>
        </ContentRail>
      </section>

      <SectionTransition label="Trust pillars" />

      <Section className="pt-4 sm:pt-8">
        <ScrollRevealFrame>
          <StoryBand
            eyebrow="Six pillars"
            title="Organized around the questions serious reviewers actually ask."
            body="Each pillar leads to a concrete surface that helps a buyer, reviewer, or customer understand how Doclinks is run and what supports the product promise."
            aside={
              <div className="floating-stage relative min-h-[280px] overflow-hidden rounded-sm p-6">
                <AmbientScene tone="signal" className="opacity-80" />
                <div className="relative space-y-4">
                  {["Security", "Privacy", "Legal", "Status", "Procurement", "Disclosure"].map((item, index) => (
                    <div key={item} className="signal-row">
                      <div className="signal-index">{String(index + 1).padStart(2, "0")}</div>
                      <div className="text-sm text-[var(--text-secondary)]">{item}</div>
                    </div>
                  ))}
                </div>
              </div>
            }
          />
        </ScrollRevealFrame>

        <ScrollRevealFrame delay={120} className="mt-10">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {PILLARS.map((item) => (
              <LinkTile key={item.href} href={item.href} title={item.title} body={item.body} meta={item.meta} />
            ))}
          </div>
        </ScrollRevealFrame>
      </Section>

      <Section className="py-16 sm:py-20">
        <ScrollRevealFrame>
          <div className="floating-stage relative overflow-hidden rounded-sm px-6 py-10 sm:px-8 sm:py-14 lg:px-12">
            <AmbientScene tone="cool" className="opacity-85" />
            <div className="relative grid gap-8 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)] lg:items-start">
              <div className="max-w-2xl">
                <Eyebrow>Operating principles</Eyebrow>
                <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl lg:text-6xl">
                  The product promise is backed by visible operating behavior.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  The underlying ideas are straightforward: enforce the important rules centrally, limit document
                  lifetime and exposure, and keep the supporting public surfaces current enough to review with confidence.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {PRINCIPLES.map((item, index) => (
                  <PremiumCard key={item} className="min-h-[184px] bg-white/90">
                    <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <p className="mt-7 text-lg leading-8 text-[var(--text-secondary)]">{item}</p>
                  </PremiumCard>
                ))}
              </div>
            </div>
          </div>
        </ScrollRevealFrame>
      </Section>

      <SectionTransition label="Documents" />

      <Section className="pt-4 sm:pt-8">
        <ScrollRevealFrame>
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:items-start">
            <div className="max-w-2xl">
              <Eyebrow>Policy and document index</Eyebrow>
              <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
                The core review set, kept in one place.
              </h2>
              <p className="mt-5 text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                Use this as the fast route into the legal, privacy, security, and reporting documents most often needed
                when evaluating Doclinks for real document-sharing workflows.
              </p>
            </div>

            <DocumentIndexList items={DOCUMENTS} funnelAction="trust_doc_open" funnelLocation="trust" />
          </div>
        </ScrollRevealFrame>
      </Section>

      <Section className="pb-18 pt-16 sm:pb-24 sm:pt-20">
        <ScrollRevealFrame>
          <div className="floating-stage relative overflow-hidden rounded-sm px-6 py-10 sm:px-8 sm:py-14 lg:px-12">
            <AmbientScene tone="steel" className="opacity-80" />
            <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="max-w-3xl">
                <Eyebrow>Next step</Eyebrow>
                <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl lg:text-6xl">
                  Need product context, procurement help, or follow-up on the current review set?
                </h2>
                <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  The public trust shell is designed to answer most product-review questions quickly. For anything
                  specific, route into contact or live operational status.
                </p>
              </div>
              <CTAGroup
                actions={[
                  { href: "/doclinks", label: "See Doclinks", tone: "primary" },
                  { href: "/contact", label: "Contact", tone: "secondary" },
                  { href: "/status", label: "View Status", tone: "secondary" },
                ]}
              />
            </div>
          </div>
        </ScrollRevealFrame>
      </Section>
    </SiteShell>
  );
}
