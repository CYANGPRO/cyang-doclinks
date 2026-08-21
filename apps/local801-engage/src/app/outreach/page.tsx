import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { DEFAULT_OUTREACH_PAGE_SIZE, getOutreachQueue, type OutreachPriority, type OutreachQueuePage } from "@/lib/outreach";
import { getProtectedOutreachQueue } from "@/lib/pii-protected-outreach-query";
import { getPiiProtectedReadMode } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function emptyResults(): OutreachQueuePage {
  return {
    people: [], term: "", requestedScope: "assigned", effectiveScope: "assigned", focus: "all",
    pageSize: DEFAULT_OUTREACH_PAGE_SIZE, total: 0, previousCursor: null, nextCursor: null,
  };
}

function href(results: OutreachQueuePage, cursor: string | null) {
  const params = new URLSearchParams();
  if (results.term) params.set("q", results.term);
  params.set("scope", results.requestedScope);
  params.set("focus", results.focus);
  params.set("limit", String(results.pageSize));
  if (cursor) params.set("cursor", cursor);
  return `/outreach?${params.toString()}`;
}

function priority(priority: OutreachPriority) {
  switch (priority) {
    case "overdue_followup": return { label: "Overdue follow-up", tone: "danger" as const };
    case "due_today": return { label: "Due today", tone: "warning" as const };
    case "never_engaged": return { label: "Never engaged", tone: "pending" as const };
    case "stale_90_days": return { label: "90+ days since contact", tone: "warning" as const };
    case "upcoming": return { label: "Upcoming work", tone: "info" as const };
    default: return { label: "Recently engaged", tone: "ready" as const };
  }
}

function dateTime(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

function readiness(person: OutreachQueuePage["people"][number]) {
  if (person.declinesAllActions) return "Declines all actions";
  const parts = [
    person.willingActionCount ? `${person.willingActionCount} willing` : "",
    person.consideringActionCount ? `${person.consideringActionCount} considering` : "",
    person.completedActionCount ? `${person.completedActionCount} completed` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Action readiness not recorded";
}

export default async function OutreachPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const parameters = await searchParams;
  let results = emptyResults();
  let unavailable = false;
  let protectedReadMode: "legacy" | "preview" | "protected" = "legacy";
  try {
    const context = await resolveWorkspaceContext(user);
    protectedReadMode = getPiiProtectedReadMode();
    const input = {
      term: parameters.q,
      scope: parameters.scope,
      focus: parameters.focus,
      pageSize: parameters.limit,
      cursor: parameters.cursor,
    };
    results = protectedReadMode === "legacy"
      ? await getOutreachQueue(context, input)
      : await getProtectedOutreachQueue(context, input);
  } catch {
    unavailable = true;
  }

  const constrained = results.requestedScope !== results.effectiveScope;

  return <ProtectedPage permission="recordEngagement"><div className="content">
    <PageHeader eyebrow="Daily organizing" title="My outreach" description="Work your current employee assignments in priority order, with follow-up and Action Readiness context available before each conversation." />

    <SectionCard title="Queue controls" description="Priority and access scope are enforced on the server.">
      <form action="/outreach" method="get">
        <FilterBar>
          <div className="field"><label htmlFor="outreach-search">Search</label><input id="outreach-search" name="q" type="search" maxLength={100} defaultValue={results.term} placeholder="Name, department, location, classification, or work email" /></div>
          <div className="field"><label htmlFor="outreach-focus">Focus</label><select id="outreach-focus" name="focus" defaultValue={results.focus}><option value="all">All prioritized work</option><option value="attention">Needs attention</option><option value="never-engaged">Never engaged</option><option value="stale">90+ days stale</option></select></div>
          <div className="field"><label htmlFor="outreach-scope">Scope</label><select id="outreach-scope" name="scope" defaultValue={results.requestedScope}><option value="assigned">My current assignments</option><option value="authorized">All authorized employees</option></select></div>
          <div className="field"><label htmlFor="outreach-limit">Rows</label><select id="outreach-limit" name="limit" defaultValue={String(results.pageSize)}><option value="25">25</option><option value="50">50</option></select></div>
          <button className="button" type="submit">Update queue</button>
        </FilterBar>
      </form>
      {constrained ? <p className="muted">Your CAT role is limited to current open primary or backup assignments. URL parameters cannot broaden that scope.</p> : null}
    </SectionCard>

    <SectionCard title="My assignment queue" badge={<StatusBadge tone={unavailable ? "warning" : "info"}>{unavailable ? "Unavailable" : protectedReadMode === "preview" ? `Protected-read Preview · ${results.total} employees` : protectedReadMode === "protected" ? `Protected PII · ${results.total} employees` : `${results.total} employees`}</StatusBadge>}>
      {unavailable ? <UnavailableState title="Outreach queue unavailable" description="Employee records are withheld because an authorized database and protected-PII context could not be established." />
        : results.people.length === 0 ? <EmptyState title="No employees in this queue" description="No active, authorized employees matched the current scope and focus." />
        : <div className="stack">
          {results.people.map((person) => {
            const state = priority(person.priority);
            return <article className="section-card" key={person.handle}>
              <div className="section-heading">
                <div><h3>{person.displayName}</h3><p>{person.classification || "Classification unavailable"}{person.department ? ` · ${person.department}` : ""}{person.workLocation ? ` · ${person.workLocation}` : ""}</p></div>
                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              </div>
              <div className="review-summary">
                <div><strong>Membership</strong><div>{person.membershipStatus}</div></div>
                <div><strong>Assignment</strong><div>{person.assignmentRelationship === "primary" ? "Primary organizer" : person.assignmentRelationship === "backup" ? "Backup organizer" : "Authorized view"}</div></div>
                <div><strong>Last engagement</strong><div>{dateTime(person.latestEngagementAt)}{person.latestOutcome ? ` · ${person.latestOutcome}` : ""}</div></div>
                <div><strong>Follow-up</strong><div>{person.overdueFollowupCount ? `${person.overdueFollowupCount} overdue` : person.openFollowupCount ? `${person.openFollowupCount} open · next ${dateTime(person.nextFollowupAt)}` : "No open follow-up"}</div></div>
                <div><strong>Action readiness</strong><div>{readiness(person)}</div></div>
                <div><strong>Work email</strong><div>{person.workEmail ? <a href={`mailto:${person.workEmail}`}>{person.workEmail}</a> : <span className="muted">Unavailable</span>}</div></div>
              </div>
              <div className="page-actions"><Link className="button" href={`/outreach/${person.handle}`}>Open employee</Link></div>
            </article>;
          })}
        </div>}
      {!unavailable && results.people.length ? <Pagination previousHref={results.previousCursor ? href(results, results.previousCursor) : null} nextHref={results.nextCursor ? href(results, results.nextCursor) : null} label={`Showing up to ${results.pageSize} of ${results.total}`} /> : null}
    </SectionCard>
  </div></ProtectedPage>;
}
