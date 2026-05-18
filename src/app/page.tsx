import type { Metadata } from "next";
import { BackgroundVideoSection, ScrollRevealFrame } from "./components/CinematicClient";
import { AmbientScene, SectionTransition, StoryBand, VisualSignalCluster } from "./components/CinematicScene";
import {
  ArrowLink,
  CTAGroup,
  ComparisonMatrix,
  ContentRail,
  DocumentIndexList,
  DocumentVisual,
  Eyebrow,
  Lead,
  ProofStepBand,
  Section,
  SenderRecipientProof,
  UseCaseClusterGrid,
} from "./components/PublicPrimitives";
import { ProductWalkthrough } from "./components/ProductWalkthrough";
import { SiteShell } from "./components/SiteShell";
import { getPublicRuntimeConfig } from "@/lib/publicRuntimeConfig";

export const revalidate = 900;

export const metadata: Metadata = {
  title: "cyang.io - Send private documents without losing control",
  description:
    "Doclinks helps teams send private documents through protected links, keep control after sending, and give recipients a calmer, more professional delivery flow.",
};

const TRUST_DOCUMENTS = [
  { href: "/status", title: "Status", body: "Public operational health and updates." },
  { href: "/trust", title: "Trust Center", body: "A structured review path for controls, privacy, and operations." },
  { href: "/legal", title: "Legal Center", body: "Terms, privacy, DPA, SLA, and policy documentation." },
  { href: "/security-disclosure", title: "Security Disclosure", body: "Responsible disclosure expectations and contact routes." },
  { href: "/data-retention", title: "Data Retention", body: "Lifecycle and retention expectations for files and records." },
  { href: "/trust/procurement", title: "Procurement Package", body: "Fast path for business, legal, and security review." },
];

const HOW_IT_WORKS_STEPS = [
  {
    title: "Upload",
    body: "Start with a secure path built for contracts, records, financial files, and other private documents.",
    signal: "Validated path",
  },
  {
    title: "Protect",
    body: "Set expiry, revoke access, bound views, and decide whether download is allowed before you send.",
    signal: "Policy attached",
  },
  {
    title: "Share",
    body: "Send a protected link instead of an attachment or a generic file URL that keeps drifting around.",
    signal: "Clean recipient UX",
  },
  {
    title: "Control after send",
    body: "Serve-time checks, scan-gated release, and delivery visibility keep the sender in control after delivery starts.",
    signal: "Serve-time enforced",
  },
];

const AUDIENCE_ITEMS = [
  {
    title: "Finance and operations",
    body: "For invoices, statements, closing documents, and records that should not bounce around as attachments.",
  },
  {
    title: "HR and people workflows",
    body: "For onboarding, records, and sensitive personnel documents that need a more deliberate delivery path.",
  },
  {
    title: "Legal and compliance-heavy teams",
    body: "For contracts, notices, and review materials where control, retention, and follow-up matter.",
  },
  {
    title: "Small businesses with private client records",
    body: "For firms that need a more professional, controlled delivery path without enterprise complexity.",
  },
];

export default function HomePage() {
  const publicConfig = getPublicRuntimeConfig();
  const primaryAccessHref = publicConfig.signupEnabled ? "/signup" : "/signin?intent=admin";

  return (
    <SiteShell maxWidth="full" publicConfig={publicConfig}>
      <BackgroundVideoSection
        src="/media/cyang-hero-atmosphere.mp4"
        poster="/media/cyang-hero-atmosphere.jpg"
        priority
        className="mt-3 min-h-[96svh] border-b border-[var(--border-subtle)]"
        contentClassName="min-h-[96svh]"
      >
        <AmbientScene tone="cool" />
        <div className="mx-auto flex min-h-[96svh] w-full max-w-[1600px] flex-col justify-between px-4 pb-10 pt-18 sm:px-6 sm:pb-12 lg:px-8 lg:pt-24">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.08fr)_360px] lg:items-end">
            <ScrollRevealFrame className="max-w-5xl">
              <Eyebrow>Doclinks by cyang.io</Eyebrow>
              <h1 className="font-editorial mt-6 text-balance text-[3.25rem] leading-[0.9] tracking-[-0.06em] text-slate-950 sm:text-[4.75rem] lg:text-[7.5rem]">
                Send private documents
                <span className="block text-[var(--text-muted)]">without losing control after send.</span>
              </h1>
              <Lead className="mt-6 max-w-2xl text-base sm:text-xl">
                Built for contracts, HR records, financial files, and client-facing documents that need more control
                than an attachment and a calmer experience than a generic file link.
              </Lead>
              <CTAGroup
                className="mt-8"
                actions={[
                  { href: primaryAccessHref, label: publicConfig.signupEnabled ? "Get started" : "Sign in", tone: "primary" },
                  {
                    href: "/doclinks#sample-flow",
                    label: "See the product flow",
                    tone: "secondary",
                  },
                ]}
              />
              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[var(--text-secondary)]">
                <span>For finance, HR, legal, and operations</span>
                <span>Protected links instead of loose files</span>
                <span>Expiry, revocation, and visibility stay available</span>
              </div>
              <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {publicConfig.showPricingUi ? <ArrowLink href="/pricing">Review pricing</ArrowLink> : null}
                <ArrowLink href="/trust">Review trust</ArrowLink>
                <ArrowLink href="/doclinks#sample-flow">See a sample flow</ArrowLink>
              </div>
            </ScrollRevealFrame>

            <ScrollRevealFrame delay={120} className="floating-stage p-6 sm:p-7">
              <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">What visitors should know first</div>
              <div className="mt-4 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
                One product, one promise: send the file and keep the control layer.
              </div>
              <p className="mt-4 text-sm leading-7 text-[var(--text-secondary)]">
                Doclinks is the flagship product. It exists for sensitive document delivery where the sender still
                needs policy control after the link has been shared.
              </p>
              <div className="story-seam mt-6 h-28" />
              <VisualSignalCluster
                className="mt-4"
                title="Immediate signals"
                items={[
                  { label: "Use case", value: "Private document delivery" },
                  { label: "Why it wins", value: "Control stays with the sender" },
                  { label: "Why trust it", value: "Trust surfaces are public and reviewable" },
                ]}
              />
            </ScrollRevealFrame>
          </div>

          <ScrollRevealFrame delay={220} className="mt-10">
            <div className="grid gap-4 border-t border-[var(--border-subtle)] pt-5 sm:grid-cols-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">What it is</div>
                <div className="mt-2 text-lg text-[var(--text-primary)]">Protected delivery for private documents</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">What changes</div>
                <div className="mt-2 text-lg text-[var(--text-primary)]">Expiry, revocation, and serving rules stay in play</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">Why trust it</div>
                <div className="mt-2 text-lg text-[var(--text-primary)]">Trust, legal, status, and disclosure are visible now</div>
              </div>
            </div>
          </ScrollRevealFrame>
        </div>
      </BackgroundVideoSection>

      <SectionTransition label="Flagship reveal" />

      <Section className="py-20 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-end">
              <div className="hidden lg:block">
                <div className="editorial-kicker">DOC</div>
              </div>
              <StoryBand
                eyebrow="Why this exists"
                title={
                  <>
                    Email attachments end too early.
                    <span className="block text-[var(--text-muted)]">Sensitive document delivery should not.</span>
                  </>
                }
                body="Doclinks exists for teams that still need to send private files outside their workspace but do not want access, timing, or recipient behavior to become guesswork the moment a file is shared."
                aside={
                  <div className="floating-stage p-5 sm:p-6">
                    <DocumentVisual
                      rows={[
                        { label: "Private files", value: "Contracts, records, financial docs", tone: "accent" },
                        { label: "Delivery state", value: "Protected link instead of loose attachment", tone: "neutral" },
                        { label: "Sender control", value: "Expiration and revocation stay available", tone: "warm" },
                      ]}
                      footer="The point is simple: send the file, keep the control layer."
                    />
                  </div>
                }
              >
                <CTAGroup
                  actions={[
                    { href: "/doclinks", label: "See how Doclinks works", tone: "primary" },
                    {
                      href: publicConfig.showPricingUi ? "/pricing" : "/trust",
                      label: publicConfig.showPricingUi ? "View pricing" : "Review Trust",
                      tone: "secondary",
                    },
                  ]}
                />
              </StoryBand>
            </div>
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <SectionTransition label="How it works" />

      <Section className="py-20 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-end">
              <div className="max-w-3xl">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">How it works</div>
                <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl lg:text-6xl">
                  A cleaner sharing flow with visible control at every step.
                </h2>
                <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  The product flow stays simple for the sender and calm for the recipient, while the important rules
                  remain enforced by the system.
                </p>
              </div>
              <DocumentVisual
                rows={[
                  { label: "Upload", value: "Validated", tone: "accent" },
                  { label: "Protection", value: "Expiry, revocation, views", tone: "warm" },
                  { label: "Delivery", value: "Protected link", tone: "neutral" },
                  { label: "After send", value: "Visibility still available", tone: "neutral" },
                ]}
                footer="A simple sender flow backed by real enforcement instead of wishful sharing behavior."
              />
            </div>
          </ScrollRevealFrame>

          <ScrollRevealFrame delay={120} className="mt-10">
            <ProofStepBand steps={HOW_IT_WORKS_STEPS} />
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <SectionTransition label="Product proof" />

      <Section id="sample-flow" className="py-20 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="max-w-3xl">
              <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Product proof</div>
              <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl lg:text-6xl">
                Show the control layer instead of asking visitors to imagine it.
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                Doclinks is not just a file link. The sender chooses the rules, the recipient gets a clean experience,
                and the system keeps the important decisions at serve time.
              </p>
            </div>
          </ScrollRevealFrame>

          <ScrollRevealFrame delay={90} className="mt-10">
            <ProductWalkthrough />
          </ScrollRevealFrame>

          <ScrollRevealFrame delay={120} className="mt-10">
            <SenderRecipientProof
              sender={{
                title: "The sender keeps the levers that matter.",
                body: "Choose how the document can be opened, how long it stays valid, and whether delivery remains available after the workflow ends.",
                chips: ["Expiry", "Revocation", "Download allowed / blocked", "Bounded views", "Scan-gated release"],
                proof: [
                  "Set an expiry date instead of leaving the link open-ended.",
                  "Revoke access immediately if the workflow changes.",
                  "Allow or block download depending on the document.",
                  "Keep delivery activity visible enough for real follow-up.",
                ],
              }}
              recipient={{
                title: "The recipient sees a calm, professional delivery flow.",
                body: "Recipients get a focused viewing experience instead of a messy file-sharing interface, while the server keeps checking the current policy state.",
                chips: ["Clean access page", "Professional viewing", "No noisy dashboard", "Serve-time checks"],
                proof: [
                  "Protected link opens into a clear branded delivery page.",
                  "Unsafe or unscanned files fail closed before release.",
                  "Access decisions happen in real time, not just when the link was created.",
                ],
              }}
            />
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <SectionTransition label="Who it is for" />

      <Section className="py-18 sm:py-22">
        <ContentRail>
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <ScrollRevealFrame>
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Who it is for</div>
                <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl">
                  For people who cannot afford careless sharing.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  Doclinks is designed for real business workflows where a file still needs to move, but the sender wants
                  a more controlled path than inbox forwarding or generic file storage links.
                </p>
              </div>
            </ScrollRevealFrame>

            <ScrollRevealFrame delay={120}>
              <UseCaseClusterGrid items={AUDIENCE_ITEMS} />
            </ScrollRevealFrame>
          </div>
        </ContentRail>
      </Section>

      <SectionTransition label="Proof architecture" />

      <Section className="py-20 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="floating-stage overflow-hidden p-6 sm:p-8 lg:p-10">
              <AmbientScene tone="signal" className="opacity-75" />
              <div className="relative grid gap-8 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Trust and proof</div>
                  <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl lg:text-6xl">
                    Trust proof that supports the product story.
                  </h2>
                  <p className="mt-5 max-w-xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                    Security, legal, status, disclosure, retention, and procurement are all available because secure
                    sharing only feels credible when the company is reviewable too.
                  </p>
                </div>
                <DocumentIndexList items={TRUST_DOCUMENTS} funnelAction="trust_doc_open" funnelLocation="trust" />
              </div>
            </div>
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <BackgroundVideoSection
        src="/media/cyang-doclinks-signal.mp4"
        poster="/media/cyang-doclinks-signal.jpg"
        className="min-h-[70svh] border-t border-[var(--border-subtle)]"
        contentClassName="min-h-[70svh]"
      >
        <AmbientScene tone="steel" />
        <div className="mx-auto flex min-h-[70svh] w-full max-w-[1600px] items-end px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <ScrollRevealFrame className="max-w-4xl">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Final close</div>
            <h2 className="mt-4 text-balance text-[3rem] font-semibold tracking-[-0.06em] text-slate-950 sm:text-[4.5rem] lg:text-[6rem]">
              Send the document.
              <span className="block text-[var(--text-muted)]">Keep the control.</span>
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
              Start with Doclinks if you need a clearer, safer way to share sensitive files. Review pricing, trust, and
              product detail without leaving the public site.
            </p>
            <CTAGroup
              className="mt-8"
              actions={[
                { href: primaryAccessHref, label: publicConfig.signupEnabled ? "Get started" : "Sign in", tone: "primary" },
                {
                  href: publicConfig.showPricingUi ? "/pricing" : "/doclinks",
                  label: publicConfig.showPricingUi ? "View pricing" : "Explore Doclinks",
                  tone: "secondary",
                },
                { href: "/trust", label: "Review Trust", tone: "secondary" },
              ]}
            />
          </ScrollRevealFrame>
        </div>
      </BackgroundVideoSection>
    </SiteShell>
  );
}
