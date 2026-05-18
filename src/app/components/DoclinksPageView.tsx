import { BackgroundVideoSection, ScrollRevealFrame } from "./CinematicClient";
import { AmbientScene, SectionTransition, StoryBand, VisualSignalCluster } from "./CinematicScene";
import {
  CTAGroup,
  ComparisonMatrix,
  ContentRail,
  DocumentIndexList,
  DocumentVisual,
  Eyebrow,
  PremiumCard,
  SenderRecipientProof,
  Section,
  UseCaseClusterGrid,
} from "./PublicPrimitives";
import { ProductWalkthrough } from "./ProductWalkthrough";
import type { PublicRuntimeConfig } from "@/lib/publicRuntimeConfig";

const OUTCOMES = [
  "Send with control",
  "Enforce at serve time",
  "See what happened",
  "Block unsafe delivery",
];

const TIMELINE = [
  {
    id: "01",
    title: "Upload through secure paths",
    body: "Documents enter protected paths with validation, private storage boundaries, and known workflow states.",
  },
  {
    id: "02",
    title: "Validate and scan",
    body: "Files are checked before the system ever allows public delivery to become eligible.",
  },
  {
    id: "03",
    title: "Set policy rules",
    body: "Expiration, revocation, view bounds, and download posture are attached at the share layer.",
  },
  {
    id: "04",
    title: "Deliver through controlled serving",
    body: "Every access request passes through serve-time policy enforcement instead of relying on URL secrecy.",
  },
];

const FEATURES = [
  {
    eyebrow: "Tokenized access",
    title: "Links act as controlled delivery handles.",
    body: "Doclinks treats every request as an authorization event backed by current policy state.",
    signal: [
      { label: "Token", value: "Maps to bounded share state" },
      { label: "Serve check", value: "Evaluated on every request" },
      { label: "Assumption", value: "No blanket permission by possession" },
    ],
  },
  {
    eyebrow: "Expiration and revocation",
    title: "Access can end when the workflow ends.",
    body: "Time-box exposure, revoke immediately, and avoid endless link residue after a task is complete.",
    signal: [
      { label: "Expiry", value: "Explicit and visible" },
      { label: "Revocation", value: "Immediate from the server side" },
      { label: "Fallback", value: "Access closes instead of lingering" },
    ],
  },
  {
    eyebrow: "View limits and download controls",
    title: "Delivery posture changes to fit the document.",
    body: "Not every file deserves the same recipient experience. Doclinks supports a more deliberate delivery shape.",
    signal: [
      { label: "Views", value: "Bound repeated opens" },
      { label: "Download", value: "Configured per share" },
      { label: "Recipient path", value: "Aligned to sensitivity" },
    ],
  },
  {
    eyebrow: "Audit visibility",
    title: "See enough to support trust and follow-up.",
    body: "Access behavior is legible enough for real operational review without turning the product into a noisy monitoring console.",
    signal: [
      { label: "Reviewability", value: "Delivery activity is visible" },
      { label: "Support", value: "Clear states support response" },
      { label: "Confidence", value: "Evidence instead of guesswork" },
    ],
  },
  {
    eyebrow: "Scan-gated delivery",
    title: "Unsafe file states fail closed.",
    body: "Delivery is conditioned on scan posture, so files in risky states never become casual public links.",
    signal: [
      { label: "Validation", value: "Before public eligibility" },
      { label: "Blocked states", value: "Failed, infected, quarantined" },
      { label: "Default", value: "Protective by design" },
    ],
  },
  {
    eyebrow: "Professional recipient UX",
    title: "Security can still feel calm at the edge.",
    body: "Recipients get a composed experience while teams keep the real control surface behind the scenes.",
    signal: [
      { label: "Recipient view", value: "Clear and professional" },
      { label: "Sender control", value: "Retained at the policy layer" },
      { label: "Trust effect", value: "Stronger delivery confidence" },
    ],
  },
];

const TRUST_DOCUMENTS = [
  { href: "/legal/security-policy", title: "Security Policy", body: "Public control posture and response model." },
  { href: "/status", title: "Status", body: "Operational health and reliability signals." },
  { href: "/privacy", title: "Privacy and Terms", body: "Legal and data-handling surfaces for customer review." },
  { href: "/trust/procurement", title: "Procurement Package", body: "Business-ready documentation gathered into one path." },
  { href: "/security-disclosure", title: "Security Disclosure", body: "Responsible reporting expectations and security route." },
];

const USE_CASE_CLUSTERS = [
  {
    title: "Finance and operations",
    body: "Share statements, invoices, closings, and internal records with more control than an attachment or a loose cloud URL.",
    points: ["Time-bound delivery", "Clear recipient path"],
  },
  {
    title: "HR and people operations",
    body: "Deliver onboarding documents, records, and personnel files with bounded access and a more professional experience.",
    points: ["Private employee records", "Simple recipient flow"],
  },
  {
    title: "Legal and compliance",
    body: "Send contracts, review packets, and compliance files with revocation, visibility, and scan-gated release.",
    points: ["Revocation when terms change", "Reviewable delivery activity"],
  },
  {
    title: "Small businesses with client records",
    body: "Use a safer external-sharing path without needing a heavyweight enterprise deployment or complex file room.",
    points: ["Professional delivery", "Straightforward setup"],
  },
];

const COMPARISON_ROWS = [
  { label: "Expiry and revocation", values: ["Not built in", "Often limited or secondary", "First-class controls"] },
  { label: "Download control", values: ["Attachment is already out", "Usually link-only, not workflow-specific", "Policy-driven per share"] },
  { label: "Visibility after send", values: ["Very limited", "Often basic or absent", "Delivery activity stays visible"] },
  { label: "Serve-time enforcement", values: ["No", "Often URL-based access", "Checked on every request"] },
  { label: "Trust reviewability", values: ["Separate from the send path", "Usually weak", "Connected to public trust surfaces"] },
];

export function DoclinksPageView({ publicConfig }: { publicConfig: PublicRuntimeConfig }) {
  const primaryAccessHref = publicConfig.signupEnabled ? "/signup" : "/signin?intent=admin";

  return (
    <>
      <BackgroundVideoSection
        src="/media/cyang-doclinks-signal.mp4"
        poster="/media/cyang-doclinks-signal.jpg"
        priority
        className="mt-3 min-h-[92svh] border-b border-[var(--border-subtle)]"
        contentClassName="min-h-[92svh]"
      >
        <AmbientScene tone="steel" />
        <div className="mx-auto flex min-h-[92svh] w-full max-w-[1600px] flex-col justify-between px-4 pb-10 pt-18 sm:px-6 sm:pb-12 lg:px-8 lg:pt-24">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.06fr)_390px] lg:items-end">
            <ScrollRevealFrame className="max-w-5xl">
              <Eyebrow>Flagship product</Eyebrow>
              <h1 className="font-editorial mt-6 text-balance text-[3.15rem] leading-[0.9] tracking-[-0.06em] text-slate-950 sm:text-[4.75rem] lg:text-[7rem]">
                Send private documents
                <span className="block text-[var(--text-muted)]">without giving up control after send.</span>
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-xl">
                Protect contracts, records, financial files, HR documents, and other private files with protected
                links, clear recipient delivery, and sender controls that still matter after the link leaves your hands.
              </p>
              <CTAGroup
                className="mt-8"
                actions={[
                  { href: primaryAccessHref, label: publicConfig.signupEnabled ? "Get started" : "Sign in", tone: "primary" },
                  { href: "#sample-flow", label: "See a sample flow", tone: "secondary" },
                  { href: "/trust", label: "Review Trust", tone: "secondary" },
                  ...(publicConfig.showPricingUi ? [{ href: "/pricing", label: "View pricing", tone: "secondary" as const }] : []),
                ]}
              />
            </ScrollRevealFrame>

            <ScrollRevealFrame delay={120} className="floating-stage p-6 sm:p-7">
              <DocumentVisual
                rows={[
                  { label: "Upload path", value: "Validated", tone: "accent" },
                  { label: "Serve posture", value: "Policy checked in real time", tone: "neutral" },
                  { label: "Lifecycle", value: "Expiry and revocation active", tone: "warm" },
                  { label: "Recipient flow", value: "Professional by default", tone: "neutral" },
                ]}
                footer="Built for private file delivery that needs more control than a generic file link."
              />
            </ScrollRevealFrame>
          </div>

          <ScrollRevealFrame delay={220} className="mt-10">
            <div className="grid gap-4 border-t border-[var(--border-subtle)] pt-5 sm:grid-cols-4">
              {OUTCOMES.map((item) => (
                <div key={item}>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">Outcome</div>
                  <div className="mt-2 text-lg text-[var(--text-primary)]">{item}</div>
                </div>
              ))}
            </div>
          </ScrollRevealFrame>
        </div>
      </BackgroundVideoSection>

      <SectionTransition label="Outcome band" />

      <Section className="py-18 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {OUTCOMES.map((item, index) => (
                <div key={item} className="floating-stage p-6 sm:p-7">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">{String(index + 1).padStart(2, "0")}</div>
                  <div className="mt-5 text-3xl font-semibold tracking-[-0.04em] text-slate-950">{item}</div>
                </div>
              ))}
            </div>
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <SectionTransition label="Delivery flow" />

      <Section className="py-18 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
              <div className="lg:sticky lg:top-28">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">How it works</div>
                <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl">
                  Upload, protect, share, and stay in control.
                </h2>
              </div>
              <div className="relative border-l border-[var(--border-subtle)] pl-6 sm:pl-8">
                {TIMELINE.map((step, index) => (
                  <div key={step.id} className={index === TIMELINE.length - 1 ? "" : "pb-10"}>
                    <div className="absolute -left-[9px] mt-1 h-4 w-4 rounded-[2px] border border-[var(--border-accent)] bg-[var(--surface-selected)]" />
                    <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">{step.id}</div>
                    <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">{step.title}</div>
                    <p className="mt-3 max-w-xl text-base leading-8 text-[var(--text-secondary)]">{step.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <SectionTransition label="Product proof" />

      <Section id="sample-flow" className="py-18 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="max-w-3xl">
              <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Product proof</div>
              <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl lg:text-6xl">
                Visible proof for both sides of the send.
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                Doclinks gives the sender a serious control layer while keeping the recipient experience calm, clear,
                and professional.
              </p>
            </div>
          </ScrollRevealFrame>

          <ScrollRevealFrame delay={90} className="mt-10">
            <ProductWalkthrough
              title="Walk through a real protected-link lifecycle."
              body="This sample flow makes the sender, recipient, and system behavior visible before you ever create a workspace."
            />
          </ScrollRevealFrame>

          <ScrollRevealFrame delay={120} className="mt-10">
            <SenderRecipientProof
              sender={{
                title: "Set the sharing rules before the file leaves your workspace.",
                body: "Choose expiry, revoke access instantly, decide whether download is available, and keep reviewable delivery visibility after send.",
                chips: ["Expiry", "Revocation", "Bounded views", "Download allowed / blocked", "Delivery activity"],
                proof: [
                  "Policy is attached to the share, not delegated to the recipient.",
                  "Serve-time checks keep current rules active after send.",
                  "Scan-gated release blocks risky files before public delivery begins.",
                  "Visibility remains available for follow-up and support.",
                ],
              }}
              recipient={{
                title: "Give recipients a clean way to receive private files.",
                body: "Recipients get a focused delivery experience instead of a noisy dashboard or a raw storage link.",
                chips: ["Protected link", "Professional viewer", "Real-time checks", "No clutter"],
                proof: [
                  "Open a simple delivery page rather than a generic storage interface.",
                  "Access works only while the current policy allows it.",
                  "Blocked, expired, or revoked states fail closed instead of drifting open.",
                ],
              }}
            />
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <SectionTransition label="Feature storytelling" />

      <Section className="py-18 sm:py-24">
        <ContentRail className="space-y-10">
          {FEATURES.map((feature, index) => (
            <ScrollRevealFrame key={feature.title} delay={index * 70}>
              <div className="floating-stage p-6 sm:p-8 lg:p-10">
                <AmbientScene tone={index % 2 === 0 ? "cool" : "steel"} className="opacity-70" />
                <div className="relative">
                  <StoryBand
                    eyebrow={feature.eyebrow}
                    title={feature.title}
                    body={feature.body}
                    reverse={index % 2 === 1}
                    aside={<VisualSignalCluster title={feature.eyebrow} items={feature.signal} />}
                  />
                </div>
              </div>
            </ScrollRevealFrame>
          ))}
        </ContentRail>
      </Section>

      <SectionTransition label="Why not attachments" />

      <Section className="py-18 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:items-start">
              <div className="max-w-2xl">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Comparison</div>
                <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl">
                  Why not email attachments or generic file links?
                </h2>
                <p className="mt-5 text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  Attachments and ordinary file links are convenient, but they give the sender very little control once
                  the document starts moving. Doclinks is built for the moment after send.
                </p>
              </div>
              <ComparisonMatrix
                columns={["Attachments", "Generic links", "Doclinks"]}
                rows={COMPARISON_ROWS}
              />
            </div>
          </ScrollRevealFrame>
        </ContentRail>
      </Section>

      <SectionTransition label="Audience and trust" />

      <Section className="py-18 sm:py-24">
        <ContentRail>
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <ScrollRevealFrame>
              <PremiumCard strong className="h-full">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Audience and use cases</div>
                <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl">
                  Built for buyer-friendly use cases, not just abstract controls.
                </h2>
                <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--text-secondary)]">
                  The same control layer matters across several concrete workflows where private files still need to be
                  shared outside the workspace.
                </p>
                <div className="mt-8">
                  <UseCaseClusterGrid items={USE_CASE_CLUSTERS} />
                </div>
              </PremiumCard>
            </ScrollRevealFrame>

            <ScrollRevealFrame delay={120}>
              <div className="floating-stage p-6 sm:p-8">
                <AmbientScene tone="signal" className="opacity-75" />
                <div className="relative">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Trust architecture</div>
                  <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl">
                    Reviewable trust continuity for the flagship product.
                  </h2>
                  <p className="mt-5 max-w-xl text-base leading-8 text-[var(--text-secondary)]">
                    Doclinks inherits the same public trust shell as the wider cyang.io platform, so product review is
                    already connected to policy, status, and procurement routes.
                  </p>
                  <div className="mt-8">
                    <DocumentIndexList items={TRUST_DOCUMENTS} />
                  </div>
                </div>
              </div>
            </ScrollRevealFrame>
          </div>
        </ContentRail>
      </Section>

      <Section className="py-18 sm:py-24">
        <ContentRail>
          <ScrollRevealFrame>
            <div className="floating-stage overflow-hidden px-6 py-10 sm:px-8 sm:py-12 lg:px-10">
              <AmbientScene tone="steel" />
              <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Final CTA</div>
                  <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-5xl lg:text-6xl">
                    Start with Doclinks when sensitive files need more than a link.
                  </h2>
                  <p className="mt-5 text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                    Use the flagship product path, review trust, and check pricing without leaving the public site.
                  </p>
                </div>
                <CTAGroup
                  actions={[
                    { href: primaryAccessHref, label: publicConfig.signupEnabled ? "Start with Doclinks" : "Sign in", tone: "primary" },
                    { href: "/trust", label: "Review Trust", tone: "secondary" },
                    ...(publicConfig.showPricingUi ? [{ href: "/pricing", label: "View pricing", tone: "secondary" as const }] : [{ href: "/contact", label: "Contact", tone: "secondary" as const }]),
                  ]}
                />
              </div>
            </div>
          </ScrollRevealFrame>
        </ContentRail>
      </Section>
    </>
  );
}
