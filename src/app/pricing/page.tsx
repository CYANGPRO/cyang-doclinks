import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StructuredData } from "../components/StructuredData";
import { SiteShell } from "../components/SiteShell";
import { getPublicRuntimeConfig } from "@/lib/publicRuntimeConfig";
import { FREE_PLAN, PRO_PLAN } from "@/lib/monetization";

export const runtime = "nodejs";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Pricing - Doclinks",
  description:
    "Transparent Free and Pro pricing for secure document sharing with protected links, sender controls, and straightforward upgrade paths.",
};

type PlanFeature = {
  feature: string;
  free: string;
  pro: string;
};

type ComparisonGroup = {
  title: string;
  description: string;
  rows: PlanFeature[];
};

const TRUST_CHIPS = [
  "Protected links",
  "Expiry and revocation",
  "Scan-gated delivery",
  "Trust center included",
];

const WHY_UPGRADE = [
  {
    title: "Higher throughput",
    body: "More upload and storage capacity for real client-facing document delivery volume.",
  },
  {
    title: "Expanded delivery controls",
    body: "Use custom expiration and permanent shares with policy control boundaries.",
  },
  {
    title: "Richer visibility",
    body: "Move beyond basic activity checks with expanded audit visibility and exports.",
  },
  {
    title: "Automation access",
    body: "Integrate workflows through API and webhooks when operations need automation.",
  },
  {
    title: "More room to operate",
    body: "Run larger active-share and view workloads without hitting Free-tier ceilings.",
  },
  {
    title: "Same security posture",
    body: "Security baseline remains strict across plans while Pro adds operating depth.",
  },
];

const SECURITY_BASELINE = [
  {
    title: "Encryption required",
    body: "Document paths are protected by default on both Free and Pro.",
  },
  {
    title: "Scan-first delivery",
    body: "Virus scanning is required before files are eligible for delivery.",
  },
  {
    title: "Policy enforcement",
    body: "Access and share behavior are enforced server-side, not by user guesswork.",
  },
  {
    title: "Operational safeguards",
    body: "Abuse monitoring and health guardrails help keep delivery reliable and safe.",
  },
];

const FAQS = [
  {
    q: "Is Free actually usable?",
    a: "Yes. Free is designed for real controlled delivery workflows with practical day-to-day utility.",
  },
  {
    q: "Are security features included on Free?",
    a: "Yes. Encryption and scan-before-delivery posture apply across both plans.",
  },
  {
    q: "What does unlimited mean on Pro?",
    a: "It means no hard product cap on active shares or views, with soft monitoring for anti-abuse and platform health.",
  },
  {
    q: "Are there hidden usage rules?",
    a: "No hidden pricing math. Plan boundaries are explicit, and monitoring policies are documented as safeguards.",
  },
  {
    q: "Can I upgrade later?",
    a: "Yes. You can start on Free and upgrade to Pro when your volume or control requirements increase.",
  },
];

export default function PricingPage() {
  const publicConfig = getPublicRuntimeConfig();
  if (!publicConfig.showPricingUi) {
    notFound();
  }
  const signupEnabled = publicConfig.signupEnabled;
  const primaryAccessHref = signupEnabled ? "/signup" : "/signin?intent=admin";
  const planHighlights = {
    free: [
      `${formatBytesLabel(FREE_PLAN.maxFileSizeBytes)} max upload`,
      `${formatBytesLabel(FREE_PLAN.maxStorageBytes)} storage`,
      `${FREE_PLAN.maxActiveShares} active shares`,
      `${FREE_PLAN.maxViewsPerMonth} views/month`,
      "Core controlled delivery workflow",
    ],
    pro: [
      `${formatBytesLabel(PRO_PLAN.maxFileSizeBytes)} max upload`,
      `${formatBytesLabel(PRO_PLAN.maxStorageBytes)} storage`,
      "Unlimited active shares (soft monitored)",
      "Unlimited views (soft monitored)",
      "Audit export + API + webhooks",
    ],
  };
  const comparisonGroups: ComparisonGroup[] = [
    {
      title: "Limits",
      description: "Capacity and usage boundaries by plan.",
      rows: [
        { feature: "Price", free: "$0/month", pro: "$12/month" },
        { feature: "Max file upload", free: formatBytesLabel(FREE_PLAN.maxFileSizeBytes), pro: formatBytesLabel(PRO_PLAN.maxFileSizeBytes) },
        { feature: "Total storage", free: formatBytesLabel(FREE_PLAN.maxStorageBytes), pro: formatBytesLabel(PRO_PLAN.maxStorageBytes) },
        { feature: "Active shares", free: String(FREE_PLAN.maxActiveShares ?? "Unlimited"), pro: "Unlimited (soft monitored)" },
        { feature: "Views", free: `${FREE_PLAN.maxViewsPerMonth}/month`, pro: "Unlimited (soft monitored)" },
      ],
    },
    {
      title: "Delivery controls",
      description: "How much control you have over share lifecycle.",
      rows: [
        { feature: "Share expiration", free: "Required, up to 7 days", pro: "Custom expiration controls" },
        { feature: "Permanent shares", free: "Not available", pro: "Available with policy controls" },
        { feature: "Allow download toggle", free: "Available, policy-enforced", pro: "Available, policy-enforced" },
      ],
    },
    {
      title: "Visibility and automation",
      description: "Operational insight and integrations.",
      rows: [
        { feature: "Audit visibility", free: "Basic activity visibility", pro: "Audit export + expanded visibility" },
        { feature: "API + webhooks", free: "Not included", pro: "Included" },
      ],
    },
    {
      title: "Security and safeguards",
      description: "Core protection posture across plans.",
      rows: [
        { feature: "Abuse throttling", free: "Strict", pro: "Standard (monitored)" },
        { feature: "Encryption", free: "Required", pro: "Required" },
        { feature: "Virus scanning", free: "Required before delivery", pro: "Required before delivery" },
      ],
    },
  ];

  return (
    <SiteShell maxWidth="full" publicConfig={publicConfig}>
      <StructuredData
        data={[
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Doclinks",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            url: "https://cyang.io/pricing",
            offers: [
              {
                "@type": "Offer",
                name: "Doclinks Free",
                price: "0",
                priceCurrency: "USD",
                url: "https://cyang.io/pricing",
              },
              {
                "@type": "Offer",
                name: "Doclinks Pro",
                price: "12",
                priceCurrency: "USD",
                url: "https://cyang.io/pricing",
              },
            ],
          },
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: FAQS.map((item) => ({
              "@type": "Question",
              name: item.q,
              acceptedAnswer: {
                "@type": "Answer",
                text: item.a,
              },
            })),
          },
        ]}
      />
      <section className="relative mt-10 grid gap-6 lg:grid-cols-12 lg:items-end">
        <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute -left-16 top-0 h-72 w-72 rounded-full bg-[rgba(70,118,194,0.12)] blur-3xl" />
          <div className="absolute right-0 top-8 h-80 w-80 rounded-full bg-[rgba(162,178,201,0.14)] blur-3xl" />
        </div>

        <div className="lg:col-span-7">
          <span className="ui-badge inline-flex rounded-sm px-3 py-1 text-xs uppercase tracking-[0.16em]">Doclinks pricing</span>
          <h1 className="font-editorial mt-5 max-w-4xl text-4xl leading-[1.04] tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
            Transparent pricing for
            <span className="block text-[var(--text-secondary)]">secure document sharing that stays under control.</span>
          </h1>
          <p className="mt-7 max-w-3xl text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
            Start on Free to replace risky attachments with protected links. Move to Pro when you need more room,
            richer control, and stronger operational visibility.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[var(--text-secondary)]">
            <span>For contracts, HR records, financial files, and client documents</span>
            <span>Safer than attachments</span>
            <span>More control after send</span>
          </div>

          <div className="mt-7 flex flex-wrap gap-2">
            {TRUST_CHIPS.map((chip) => (
              <span key={chip} className="selection-pill rounded-sm px-3 py-1.5 text-xs">
                {chip}
              </span>
            ))}
          </div>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              href={primaryAccessHref}
              className="btn-base btn-primary rounded-sm px-6 py-3 text-sm font-semibold"
              data-funnel-action="pricing_interest"
              data-funnel-location="pricing"
              data-funnel-label={signupEnabled ? "hero_get_started_free" : "hero_sign_in"}
            >
              {signupEnabled ? "Get started free" : "Sign in"}
            </Link>
            <Link
              href="/signin?intent=admin"
              className="btn-base btn-secondary rounded-sm px-6 py-3 text-sm"
              data-funnel-action="pricing_interest"
              data-funnel-location="pricing"
              data-funnel-label="hero_upgrade_existing_workspace"
            >
              Upgrade existing workspace
            </Link>
            <Link href="/doclinks" className="btn-base btn-secondary rounded-sm px-6 py-3 text-sm">
              View Doclinks
            </Link>
            <Link href="/trust" className="btn-base btn-secondary rounded-sm px-6 py-3 text-sm">
              Review trust
            </Link>
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="surface-panel-strong p-6">
            <div className="text-xs uppercase tracking-[0.14em] text-[var(--text-faint)]">At a glance</div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <SummaryCard title="Free" price="$0/mo" subtitle="Best for replacing attachments and proving the workflow" />
              <SummaryCard title="Pro" price="$12/mo" subtitle="Best for steady client delivery and richer control" pro />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-[var(--text-secondary)]">
              Both plans keep the secure-sharing baseline. Pro adds more room, stronger control depth, automation, and
              deeper visibility for ongoing document delivery.
            </p>
          </div>
        </div>
      </section>

      <section id="plans" className="mt-16 md:mt-20">
        <SectionIntro
          eyebrow="Plans"
          title="Choose the plan that matches your delivery volume"
          body="Free supports real secure-sharing workflows at light volume. Pro is for customer-facing delivery that needs more throughput, more control, and more visibility."
        />

        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <PlanCard
            tier="Free"
            price="$0/month"
            bestFor="Best for individual testing, light use, and proving the workflow"
            highlights={planHighlights.free}
            ctaHref={primaryAccessHref}
            ctaLabel={signupEnabled ? "Start Free" : "Sign in"}
          />
          <PlanCard
            tier="Pro"
            price="$12/month"
            bestFor="Best for client delivery, teams, higher volume, and audit visibility"
            highlights={planHighlights.pro}
            ctaHref={primaryAccessHref}
            ctaLabel={signupEnabled ? "Start Pro" : "Sign in to upgrade"}
            recommended
          />
        </div>
      </section>

      <section id="why-upgrade" className="mt-16 md:mt-20">
        <SectionIntro
          eyebrow="Why upgrade"
          title="Why Pro exists"
          body="Pro is for teams that send private documents regularly and need more room, stronger lifecycle flexibility, and richer visibility after send."
        />

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {WHY_UPGRADE.map((item) => (
            <FeatureCard key={item.title} title={item.title} body={item.body} />
          ))}
        </div>
      </section>

      <section id="comparison" className="mt-16 md:mt-20">
        <SectionIntro
          eyebrow="Plan comparison"
          title="Detailed capabilities by plan"
          body="Clear boundaries, no hidden math. Compare limits, controls, visibility, automation, and security posture side by side."
        />

        <div className="mt-8 space-y-4">
          {comparisonGroups.map((group) => (
            <ComparisonGroupCard key={group.title} group={group} />
          ))}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-[var(--text-secondary)]">
          Soft monitored and soft cap monitored mean there is no hard product cap, but usage is monitored for anti-abuse and operational health controls.
        </p>
      </section>

      <section id="security-baseline" className="mt-16 md:mt-20">
        <SectionIntro
          eyebrow="Included baseline"
          title="Security posture included on both plans"
          body="Doclinks is not priced as secure versus insecure. Protected links, scan-gated delivery, and server-side enforcement are part of the baseline across Free and Pro."
        />

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {SECURITY_BASELINE.map((item) => (
            <FeatureCard key={item.title} title={item.title} body={item.body} />
          ))}
        </div>
      </section>

      <section id="fit" className="mt-16 md:mt-20">
        <SectionIntro
          eyebrow="Which plan fits"
          title="Quick self-selection"
          body="If you are validating or sharing occasionally, start Free. If you are running steady external delivery for clients, employees, or sensitive records, Pro removes friction and adds depth."
        />

        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <FitCard
            title="Choose Free if"
            points={[
              "You are validating controlled delivery workflow",
              "Your monthly volume is modest",
              "You need a serious trial path before committing",
            ]}
          />
          <FitCard
            title="Choose Pro if"
            points={[
              "You need more storage and larger file support",
              "You manage ongoing client or team delivery",
              "You want expanded audit visibility and automation",
            ]}
            pro
          />
        </div>
      </section>

      <section id="faq" className="mt-16 md:mt-20">
        <SectionIntro
          eyebrow="Pricing FAQ"
          title="Answers to common plan questions"
          body="Short, clear answers for faster plan decisions."
        />

        <div className="mt-8 grid gap-3 lg:grid-cols-2">
          {FAQS.map((faq) => (
            <details key={faq.q} className="surface-panel rounded-sm p-5 open:bg-[var(--surface-soft)]">
              <summary className="cursor-pointer list-none text-sm font-medium text-slate-950">{faq.q}</summary>
              <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">{faq.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mt-16 mb-2 md:mt-20">
        <div className="surface-panel-strong p-7 sm:p-8">
          <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Start with Free. Scale with Pro.</h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--text-secondary)]">
            Choose the plan that matches your current document-sharing volume, then move up as control and delivery
            requirements grow.
          </p>

          <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CtaTile
              href={primaryAccessHref}
              title={signupEnabled ? "Start Free" : "Sign in"}
              body="Open your account and validate your workflow."
              funnelAction="pricing_interest"
              funnelLocation="pricing"
            />
            <CtaTile
              href="/signin?intent=admin"
              title="Upgrade to Pro"
              body="Existing workspace owners can upgrade instantly."
              funnelAction="pricing_interest"
              funnelLocation="pricing"
            />
            <CtaTile href="/doclinks" title="Learn about Doclinks" body="Review product capabilities and security model." />
            <CtaTile href="/trust" title="Review trust" body="Inspect status, legal, disclosure, and procurement surfaces." />
          </div>
        </div>
      </section>
    </SiteShell>
  );
}

function formatBytesLabel(value: number | null): string {
  if (value == null) return "Unlimited";
  if (value >= 1024 * 1024 * 1024) return `${Math.round(value / (1024 * 1024 * 1024))} GB`;
  return `${Math.round(value / (1024 * 1024))} MB`;
}

function SectionIntro(props: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="max-w-4xl">
      <span className="ui-badge inline-flex rounded-sm px-3 py-1 text-xs uppercase tracking-[0.15em]">{props.eyebrow}</span>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{props.title}</h2>
      <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)] sm:text-base">{props.body}</p>
    </div>
  );
}

function SummaryCard(props: { title: string; price: string; subtitle: string; pro?: boolean }) {
  return (
    <div
      className={
        props.pro
          ? "rounded-sm border border-[rgba(161,109,27,0.18)] bg-[rgba(161,109,27,0.05)] p-4"
          : "rounded-sm border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-4"
      }
    >
      <div className="text-xs uppercase tracking-[0.1em] text-[var(--text-faint)]">{props.title}</div>
      <div className="mt-1 text-xl font-semibold text-slate-950">{props.price}</div>
      <div className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{props.subtitle}</div>
    </div>
  );
}

function PlanCard(props: {
  tier: string;
  price: string;
  bestFor: string;
  highlights: string[];
  ctaHref: string;
  ctaLabel: string;
  recommended?: boolean;
}) {
  const wrapperClass = props.recommended
    ? "surface-panel-strong rounded-sm border-[rgba(161,109,27,0.18)] bg-[linear-gradient(180deg,rgba(255,251,243,0.98),rgba(255,255,255,0.98))] p-6"
    : "surface-panel p-6";

  const badgeClass = props.recommended
    ? "btn-base inline-flex rounded-sm border border-[rgba(161,109,27,0.22)] bg-[rgba(161,109,27,0.08)] px-3 py-1.5 text-sm font-semibold text-[var(--accent-warm)] hover:bg-[rgba(161,109,27,0.12)]"
    : "btn-base btn-primary inline-flex rounded-sm px-3 py-1.5 text-sm font-semibold";

  return (
    <article className={wrapperClass}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.12em] text-[var(--text-faint)]">{props.tier}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{props.price}</div>
        </div>
        {props.recommended ? <span className="selection-pill-active rounded-sm px-2.5 py-1 text-[11px]">Recommended</span> : null}
      </div>

      <p className="mt-4 text-sm leading-relaxed text-[var(--text-secondary)]">{props.bestFor}</p>

      <ul className="mt-5 space-y-2 text-sm text-[var(--text-primary)]">
        {props.highlights.map((highlight) => (
          <li key={highlight} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent-primary)]" />
            <span>{highlight}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Link
          href={props.ctaHref}
          className={badgeClass}
          data-funnel-action="pricing_interest"
          data-funnel-location="pricing"
          data-funnel-label={`${props.tier.toLowerCase()}_${props.ctaLabel.toLowerCase().replace(/\s+/g, "_")}`}
        >
          {props.ctaLabel}
        </Link>
        <Link
          href="/signin"
          className="btn-base btn-secondary rounded-sm px-3.5 py-2 text-sm"
          data-funnel-action="pricing_interest"
          data-funnel-location="pricing"
          data-funnel-label={`${props.tier.toLowerCase()}_secondary_sign_in`}
        >
          Sign in
        </Link>
      </div>
    </article>
  );
}

function FeatureCard(props: { title: string; body: string }) {
  return (
    <article className="surface-panel p-6">
      <h3 className="text-lg font-semibold tracking-tight text-slate-950">{props.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{props.body}</p>
    </article>
  );
}

function ComparisonGroupCard(props: { group: ComparisonGroup }) {
  return (
    <article className="surface-panel p-5 sm:p-6">
      <h3 className="text-xl font-semibold tracking-tight text-slate-950">{props.group.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{props.group.description}</p>

      <div className="mt-5 hidden overflow-hidden rounded-sm border border-[var(--border-subtle)] md:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-[var(--surface-soft)] text-slate-950">
            <tr>
              <th className="px-4 py-3 font-semibold">Capability</th>
              <th className="px-4 py-3 font-semibold">Free</th>
              <th className="px-4 py-3 font-semibold">Pro</th>
            </tr>
          </thead>
          <tbody>
            {props.group.rows.map((row) => (
              <tr key={row.feature} className="border-t border-[var(--border-subtle)]">
                <td className="px-4 py-3 text-slate-950">{row.feature}</td>
                <td className="px-4 py-3 text-[var(--text-secondary)]">{row.free}</td>
                <td className="px-4 py-3 text-slate-950">{row.pro}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-5 space-y-3 md:hidden">
        {props.group.rows.map((row) => (
          <div key={row.feature} className="surface-panel-soft p-4">
            <div className="text-sm font-medium text-slate-950">{row.feature}</div>
            <div className="mt-2 grid gap-2 text-xs">
              <div className="rounded-sm border border-[var(--border-subtle)] bg-white px-3 py-2 text-[var(--text-secondary)]">
                <span className="text-[var(--text-faint)]">Free:</span> {row.free}
              </div>
              <div className="rounded-sm border border-[var(--border-accent)] bg-[var(--surface-selected)] px-3 py-2 text-slate-950">
                <span className="text-[var(--text-faint)]">Pro:</span> {row.pro}
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function FitCard(props: { title: string; points: string[]; pro?: boolean }) {
  return (
    <article
      className={
        props.pro
          ? "surface-panel-strong border-[var(--border-accent)] bg-[linear-gradient(180deg,rgba(244,248,253,0.98),rgba(255,255,255,0.98))] p-6"
          : "surface-panel p-6"
      }
    >
      <h3 className="text-xl font-semibold tracking-tight text-slate-950">{props.title}</h3>
      <ul className="mt-4 space-y-2 text-sm text-[var(--text-secondary)]">
        {props.points.map((point) => (
          <li key={point} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent-primary)]" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function CtaTile(props: { href: string; title: string; body: string; funnelAction?: string; funnelLocation?: string }) {
  return (
    <Link
      href={props.href}
      data-funnel-action={props.funnelAction}
      data-funnel-location={props.funnelLocation}
      data-funnel-label={props.funnelAction ? props.title : undefined}
      className="rounded-sm border border-[var(--border-subtle)] bg-white p-4 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-soft)]"
    >
      <div className="text-sm font-medium text-slate-950">{props.title}</div>
      <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{props.body}</p>
    </Link>
  );
}
