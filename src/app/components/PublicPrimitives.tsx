import Link from "next/link";
import type { ReactNode } from "react";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ContentRail({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("mx-auto w-full max-w-[1220px] px-4 sm:px-6 lg:px-8", className)}>{children}</div>;
}

export function Section({
  children,
  id,
  className,
  railClassName,
}: {
  children: ReactNode;
  id?: string;
  className?: string;
  railClassName?: string;
}) {
  return (
    <section id={id} className={cn("relative py-10 sm:py-14 lg:py-18", className)}>
      <ContentRail className={railClassName}>{children}</ContentRail>
    </section>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "ui-badge inline-flex rounded-sm px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em]",
        className
      )}
    >
      {children}
    </span>
  );
}

export function DisplayTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={cn(
        "font-editorial text-balance text-4xl leading-[0.98] tracking-[-0.03em] text-slate-950 sm:text-5xl lg:text-7xl",
        className
      )}
    >
      {children}
    </h1>
  );
}

export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("max-w-2xl text-base leading-7 text-[var(--text-secondary)] sm:text-lg sm:leading-8", className)}>{children}</p>;
}

export function BodyMuted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm leading-7 text-[var(--text-muted)]", className)}>{children}</p>;
}

export function MetaLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--text-faint)]", className)}>{children}</div>
  );
}

export function LastUpdated({ children }: { children: ReactNode }) {
  return <span className="text-xs text-[var(--text-faint)]">Last updated {children}</span>;
}

export function ArrowLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]", className)}>
      <span>{children}</span>
      <span aria-hidden="true">→</span>
    </Link>
  );
}

export function CTAGroup({
  actions,
  className,
}: {
  actions: Array<{ href: string; label: string; tone?: "primary" | "secondary"; external?: boolean }>;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:flex-wrap", className)}>
      {actions.map((action) =>
        action.external ? (
          <a
            key={`${action.href}-${action.label}`}
            href={action.href}
            className={cn(
              "btn-base inline-flex items-center justify-center rounded-sm px-5 py-3 text-sm font-medium",
              action.tone === "primary" ? "btn-primary" : "btn-secondary"
            )}
          >
            {action.label}
          </a>
        ) : (
          <Link
            key={`${action.href}-${action.label}`}
            href={action.href}
            className={cn(
              "btn-base inline-flex items-center justify-center rounded-sm px-5 py-3 text-sm font-medium",
              action.tone === "primary" ? "btn-primary" : "btn-secondary"
            )}
          >
            {action.label}
          </Link>
        )
      )}
    </div>
  );
}

export function MaturityBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "live" | "build" | "lab" | "neutral";
}) {
  const toneClass =
    tone === "live"
      ? "border-[rgba(40,136,88,0.18)] bg-[rgba(40,136,88,0.08)] text-[var(--success)]"
      : tone === "build"
        ? "border-[var(--border-accent)] bg-[var(--surface-selected)] text-[var(--accent-primary)]"
        : tone === "lab"
          ? "border-[rgba(161,109,27,0.18)] bg-[rgba(161,109,27,0.08)] text-[var(--accent-warm)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-soft)] text-[var(--text-secondary)]";

  return <span className={cn("inline-flex rounded-sm border px-2.5 py-1 text-[11px] font-medium", toneClass)}>{children}</span>;
}

export function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "positive" | "caution" | "neutral";
}) {
  const toneClass =
    tone === "positive"
      ? "bg-[var(--success)]"
      : tone === "caution"
        ? "bg-[var(--warning)]"
        : "bg-[var(--accent-primary)]";

  return (
    <span className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
      <span className={cn("h-2 w-2 rounded-[2px]", toneClass)} />
      <span>{label}</span>
    </span>
  );
}

export function GlowDivider({ className }: { className?: string }) {
  return <div className={cn("premium-divider", className)} />;
}

export function PremiumCard({
  children,
  className,
  strong,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  strong?: boolean;
  as?: "div" | "article";
}) {
  const Component = as;
  return (
    <Component className={cn(strong ? "surface-panel-strong" : "surface-panel", "rounded-sm p-6 sm:p-7", className)}>
      {children}
    </Component>
  );
}

export function SignalCard({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: string;
  detail?: string;
  className?: string;
}) {
  return (
    <PremiumCard className={cn("h-full", className)}>
      <MetaLabel>{label}</MetaLabel>
      <div className="mt-3 text-xl font-semibold tracking-tight text-slate-950">{value}</div>
      {detail ? <BodyMuted className="mt-2">{detail}</BodyMuted> : null}
    </PremiumCard>
  );
}

export function LinkTile({
  href,
  title,
  body,
  meta,
  badge,
  ctaLabel,
  className,
}: {
  href: string;
  title: string;
  body: string;
  meta?: string;
  badge?: ReactNode;
  ctaLabel?: string;
  className?: string;
}) {
  return (
    <Link href={href} className={cn("group block", className)}>
      <PremiumCard className="h-full transition-colors group-hover:bg-[var(--surface-interactive)]">
        <div className="flex items-start justify-between gap-4">
          <MetaLabel>{meta || "Open"}</MetaLabel>
          {badge}
        </div>
        <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">{title}</h3>
        <BodyMuted className="mt-2">{body}</BodyMuted>
        <div className="mt-6 inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
          <span>{ctaLabel || "Open"}</span>
          <span aria-hidden="true">→</span>
        </div>
      </PremiumCard>
    </Link>
  );
}

export function PillarCard({
  title,
  body,
  microcopy,
}: {
  title: string;
  body: string;
  microcopy?: string;
}) {
  return (
    <div className="group h-full rounded-sm border border-[var(--border-subtle)] bg-white p-6 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-strong)] focus-within:border-[var(--border-strong)]">
      <div className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{title}</div>
      <BodyMuted className="mt-3 max-w-sm">{body}</BodyMuted>
      {microcopy ? <div className="mt-6 text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">{microcopy}</div> : null}
    </div>
  );
}

export function PrinciplesGrid({
  items,
  columns = "three",
}: {
  items: Array<{ title: string; body: string; microcopy?: string }>;
  columns?: "three" | "four";
}) {
  return (
    <div className={cn("grid gap-4", columns === "four" ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3")}>
      {items.map((item) => (
        <PillarCard key={item.title} title={item.title} body={item.body} microcopy={item.microcopy} />
      ))}
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  body,
  align = "left",
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  align?: "left" | "center";
}) {
  return (
    <div className={cn("max-w-3xl", align === "center" && "mx-auto text-center")}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.03em] text-slate-950 sm:text-4xl lg:text-5xl">{title}</h2>
      {body ? <Lead className="mt-4 max-w-2xl">{body}</Lead> : null}
    </div>
  );
}

export function PageHero({
  eyebrow,
  title,
  body,
  actions,
  aside,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  body: string;
  actions?: Array<{ href: string; label: string; tone?: "primary" | "secondary"; external?: boolean }>;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <Section className={cn("pt-8 sm:pt-12", className)}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.72fr)] lg:items-end">
        <div className="max-w-4xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <DisplayTitle className="mt-6">{title}</DisplayTitle>
          <Lead className="mt-6">{body}</Lead>
          {actions?.length ? <CTAGroup className="mt-8" actions={actions} /> : null}
        </div>
        {aside ? <div>{aside}</div> : null}
      </div>
    </Section>
  );
}

export function AmbientGradient({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-sm",
        className
      )}
    >
      <div className="absolute -left-[8%] top-[6%] h-40 w-40 rounded-full bg-[rgba(71,116,189,0.12)] blur-3xl sm:h-56 sm:w-56" />
      <div className="absolute right-[4%] top-[8%] h-48 w-48 rounded-full bg-[rgba(152,167,188,0.16)] blur-3xl sm:h-64 sm:w-64" />
      <div className="absolute bottom-[10%] left-[28%] h-32 w-44 rounded-full bg-[rgba(184,145,92,0.08)] blur-3xl" />
    </div>
  );
}

export function LayeredBackdrop({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("hero-grid surface-panel-strong relative overflow-hidden rounded-sm p-6 sm:p-8", className)}>
      <AmbientGradient />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent" />
      <div className="absolute inset-y-0 left-[42%] hidden w-px bg-slate-200 lg:block" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

export function CinematicHero({
  eyebrow,
  title,
  body,
  actions,
  stats,
  visual,
}: {
  eyebrow: string;
  title: ReactNode;
  body: string;
  actions: Array<{ href: string; label: string; tone?: "primary" | "secondary"; external?: boolean }>;
  stats?: Array<{ label: string; value: string; detail?: string }>;
  visual: ReactNode;
}) {
  return (
    <Section className="pt-8 sm:pt-12">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)] lg:items-end">
        <div className="max-w-4xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <DisplayTitle className="mt-6">{title}</DisplayTitle>
          <Lead className="mt-6">{body}</Lead>
          <CTAGroup className="mt-8" actions={actions} />
          {stats?.length ? (
            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              {stats.map((stat) => (
                <SignalCard key={stat.label} label={stat.label} value={stat.value} detail={stat.detail} />
              ))}
            </div>
          ) : null}
        </div>

        <div className="relative">
          <LayeredBackdrop className="min-h-[420px] lg:min-h-[520px]">
            {visual}
          </LayeredBackdrop>
        </div>
      </div>
    </Section>
  );
}

export function StoryPanel({
  title,
  body,
  children,
  badge,
  className,
}: {
  title: string;
  body: string;
  children?: ReactNode;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <PremiumCard strong className={cn("h-full", className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight text-slate-950">{title}</h3>
          <BodyMuted className="mt-3 max-w-xl">{body}</BodyMuted>
        </div>
        {badge}
      </div>
      {children ? <div className="mt-8">{children}</div> : null}
    </PremiumCard>
  );
}

export function FeatureBand({
  eyebrow,
  title,
  body,
  points,
  visual,
  reverse,
}: {
  eyebrow?: string;
  title: string;
  body: string;
  points: string[];
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className={cn("grid gap-4 lg:grid-cols-2 lg:items-stretch", reverse && "lg:[&>*:first-child]:order-2 lg:[&>*:last-child]:order-1")}>
      <PremiumCard strong className="flex flex-col justify-between">
        <div>
          {eyebrow ? <MetaLabel>{eyebrow}</MetaLabel> : null}
          <h3 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-slate-950">{title}</h3>
          <Lead className="mt-4 max-w-xl text-base">{body}</Lead>
        </div>
        <ul className="mt-8 space-y-3">
          {points.map((point) => (
            <li key={point} className="flex gap-3 text-sm leading-7 text-[var(--text-secondary)]">
              <span className="mt-3 h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent-primary)]/70" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </PremiumCard>

      <PremiumCard className="overflow-hidden">
        <div className="h-full min-h-[280px]">{visual}</div>
      </PremiumCard>
    </div>
  );
}

export function TimelineSteps({
  steps,
}: {
  steps: Array<{ id: string; title: string; body: string }>;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {steps.map((step) => (
        <PremiumCard key={step.id} className="h-full">
          <div className="inline-flex rounded-sm border border-[var(--border-accent)] bg-[var(--surface-selected)] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-[var(--accent-primary)]">
            {step.id}
          </div>
          <h3 className="mt-5 text-xl font-semibold tracking-tight text-slate-950">{step.title}</h3>
          <BodyMuted className="mt-3">{step.body}</BodyMuted>
        </PremiumCard>
      ))}
    </div>
  );
}

export function ProofStepBand({
  steps,
}: {
  steps: Array<{ title: string; body: string; signal: string }>;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {steps.map((step, index) => (
        <PremiumCard
          key={step.title}
          strong
          className={cn(
            "relative h-full overflow-hidden",
            index === 1 && "lg:translate-y-8",
            index === 2 && "lg:-translate-y-6",
            index === 3 && "lg:translate-y-4"
          )}
        >
          <AmbientGradient />
          <div className="relative">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">
                {String(index + 1).padStart(2, "0")}
              </div>
              <span className="selection-pill rounded-sm px-2.5 py-1 text-[11px]">{step.signal}</span>
            </div>
            <h3 className="mt-6 text-2xl font-semibold tracking-[-0.04em] text-slate-950">{step.title}</h3>
            <p className="mt-4 text-sm leading-7 text-[var(--text-secondary)]">{step.body}</p>
          </div>
        </PremiumCard>
      ))}
    </div>
  );
}

export function VisualProofBand({
  items,
}: {
  items: Array<{ href: string; title: string; body: string; meta?: string; badge?: ReactNode }>;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <LinkTile key={item.href} href={item.href} title={item.title} body={item.body} meta={item.meta} badge={item.badge} />
      ))}
    </div>
  );
}

export function TrustLinkGrid({
  items,
}: {
  items: Array<{ href: string; title: string; body: string; meta?: string; badge?: ReactNode }>;
}) {
  return <VisualProofBand items={items} />;
}

export function DocumentIndexList({
  items,
  funnelAction,
  funnelLocation,
}: {
  items: Array<{ href: string; title: string; body: string; meta?: ReactNode }>;
  funnelAction?: string;
  funnelLocation?: string;
}) {
  return (
    <div className="overflow-hidden rounded-sm border border-[var(--border-subtle)] bg-white shadow-[var(--shadow-soft)]">
      {items.map((item, index) => (
        <Link
          key={item.href}
          href={item.href}
          data-funnel-action={funnelAction}
          data-funnel-location={funnelLocation}
          data-funnel-label={funnelAction ? item.title : undefined}
          className={cn(
            "flex flex-col gap-4 px-5 py-5 transition-colors hover:bg-[var(--surface-soft)] sm:flex-row sm:items-start sm:justify-between sm:px-6",
            index !== 0 && "border-t border-[var(--border-subtle)]"
          )}
        >
          <div className="max-w-2xl">
            <div className="text-lg font-semibold tracking-tight text-slate-950">{item.title}</div>
            <BodyMuted className="mt-2">{item.body}</BodyMuted>
          </div>
          <div className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
            {item.meta}
            <span aria-hidden="true">→</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

export function Breadcrumbs({
  items,
}: {
  items: Array<{ label: string; href?: string }>;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="inline-flex items-center gap-2">
          {item.href ? <Link href={item.href} className="transition-colors hover:text-[var(--text-primary)]">{item.label}</Link> : <span className="text-[var(--text-faint)]">{item.label}</span>}
          {index < items.length - 1 ? <span aria-hidden="true">/</span> : null}
        </span>
      ))}
    </nav>
  );
}

export function PolicyMeta({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">{item.label}</dt>
          <dd className="mt-2 text-sm text-[var(--text-secondary)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StickySubnav({
  items,
}: {
  items: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="sticky top-22 z-20 hidden lg:block">
      <div className="surface-panel rounded-sm p-4">
        <MetaLabel>On this page</MetaLabel>
        <div className="mt-4 grid gap-2">
          {items.map((item) => (
            <a key={item.href} href={item.href} className="rounded-sm px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]">
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DocumentVisual({
  rows,
  footer,
}: {
  rows: Array<{ label: string; value: string; tone?: "accent" | "neutral" | "warm" }>;
  footer?: ReactNode;
}) {
  return (
    <div className="relative h-full overflow-hidden rounded-sm border border-[var(--border-subtle)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.98))] p-5 shadow-[var(--shadow-medium)]">
      <AmbientGradient className="rounded-sm" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent" />
      <div className="absolute inset-y-0 left-6 w-px bg-[linear-gradient(180deg,rgba(205,216,229,0),rgba(205,216,229,0.9),rgba(205,216,229,0))]" />
      <div className="relative">
        <div className="flex items-center justify-between">
          <MetaLabel>Secure delivery state</MetaLabel>
          <StatusPill label="Serve-time enforced" tone="positive" />
        </div>
        <div className="mt-5 space-y-3">
          {rows.map((row) => (
            <div key={row.label} className="rounded-sm border border-[var(--border-subtle)] bg-white/90 p-4 shadow-[var(--shadow-soft)]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">{row.label}</span>
                <span
                  className={cn(
                    "inline-flex rounded-sm px-2.5 py-1 text-[11px]",
                    row.tone === "accent"
                      ? "bg-[var(--surface-selected)] text-[var(--accent-primary)]"
                      : row.tone === "warm"
                        ? "bg-[#efe3c9] text-[#6e4d1b]"
                        : "bg-white text-[var(--text-secondary)]"
                  )}
                >
                  {row.value}
                </span>
              </div>
            </div>
          ))}
        </div>
        {footer ? <div className="mt-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-4 text-xs text-[var(--text-secondary)]">{footer}</div> : null}
      </div>
    </div>
  );
}

export function SenderRecipientProof({
  sender,
  recipient,
}: {
  sender: { title: string; body: string; chips: string[]; proof: string[] };
  recipient: { title: string; body: string; chips: string[]; proof: string[] };
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
      <PremiumCard strong className="relative overflow-hidden">
        <AmbientGradient />
        <div className="relative">
          <MetaLabel>Sender controls</MetaLabel>
          <h3 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-slate-950">{sender.title}</h3>
          <p className="mt-4 max-w-2xl text-base leading-8 text-[var(--text-secondary)]">{sender.body}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {sender.chips.map((chip) => (
              <span key={chip} className="selection-pill rounded-sm px-3 py-1.5 text-xs">
                {chip}
              </span>
            ))}
          </div>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {sender.proof.map((item, index) => (
              <div key={item} className="rounded-sm border border-[var(--border-subtle)] bg-white/90 p-4 shadow-[var(--shadow-soft)]">
                <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{item}</div>
              </div>
            ))}
          </div>
        </div>
      </PremiumCard>

      <PremiumCard className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.72),rgba(240,244,248,0.9))]" />
        <div className="relative">
          <MetaLabel>Recipient experience</MetaLabel>
          <h3 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-slate-950">{recipient.title}</h3>
          <p className="mt-4 max-w-xl text-base leading-8 text-[var(--text-secondary)]">{recipient.body}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {recipient.chips.map((chip) => (
              <span key={chip} className="selection-pill rounded-sm px-3 py-1.5 text-xs">
                {chip}
              </span>
            ))}
          </div>
          <div className="mt-8 space-y-3">
            {recipient.proof.map((item, index) => (
              <div key={item} className="flex items-start gap-3 rounded-sm border border-[var(--border-subtle)] bg-white/92 p-4 shadow-[var(--shadow-soft)]">
                <span className="mt-1 grid h-7 w-7 flex-none place-items-center rounded-sm bg-[var(--surface-selected)] text-[11px] font-medium text-[var(--accent-primary)]">
                  {index + 1}
                </span>
                <div className="text-sm leading-7 text-[var(--text-secondary)]">{item}</div>
              </div>
            ))}
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

export function ComparisonMatrix({
  columns,
  rows,
}: {
  columns: string[];
  rows: Array<{ label: string; values: string[] }>;
}) {
  return (
    <div className="overflow-hidden rounded-sm border border-[var(--border-subtle)] bg-white shadow-[var(--shadow-soft)]">
      <div className="grid grid-cols-[minmax(140px,1.2fr)_repeat(3,minmax(0,1fr))] border-b border-[var(--border-subtle)] bg-[var(--surface-soft)] text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">
        <div className="px-4 py-4 sm:px-5">Comparison</div>
        {columns.map((column) => (
          <div key={column} className="px-4 py-4 text-center sm:px-5">
            {column}
          </div>
        ))}
      </div>
      {rows.map((row, rowIndex) => (
        <div
          key={row.label}
          className={cn(
            "grid grid-cols-[minmax(140px,1.2fr)_repeat(3,minmax(0,1fr))]",
            rowIndex !== 0 && "border-t border-[var(--border-subtle)]"
          )}
        >
          <div className="px-4 py-4 text-sm font-medium text-slate-950 sm:px-5">{row.label}</div>
          {row.values.map((value, index) => (
            <div
              key={`${row.label}-${index}`}
              className={cn(
                "px-4 py-4 text-sm leading-7 text-[var(--text-secondary)] sm:px-5",
                index === 2 && "bg-[linear-gradient(180deg,rgba(230,239,255,0.28),rgba(255,255,255,0.9))]"
              )}
            >
              {value}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function UseCaseClusterGrid({
  items,
}: {
  items: Array<{ title: string; body: string; points?: string[] }>;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item, index) => (
        <PremiumCard key={item.title} className="h-full">
          <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">
            {String(index + 1).padStart(2, "0")}
          </div>
          <h3 className="mt-4 text-2xl font-semibold tracking-[-0.04em] text-slate-950">{item.title}</h3>
          <p className="mt-4 text-sm leading-7 text-[var(--text-secondary)]">{item.body}</p>
          {item.points?.length ? (
            <ul className="mt-6 space-y-2">
              {item.points.map((point) => (
                <li key={point} className="flex gap-3 text-sm leading-7 text-[var(--text-secondary)]">
                  <span className="mt-3 h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent-primary)]/70" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </PremiumCard>
      ))}
    </div>
  );
}
