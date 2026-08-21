import Link from "next/link";
import { redirect } from "next/navigation";
import { FollowupCompleteButton } from "@/components/FollowupCompleteButton";
import { FollowupEditForm } from "@/components/FollowupEditForm";
import {
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  SectionCard,
  StatusBadge,
  UnavailableState,
} from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import {
  DEFAULT_FOLLOWUP_PAGE_SIZE,
  getFollowupQueue,
  type FollowupQueueItem,
  type FollowupQueuePage,
} from "@/lib/follow-ups";
import { hydrateFollowupQueueFromProtectedPii } from "@/lib/pii-protected-followup-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function emptyResults(): FollowupQueuePage {
  return {
    items: [],
    term: "",
    requestedScope: "mine",
    effectiveScope: "mine",
    focus: "all",
    pageSize: DEFAULT_FOLLOWUP_PAGE_SIZE,
    total: 0,
    nextCursor: null,
  };
}

function href(results: FollowupQueuePage, cursor: string | null) {
  const params = new URLSearchParams();
  if (results.term) params.set("q", results.term);
  params.set("scope", results.requestedScope);
  params.set("focus", results.focus);
  params.set("limit", String(results.pageSize));
  if (cursor) params.set("cursor", cursor);
  return `/follow-ups?${params.toString()}`;
}

function dateTime(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function bucket(item: FollowupQueueItem) {
  switch (item.bucket) {
    case "overdue": return { label: "Overdue", tone: "danger" as const };
    case "today": return { label: "Due today", tone: "warning" as const };
    case "upcoming": return { label: "Upcoming", tone: "info" as const };
    default: return { label: "Completed", tone: "ready" as const };
  }
}

function readiness(item: FollowupQueueItem) {
  if (item.declinesAllActions) return "Declines all actions";
  const parts = [
    item.willingActionCount ? `${item.willingActionCount} willing` : "",
    item.consideringActionCount ? `${item.consideringActionCount} considering` : "",
    item.completedActionCount ? `${item.completedActionCount} completed` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Not recorded";
}

export default async function FollowUpsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const parameters = await searchParams;
  let results = emptyResults();
  let unavailable = false;
  let protectedReadEnabled = false;

  try {
    const context = await resolveWorkspaceContext(user);
    const legacyResults = await getFollowupQueue(context, {
      term: parameters.q,
      scope: parameters.scope,
      focus: parameters.focus,
      pageSize: parameters.limit,
      cursor: parameters.cursor,
    });
    results = await hydrateFollowupQueueFromProtectedPii(context.organizationId, legacyResults);
    protectedReadEnabled = isPiiProtectedReadEnabled();
  } catch {
    unavailable = true;
  }

  const constrained = results.requestedScope !== results.effectiveScope;

  return <ProtectedPage permission="recordEngagement"><div className="content">
    <PageHeader
      eyebrow="Daily organizing"
      title="Follow-ups"
      description="Work overdue and due-today commitments first, then upcoming follow-ups. Open items can be rescheduled or reassigned within your authorized CAT scope."
    />

    <SectionCard title="Queue controls" description="Use the queue as your daily task list. Completed items remain visible for 14 days.">
      <form action="/follow-ups" method="get">
        <FilterBar>
          <div className="field">
            <label htmlFor="followup-search">Search</label>
            <input
              id="followup-search"
              name="q"
              type="search"
              maxLength={100}
              defaultValue={results.term}
              placeholder="Employee, department, campaign, organizer…"
            />
          </div>
          <div className="field">
            <label htmlFor="followup-focus">Focus</label>
            <select id="followup-focus" name="focus" defaultValue={results.focus}>
              <option value="all">All open follow-ups</option>
              <option value="overdue">Overdue</option>
              <option value="today">Due today</option>
              <option value="upcoming">Upcoming</option>
              <option value="completed">Completed in last 14 days</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="followup-scope">Scope</label>
            <select id="followup-scope" name="scope" defaultValue={results.requestedScope}>
              <option value="mine">My follow-ups</option>
              <option value="authorized">All authorized follow-ups</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="followup-limit">Rows</label>
            <select id="followup-limit" name="limit" defaultValue={String(results.pageSize)}>
              <option value="25">25</option>
              <option value="50">50</option>
            </select>
          </div>
          <button className="button" type="submit">Update queue</button>
        </FilterBar>
      </form>
      {constrained ? <p className="muted">Your CAT role is limited to follow-ups assigned to you for employees in your current open assignment scope.</p> : null}
    </SectionCard>

    <SectionCard
      title={results.focus === "completed" ? "Recently completed" : "Follow-up queue"}
      description={results.focus === "completed" ? "Completed follow-ups are read-only in this view." : "Open items are ordered overdue, due today, then upcoming. Changes are audited."}
      badge={<StatusBadge tone={unavailable ? "warning" : "info"}>{unavailable ? "Unavailable" : protectedReadEnabled ? `Protected PII · ${results.total} follow-ups` : `${results.total} follow-ups`}</StatusBadge>}
    >
      {unavailable ? <UnavailableState title="Follow-up queue unavailable" description="Follow-up records are withheld because an authorized database and protected-PII context could not be established." />
        : results.items.length === 0 ? <EmptyState title="No follow-ups in this queue" description="No authorized follow-ups matched the selected scope, focus, and search." />
        : <div className="stack">
          {results.items.map((item) => {
            const state = bucket(item);
            return <article className="section-card" key={item.followupHandle}>
              <div className="section-heading">
                <div>
                  <h3>{item.displayName}</h3>
                  <p>{item.classification || "Classification unavailable"}{item.department ? ` · ${item.department}` : ""}{item.workLocation ? ` · ${item.workLocation}` : ""}</p>
                </div>
                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              </div>

              <div className="review-summary">
                <div><strong>{item.status === "completed" ? "Completed" : "Due"}</strong><div>{dateTime(item.completedAt || item.dueAt)}</div></div>
                <div><strong>Assigned to</strong><div>{item.assignedTo || "Unassigned"}</div></div>
                <div><strong>Campaign</strong><div>{item.campaignName || "General outreach"}</div></div>
                <div><strong>Membership</strong><div>{item.membershipStatus}</div></div>
                <div><strong>Latest engagement</strong><div>{dateTime(item.latestEngagementAt)}{item.latestOutcome ? ` · ${item.latestOutcome}` : ""}</div></div>
                <div><strong>Action readiness</strong><div>{readiness(item)}</div></div>
              </div>

              <div className="page-actions">
                <Link className="button secondary" href={`/outreach/${item.employeeHandle}`}>Open employee</Link>
                {item.status === "open" ? <FollowupCompleteButton employeeHandle={item.employeeHandle} followupHandle={item.followupHandle} /> : null}
              </div>

              {item.status === "open" ? <FollowupEditForm
                employeeHandle={item.employeeHandle}
                followupHandle={item.followupHandle}
                dueAt={item.dueAt}
                assignedToHandle={item.assignedToHandle}
                assigneeOptions={item.assigneeOptions}
              /> : null}
            </article>;
          })}
        </div>}

      {!unavailable && results.items.length ? <Pagination
        previousHref={null}
        nextHref={results.nextCursor ? href(results, results.nextCursor) : null}
        label={`Showing up to ${results.pageSize} of ${results.total}`}
      /> : null}
    </SectionCard>
  </div></ProtectedPage>;
}
