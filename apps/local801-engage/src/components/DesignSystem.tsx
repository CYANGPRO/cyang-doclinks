import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="page-kicker">{eyebrow}</span>
        <h1 className="page-title">{title}</h1>
        <p className="page-copy">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function SectionCard({ title, description, badge, children, className = "" }: {
  title?: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section-card ${className}`.trim()}>
      {title || badge ? (
        <div className="section-heading">
          <div>{title ? <h2>{title}</h2> : null}{description ? <p>{description}</p> : null}</div>
          {badge}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({ label, value, detail, tone = "default" }: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "default" | "brand" | "attention" | "danger";
}) {
  return (
    <article className={`stat-card stat-card-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {detail ? <div className="stat-detail">{detail}</div> : null}
    </article>
  );
}

export type StatusTone = "neutral" | "info" | "ready" | "pending" | "warning" | "blocked" | "danger" | "preview";

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`status-badge status-${tone}`}><span aria-hidden="true">●</span>{children}</span>;
}

function State({ title, description, tone, action }: {
  title: string;
  description: string;
  tone: "empty" | "error" | "loading" | "unavailable";
  action?: ReactNode;
}) {
  return (
    <div className={`state-panel state-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="state-icon" aria-hidden="true">{tone === "error" ? "!" : tone === "loading" ? "…" : "○"}</div>
      <div><strong>{title}</strong><p>{description}</p>{action ? <div className="state-action">{action}</div> : null}</div>
    </div>
  );
}

export function EmptyState(props: Omit<Parameters<typeof State>[0], "tone">) {
  return <State {...props} tone="empty" />;
}
export function ErrorState(props: Omit<Parameters<typeof State>[0], "tone">) {
  return <State {...props} tone="error" />;
}
export function LoadingState(props: Omit<Parameters<typeof State>[0], "tone">) {
  return <State {...props} tone="loading" />;
}
export function UnavailableState(props: Omit<Parameters<typeof State>[0], "tone">) {
  return <State {...props} tone="unavailable" />;
}

export function AlertBanner({ title, children, tone = "info" }: {
  title: string;
  children: ReactNode;
  tone?: "info" | "warning" | "danger" | "preview";
}) {
  return <aside className={`alert-banner alert-${tone}`} role={tone === "danger" ? "alert" : "status"}><strong>{title}</strong><div>{children}</div></aside>;
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}

export function Pagination({ nextHref, previousHref, label }: {
  nextHref?: string | null;
  previousHref?: string | null;
  label: string;
}) {
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination-previous">{previousHref ? <Link className="button secondary" href={previousHref}>Previous</Link> : null}</span>
      <span className="pagination-label">{label}</span>
      <span className="pagination-next">{nextHref ? <Link className="button secondary" href={nextHref}>Next</Link> : null}</span>
    </nav>
  );
}

export function DataTable({ caption, headers, children }: {
  caption: string;
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div>
      <p className="table-scroll-hint">Swipe horizontally to see all columns.</p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
        <table className="data-table">
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function ReviewSummary({ children }: { children: ReactNode }) {
  return <div className="review-summary">{children}</div>;
}

export function ProgressStatus({ label, value, detail }: { label: string; value: number; detail: string }) {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-status">
      <div className="progress-label"><span>{label}</span><strong>{bounded}%</strong></div>
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bounded}>
        <div className="progress-fill" style={{ width: `${bounded}%` }} />
      </div>
      <span className="stat-detail">{detail}</span>
    </div>
  );
}
