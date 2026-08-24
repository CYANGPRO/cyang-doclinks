import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertBanner,
  DisclosureCard,
  EmptyState,
  FilterBar,
  PageHeader,
  SectionCard,
  StatCard,
  StatusBadge,
  UnavailableState,
} from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { SaveCurrentView } from "@/components/WorkPreferenceControls";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import {
  getWorkloadCalendar,
  type WorkloadCalendarBucket,
  type WorkloadCalendarEntry,
  type WorkloadCalendarKind,
  type WorkloadCalendarResult,
} from "@/lib/workload-calendar";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type SourceFilter = "all" | WorkloadCalendarKind;
type WindowFilter = "all" | WorkloadCalendarBucket;

const sourceLabels: Record<WorkloadCalendarKind, string> = {
  followup: "Follow-up",
  campaign: "Campaign deadline",
  cat_action: "CAT Action due work",
};

const bucketLabels: Record<WorkloadCalendarBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  next7: "Next 7 days",
  later: "Later",
};

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function sourceFilter(value: string | string[] | undefined): SourceFilter {
  const raw = scalar(value);
  return raw === "followup" || raw === "campaign" || raw === "cat_action" ? raw : "all";
}

function windowFilter(value: string | string[] | undefined): WindowFilter {
  const raw = scalar(value);
  return raw === "overdue" || raw === "today" || raw === "next7" || raw === "later" ? raw : "all";
}

function dateLabel(entry: WorkloadCalendarEntry) {
  if (!entry.dueAt) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${entry.dateKey}T12:00:00Z`));
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(entry.dueAt));
}

function bucketTone(bucket: WorkloadCalendarBucket) {
  if (bucket === "overdue") return "danger" as const;
  if (bucket === "today") return "warning" as const;
  if (bucket === "next7") return "info" as const;
  return "ready" as const;
}

function metricNumber(value: number | string) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyResult(): WorkloadCalendarResult | null {
  return null;
}

export default async function WorkloadPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const parameters = await searchParams;
  const requestedSource = sourceFilter(parameters.source);
  const selectedSource = requestedSource === "campaign" && !can(user.role, "manageCampaigns")
    ? "all"
    : requestedSource === "cat_action" && !can(user.role, "manageCatActions")
      ? "all"
      : requestedSource;
  const selectedWindow = windowFilter(parameters.window);
  let result = emptyResult();
  let unavailable = false;

  try {
    const context = await resolveWorkspaceContext(user);
    result = await getWorkloadCalendar(context);
  } catch {
    unavailable = true;
  }

  const entries = result?.entries.filter((entry) => (
    (selectedSource === "all" || entry.kind === selectedSource)
    && (selectedWindow === "all" || entry.bucket === selectedWindow)
  )) ?? [];
  const grouped = (["overdue", "today", "next7", "later"] as const)
    .map((bucket) => ({ bucket, entries: entries.filter((entry) => entry.bucket === bucket) }))
    .filter((group) => selectedWindow === "all" ? group.entries.length > 0 : group.bucket === selectedWindow);

  const metrics = result?.metrics;
  const anyTruncated = Boolean(result && (result.truncation.followups || result.truncation.campaigns || result.truncation.catActions));
  const followupScope = result?.scope ?? "mine";

  return <ProtectedPage permission="recordEngagement"><div className="content route-workload-page task-first-page">
    <PageHeader
      eyebrow="Member outreach"
      title="Work planner"
      description="See follow-ups and other due work in one place. This view helps you plan your time—it doesn’t change assignments or rate anyone."
      actions={<div className="page-actions">
        <Link className="button" href={`/follow-ups?scope=${followupScope}`}>Open follow-ups</Link>
        <Link className="button secondary" href="/outreach">Open my list</Link>
      </div>}
    />

    <AlertBanner title="Planning only" tone="info">
      What you see here follows the same access rules as the rest of the app. Campaign and CAT Action dates appear only if your role already gives you access to them.
    </AlertBanner>

    {unavailable || !result || !metrics ? <SectionCard><UnavailableState title="Work planner unavailable" description="We couldn’t load your planning view safely. No member data is substituted when that happens." /></SectionCard> : <>
      <section className="metrics-grid" aria-label="Work planner summary">
        <StatCard label="Overdue follow-ups" value={metrics.overdueFollowups} detail={result.scopeLabel} tone={metricNumber(metrics.overdueFollowups) > 0 ? "attention" : "default"} />
        <StatCard label="Due today" value={metrics.followupsDueToday} detail={result.scopeLabel} tone={metricNumber(metrics.followupsDueToday) > 0 ? "attention" : "default"} />
        <StatCard label="Coming up" value={metrics.upcomingFollowups} detail={result.scopeLabel} />
        <StatCard label="Items on calendar" value={result.entries.length} detail="Follow-ups and other due work you can access" tone="brand" />
      </section>

      <DisclosureCard
        title="Filter daily work"
        description="Narrow the agenda without changing assignments or records."
        defaultOpen={selectedSource !== "all" || selectedWindow !== "all"}
        className="route-secondary-panel workload-filter-panel"
      >
        <form action="/workload" key={`${selectedSource}:${selectedWindow}`} method="get">
          <FilterBar>
            <div className="field">
              <label htmlFor="workload-source">Work type</label>
              <select id="workload-source" name="source" defaultValue={selectedSource}>
                <option value="all">Everything I can see</option>
                <option value="followup">Follow-ups</option>
                {can(user.role, "manageCampaigns") ? <option value="campaign">Campaign deadlines</option> : null}
                {can(user.role, "manageCatActions") ? <option value="cat_action">CAT Action due work</option> : null}
              </select>
            </div>
            <div className="field">
              <label htmlFor="workload-window">When</label>
              <select id="workload-window" name="window" defaultValue={selectedWindow}>
                <option value="all">All dates</option>
                <option value="overdue">Overdue</option>
                <option value="today">Today</option>
                <option value="next7">Next 7 days</option>
                <option value="later">Later</option>
              </select>
            </div>
            <button className="button" type="submit">Apply filters</button>
            <Link className="button secondary" href="/workload">Clear all</Link>
          </FilterBar>
        </form>
      </DisclosureCard>

      <DisclosureCard title="Save this view" description="Keep these filters as a shortcut; person identifiers and search text are never saved." className="route-secondary-panel">
        <SaveCurrentView destination="/workload" queryParams={{ source: selectedSource, window: selectedWindow }} />
      </DisclosureCard>

      {anyTruncated ? <AlertBanner title="Some lists are shortened here" tone="preview">
        The planner keeps long source lists bounded. Use the linked work pages when you need the complete queue; the follow-up totals above are still complete for your role and scope.
      </AlertBanner> : null}

      <SectionCard
        title="Due-date calendar"
        description={`${entries.length} ${entries.length === 1 ? "work item matches" : "work items match"} the current filters. Dates use Central Time; campaigns use their end date and CAT Actions use the earliest due date from an open task.`}
      >
        {entries.length === 0 ? <EmptyState title="Nothing in this view" description="No work matches the filters you chose." /> : <div className="stack">
          {grouped.map((group) => <section className="stack" key={group.bucket} aria-labelledby={`workload-${group.bucket}`}>
            <div className="section-heading">
              <div><h3 id={`workload-${group.bucket}`}>{bucketLabels[group.bucket]}</h3><p>{group.entries.length} item{group.entries.length === 1 ? "" : "s"}</p></div>
              <StatusBadge tone={bucketTone(group.bucket)}>{bucketLabels[group.bucket]}</StatusBadge>
            </div>
            <div className="stack">
              {group.entries.map((entry) => <article className="section-card" key={entry.key}>
                <div className="section-heading">
                  <div>
                    <h4>{entry.title}</h4>
                    <p>{sourceLabels[entry.kind]} · {dateLabel(entry)}</p>
                  </div>
                  <StatusBadge tone={bucketTone(entry.bucket)}>{bucketLabels[entry.bucket]}</StatusBadge>
                </div>
                <p className="muted">{entry.detail}</p>
                {entry.assignedTo ? <p><strong>Assigned to:</strong> {entry.assignedTo}</p> : null}
                <div className="page-actions"><Link className="button secondary" href={entry.href}>Open {entry.kind === "followup" ? "outreach record" : entry.kind === "campaign" ? "campaign" : "CAT Action"}</Link></div>
              </article>)}
            </div>
          </section>)}
        </div>}
      </SectionCard>

      <DisclosureCard title="How workload counts should be interpreted" description="These are scheduled-work totals, not evaluations of a person or team." className="route-secondary-panel">
        <p className="muted">These counts show scheduled work and recorded workflow status. They are not productivity ratings, organizer rankings, member scores, or performance evaluations. A larger list can simply mean a different assignment mix or more work coming due.</p>
        {can(user.role, "viewReports") ? <div className="page-actions"><Link className="button secondary" href="/reports?view=overview&period=30d">See CAT team workload</Link></div> : null}
      </DisclosureCard>
    </>}
  </div></ProtectedPage>;
}
