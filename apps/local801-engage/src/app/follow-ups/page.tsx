import Link from "next/link";
import { redirect } from "next/navigation";
import { CursorBackButton } from "@/components/CursorBackButton";
import { FollowupCompleteButton } from "@/components/FollowupCompleteButton";
import { FollowupEditForm } from "@/components/FollowupEditForm";
import {
  EmptyState,
  DisclosureCard,
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
import { formatCatDateTime } from "@/lib/date-format";
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
  return formatCatDateTime(value);
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

function membershipStatusLabel(status: FollowupQueueItem["membershipStatus"]) {
  if (status === "member") return "Member";
  if (status === "nonmember") return "Nonmember";
  return "Unknown";
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
  const hasCursor = typeof parameters.cursor === "string" && parameters.cursor.length > 0;

  return <ProtectedPage permission="recordEngagement"><div className="content route-followups-page queue-first-page">
    <PageHeader
      eyebrow="Member outreach"
      title="Follow-ups"
      description="Start with what’s overdue or due today, then work ahead. Open follow-ups can be moved or reassigned when your CAT role allows it."
    />

    <DisclosureCard
      title="Filter follow-ups"
      description="Search the daily queue or change its scope. Completed work remains available for 14 days."
      defaultOpen={Boolean(results.term || results.focus !== "all" || results.requestedScope !== "mine")}
      className="route-secondary-panel queue-filter-panel"
    >
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
              placeholder="Person, department, campaign, organizer…"
            />
          </div>
          <div className="field">
            <label htmlFor="followup-focus">Show</label>
            <select id="followup-focus" name="focus" defaultValue={results.focus}>
              <option value="all">All open follow-ups</option>
              <option value="overdue">Overdue</option>
              <option value="today">Due today</option>
              <option value="upcoming">Upcoming</option>
              <option value="completed">Completed in last 14 days</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="followup-scope">Whose</label>
            <select id="followup-scope" name="scope" defaultValue={results.requestedScope}>
              <option value="mine">My follow-ups</option>
              <option value="authorized">Team follow-ups</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="followup-limit">Results per page</label>
            <select id="followup-limit" name="limit" defaultValue={String(results.pageSize)}>
              <option value="25">25</option>
              <option value="50">50</option>
            </select>
          </div>
          <button className="button" type="submit">Apply filters</button>
        </FilterBar>
      </form>
      {constrained ? <p className="muted">Your CAT role only shows follow-ups assigned to you for people in your current assignment scope.</p> : null}
    </DisclosureCard>

    <SectionCard
      title={results.focus === "completed" ? "Recently completed" : "Follow-ups"}
      description={results.focus === "completed" ? `${results.total} completed follow-up${results.total === 1 ? "" : "s"} retained for 14 days.` : `${results.total} follow-up${results.total === 1 ? "" : "s"}; overdue items appear first, followed by today and upcoming work. Changes are recorded in the audit log.`}
      badge={protectedReadEnabled && !unavailable ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
    >
      {unavailable ? <UnavailableState title="Follow-ups are unavailable" description="We couldn’t load the follow-up list safely. No member details are shown when the protected data checks fail." />
        : results.items.length === 0 ? <EmptyState title="No follow-ups here" description="Nothing matches the filters you chose." />
        : <div className="stack">
          {results.items.map((item) => {
            const state = bucket(item);
            return <article className="section-card followup-person-card" key={item.followupHandle}>
              <div className="section-heading">
                <div>
                  <h3>{item.displayName}</h3>
                  <p>{item.classification || "Classification unavailable"}{item.department ? ` · ${item.department}` : ""}{item.workLocation ? ` · ${item.workLocation}` : ""}</p>
                </div>
                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              </div>

              <div className="review-summary followup-person-fields">
                <div><strong>{item.status === "completed" ? "Completed" : "Due"}</strong><div>{dateTime(item.completedAt || item.dueAt)}</div></div>
                <div><strong>Assigned to</strong><div>{item.assignedTo || "Unassigned"}</div></div>
                <div><strong>Campaign</strong><div>{item.campaignName || "General outreach"}</div></div>
                <div><strong>Membership</strong><div>{membershipStatusLabel(item.membershipStatus)}</div></div>
                <div><strong>Last conversation</strong><div>{dateTime(item.latestEngagementAt)}{item.latestOutcome ? ` · ${item.latestOutcome}` : ""}</div></div>
                <div><strong>Action readiness</strong><div>{readiness(item)}</div></div>
              </div>

              <div className="page-actions followup-card-actions">
                <Link className="button secondary" href={`/outreach/${item.employeeHandle}`}>Open outreach record</Link>
                {item.status === "open" ? <FollowupCompleteButton employeeHandle={item.employeeHandle} followupHandle={item.followupHandle} personName={item.displayName} /> : null}
              </div>

              {item.status === "open" ? <DisclosureCard
                title="Reschedule or reassign"
                description="Change the due time or organizer."
                className="record-action-disclosure"
              >
                <FollowupEditForm
                  employeeHandle={item.employeeHandle}
                  followupHandle={item.followupHandle}
                  dueAt={item.dueAt}
                  assignedToHandle={item.assignedToHandle}
                  assigneeOptions={item.assigneeOptions}
                />
              </DisclosureCard> : null}
            </article>;
          })}
        </div>}

      {!unavailable && results.items.length ? <div className="stack compact-stack">
        {hasCursor ? <div className="page-actions"><CursorBackButton fallbackHref={href(results, null)} /></div> : null}
        <Pagination
          previousHref={null}
          nextHref={results.nextCursor ? href(results, results.nextCursor) : null}
          label={`Showing up to ${results.pageSize} of ${results.total}`}
        />
      </div> : null}
    </SectionCard>
  </div></ProtectedPage>;
}
