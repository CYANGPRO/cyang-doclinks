import type { Metadata } from "next";
import { ScrollRevealFrame } from "@/app/components/CinematicClient";
import { AmbientScene, SectionTransition, StoryBand, VisualSignalCluster } from "@/app/components/CinematicScene";
import {
  CTAGroup,
  ContentRail,
  Eyebrow,
  LinkTile,
  PremiumCard,
  Section,
} from "@/app/components/PublicPrimitives";
import { SiteShell } from "@/app/components/SiteShell";
import InquiryForm from "./InquiryForm";
import { getPublicRuntimeConfig } from "@/lib/publicRuntimeConfig";

export const runtime = "nodejs";
export const revalidate = 900;

export const metadata: Metadata = {
  title: "Contact - cyang.io",
  description:
    "Premium contact routing for product support, security disclosures, privacy requests, legal inquiries, and general questions.",
};

export default function ContactPage() {
  const publicConfig = getPublicRuntimeConfig();

  return (
    <SiteShell maxWidth="full" publicConfig={publicConfig}>
      <section className="cinematic-bleed relative overflow-hidden pt-10 sm:pt-16 lg:pt-20">
        <AmbientScene tone="cool" className="opacity-90" />
        <ContentRail className="relative">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.04fr)_360px] lg:items-end">
            <ScrollRevealFrame>
              <div className="max-w-4xl">
                <Eyebrow>Contact</Eyebrow>
                <h1 className="mt-6 max-w-4xl text-balance font-editorial text-5xl leading-[0.95] tracking-[-0.05em] text-slate-950 sm:text-6xl lg:text-[5.2rem]">
                  Get in touch.
                </h1>
                <p className="mt-6 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  Route directly into the right channel so product, security, privacy, legal, and company questions
                  land with less delay and less friction.
                </p>
                <CTAGroup
                  className="mt-8"
                  actions={[
                    {
                      href: "#contact-form",
                      label: "Start a request",
                      tone: "primary",
                    },
                    {
                      href: `mailto:${publicConfig.supportEmail}`,
                      label: "Email support",
                      tone: "primary",
                      external: true,
                    },
                    { href: "/trust", label: "Review Trust", tone: "secondary" },
                    { href: "/status", label: "View Status", tone: "secondary" },
                  ]}
                />
              </div>
            </ScrollRevealFrame>

            <ScrollRevealFrame delay={140}>
              <VisualSignalCluster
                title="Routing"
                items={[
                  { label: "Support", value: publicConfig.supportEmail },
                  { label: "Security", value: publicConfig.securityEmail },
                  { label: "Privacy", value: publicConfig.privacyEmail },
                  { label: "Legal", value: publicConfig.legalEmail },
                ]}
                className="min-h-[320px]"
              />
            </ScrollRevealFrame>
          </div>
        </ContentRail>
      </section>

      <SectionTransition label="Contact routes" />

      <Section id="contact-form" className="pt-4 sm:pt-8">
        <ScrollRevealFrame>
          <InquiryForm
            source="contact"
            title="Start a request without leaving the site."
            body="Use this path for demos, procurement follow-up, support, and general questions. Direct email routes stay available for anyone who prefers them."
          />
        </ScrollRevealFrame>
      </Section>

      <Section className="pt-4 sm:pt-8">
        <ScrollRevealFrame>
          <StoryBand
            eyebrow="Clear paths"
            title="The contact surface is designed for accurate routing, not friction."
            body="If you already know the topic, go straight to the right address. If you need public context first, the trust hub and status surface stay close by."
            aside={
              <div className="floating-stage relative min-h-[280px] overflow-hidden rounded-sm p-6">
                <AmbientScene tone="steel" className="opacity-80" />
                <div className="relative">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Expectation</div>
                  <div className="mt-5 space-y-4 text-sm leading-7 text-[var(--text-secondary)]">
                    <p>Direct routes for product support, security reporting, privacy and legal, and general company questions.</p>
                    <p>No heavy intake form if email routing is the faster path.</p>
                    <p>Trust and status remain visible for review before outreach.</p>
                  </div>
                </div>
              </div>
            }
          />
        </ScrollRevealFrame>

        <ScrollRevealFrame delay={120} className="mt-10">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <LinkTile
              href="/contact?topic=product_support#contact-form"
              title="Product and support"
              body="Accounts, onboarding, active product usage, and customer support questions."
              meta={publicConfig.supportEmail}
            />
            <LinkTile
              href="/contact?topic=security_disclosure#contact-form"
              title="Security disclosures"
              body="Private vulnerability reporting and security review follow-up."
              meta={publicConfig.securityEmail}
            />
            <LinkTile
              href="/contact?topic=privacy_legal#contact-form"
              title="Privacy and legal"
              body="Privacy requests, DPA questions, subprocessors, retention, and legal routing."
              meta={publicConfig.privacyEmail}
            />
            <LinkTile
              href="/contact?topic=general#contact-form"
              title="General inquiries"
              body="Commercial conversations, partnerships, company questions, and broader outreach."
              meta={publicConfig.legalEmail}
            />
          </div>
        </ScrollRevealFrame>
      </Section>

      <Section className="py-16 sm:py-20">
        <ScrollRevealFrame>
          <div className="floating-stage relative overflow-hidden rounded-sm px-6 py-10 sm:px-8 sm:py-14 lg:px-12">
            <AmbientScene tone="signal" className="opacity-84" />
            <div className="relative grid gap-10 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:items-start">
              <div className="max-w-2xl">
                <Eyebrow>Guidance</Eyebrow>
                <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl lg:text-6xl">
                  Pick the route that matches the real need.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  The fastest path is usually the most specific one. Product support belongs with support. Security
                  reports belong with security. Privacy and legal questions should arrive with the right context.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["Product / support", "Best for active customer questions, account help, and onboarding."],
                  ["Security disclosures", "Best for responsible disclosure and product security follow-up."],
                  ["Privacy / legal", "Best for DPA, subprocessors, retention, and privacy requests."],
                  ["General inquiries", "Best for broader commercial or company questions."],
                ].map(([title, body], index) => (
                  <PremiumCard key={title} className="min-h-[180px] bg-white/90">
                    <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <div className="mt-7 text-xl font-semibold tracking-tight text-slate-950">{title}</div>
                    <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{body}</p>
                  </PremiumCard>
                ))}
              </div>
            </div>
          </div>
        </ScrollRevealFrame>
      </Section>

      <Section className="pb-18 pt-4 sm:pb-24 sm:pt-8">
        <ScrollRevealFrame>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)] lg:items-stretch">
            <div className="floating-stage relative overflow-hidden rounded-sm px-6 py-10 sm:px-8 sm:py-12">
              <AmbientScene tone="steel" className="opacity-82" />
              <div className="relative max-w-3xl">
                <Eyebrow>Trust reinforcement</Eyebrow>
                <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
                  Need public context before you reach out?
                </h2>
                <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--text-secondary)] sm:text-lg">
                  Review the trust hub and live status first if the question depends on current operating posture,
                  disclosure expectations, procurement evidence, or incident visibility.
                </p>
                <CTAGroup
                  className="mt-8"
                  actions={[
                    { href: "#contact-form", label: "Start a request", tone: "primary" },
                    { href: "/trust", label: "Trust Center", tone: "secondary" },
                    { href: "/status", label: "Status", tone: "secondary" },
                  ]}
                />
              </div>
            </div>

            <ScrollRevealFrame delay={100}>
              <VisualSignalCluster
                title="Public surfaces"
                items={[
                  { label: "Trust center", value: "Security, privacy, legal, procurement, and reporting." },
                  { label: "Status", value: "Live operational health and incident communication." },
                  { label: "Disclosure", value: "Private vulnerability reporting with clear expectations." },
                ]}
                className="h-full min-h-[280px]"
              />
            </ScrollRevealFrame>
          </div>
        </ScrollRevealFrame>
      </Section>
    </SiteShell>
  );
}
