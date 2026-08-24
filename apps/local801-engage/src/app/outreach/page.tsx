import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertBanner, EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { FieldConnectionStatus } from "@/components/FieldConnectionStatus";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { fieldPersonHref, fieldQueueHref, member360Href, normalizeFieldModeContext } from "@/lib/field-mode";
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

function href(results: OutreachQueuePage, cursor: string | null, fieldMode: boolean) {
  const params = new URLSearchParams();
  if (!fieldMode && results.term) params.set("q", results.term);
  if (fieldMode) params.set("field", "1");
  params.set("scope", fieldMode ? results.effectiveScope : results.requestedScope);
  params.set("focus", results.focus);
  params.set("limit", String(results.pageSize));
  if (cursor) params.set("cursor", cursor);
  return `/outreach?${params.toString()}`;
}

function priority(priority: OutreachPriority) {
  switch (priority) {
    case "overdue_followup": return { label: "Overdue follow-up", tone: "danger" as const };
    case "due_today": return { label: "Due today", tone: "warning" as const };
    case "never_engaged": return { label: "No conversation recorded", tone: "pending" as const };
    case "stale_90_days": return { label: "90+ days since contact", tone: "warning" as const };
    case "upcoming": return { label: "Coming up", tone: "info" as const };
    default: return { label: "Recently contacted", tone: "ready" as const };
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

function peopleCountLabel(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? "person" : "people"}`;
}

function membershipStatusLabel(status: OutreachQueuePage["people"][number]["membershipStatus"]) {
  if (status === "member") return "Member";
  if (status === "nonmember") return "Nonmember";
  return "Unknown";
}

export default async function OutreachPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const parameters = await searchParams;
  const hasCursor = typeof parameters.cursor === "string" && parameters.cursor.length > 0;
  const requestedFieldContext = normalizeFieldModeContext(parameters);
  const fieldMode = requestedFieldContext.enabled;
  let results = emptyResults();
  let unavailable = false;
  let protectedReadMode: "legacy" | "preview" | "protected" = "legacy";
  try {
    const context = await resolveWorkspaceContext(user);
    protectedReadMode = getPiiProtectedReadMode();
    const input = {
      term: fieldMode ? undefined : parameters.q,
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
  const canonicalFieldContext = {
    scope: results.effectiveScope,
    focus: results.focus,
    limit: results.pageSize === 50 ? 50 as const : 25 as const,
  };
  const startFieldHref = fieldQueueHref(canonicalFieldContext);
  const currentQueueHref = href(results, typeof parameters.cursor === "string" ? parameters.cursor : null, fieldMode);

  return <ProtectedPage permission="recordEngagement"><div className={`content outreach-page ${fieldMode ? "outreach-field-queue-page" : "outreach-plan-page"}`}>
    <PageHeader
      eyebrow={fieldMode ? "Member outreach · Field view" : "Member outreach"}
      title={fieldMode ? "Field outreach list" : "My outreach list"}
      description={fieldMode
        ? "Work through your current list one person at a time. When you come back, the list refreshes using the latest assignments and follow-ups."
        : "The people you’re responsible for, ordered so overdue follow-ups and people who need attention rise to the top."}
      actions={fieldMode
        ? <Link className="button secondary outreach-header-action outreach-exit-field-action" href="/outreach">Exit field view</Link>
        : <Link className="button outreach-header-action outreach-start-field-action" href={startFieldHref}>Start field view</Link>}
    />

    {fieldMode ? <>
      <FieldConnectionStatus />
      <AlertBanner title="Field view needs a connection" tone="preview">
        Member details, notes, and form responses are never saved for offline use. If your connection drops, reconnect before opening or recording member work.
      </AlertBanner>
    </> : null}

    <SectionCard className="outreach-filter-card" title={fieldMode ? "Choose this field pass" : "Choose what to work on"} description={fieldMode ? "Pick the focus for this pass. Search is turned off in field view so names and search text are not carried from person to person." : "Use these filters to narrow your list. Your role and assignments still control who you can see."}>
      <form action="/outreach" method="get">
        <FilterBar>
          {fieldMode ? <input type="hidden" name="field" value="1" /> : <div className="field"><label htmlFor="outreach-search">Search</label><input id="outreach-search" name="q" type="search" maxLength={100} defaultValue={results.term} placeholder="Name, department, location, classification, or work email" /></div>}
          <div className="field"><label htmlFor="outreach-focus">Focus</label><select id="outreach-focus" name="focus" defaultValue={results.focus}><option value="all">Everyone in my list</option><option value="attention">Needs attention</option><option value="never-engaged">No conversation recorded</option><option value="stale">90+ days since contact</option></select></div>
          <div className="field"><label htmlFor="outreach-scope">Scope</label><select id="outreach-scope" name="scope" defaultValue={fieldMode ? results.effectiveScope : results.requestedScope}><option value="assigned">My assignments</option><option value="authorized">Everyone I can access</option></select></div>
          <div className="field"><label htmlFor="outreach-limit">Rows</label><select id="outreach-limit" name="limit" defaultValue={String(results.pageSize)}><option value="25">25</option><option value="50">50</option></select></div>
          <button className="button" type="submit">Update list</button>
        </FilterBar>
      </form>
      {constrained ? <p className="muted">Your CAT role only shows people where you’re a current primary or backup organizer.</p> : null}
    </SectionCard>

    <SectionCard className="outreach-primary-queue" title={fieldMode ? "People in this field pass" : "People assigned for outreach"} description={unavailable ? undefined : peopleCountLabel(results.total)} badge={protectedReadMode === "protected" && !unavailable ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}>
      {unavailable ? <UnavailableState title="Your list is unavailable" description="We couldn’t load this list safely. Try again after the database connection and protected member-data checks are available." />
        : results.people.length === 0 ? <EmptyState title="No one matches this view" description="Try a different focus, scope, or search." />
        : <div className="stack">
          {results.people.map((person) => {
            const state = priority(person.priority);
            const employeeHref = fieldMode ? fieldPersonHref(person.handle, canonicalFieldContext) : member360Href(person.handle, currentQueueHref);
            const contactOptions = [
              { label: "Cell phone", value: person.cellPhone, href: person.cellPhone ? `tel:${person.cellPhone}` : null },
              { label: "Home phone", value: person.homePhone, href: person.homePhone ? `tel:${person.homePhone}` : null },
              { label: "Work phone", value: person.workPhone, href: person.workPhone ? `tel:${person.workPhone}` : null },
              { label: "Home email", value: person.homeEmail, href: person.homeEmail ? `mailto:${person.homeEmail}` : null },
              { label: "Work email", value: person.workEmail, href: person.workEmail ? `mailto:${person.workEmail}` : null },
            ];
            return <article className="section-card outreach-person-card" key={person.handle}>
              <div className="section-heading">
                <div><h3>{person.displayName}</h3><p>{person.classification || "Classification unavailable"}{person.department ? ` · ${person.department}` : ""}{person.workLocation ? ` · ${person.workLocation}` : ""}</p></div>
                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              </div>
              <div className="review-summary outreach-person-fields">
                <div><strong>Membership</strong><div>{membershipStatusLabel(person.membershipStatus)}</div></div>
                <div><strong>Your role</strong><div>{person.assignmentRelationship === "primary" ? "Primary organizer" : person.assignmentRelationship === "backup" ? "Backup organizer" : "View only"}</div></div>
                <div><strong>Last conversation</strong><div>{dateTime(person.latestEngagementAt)}{person.latestOutcome ? ` · ${person.latestOutcome}` : ""}</div></div>
                <div><strong>Follow-up</strong><div>{person.overdueFollowupCount ? `${person.overdueFollowupCount} overdue` : person.openFollowupCount ? `${person.openFollowupCount} open · next ${dateTime(person.nextFollowupAt)}` : "No open follow-up"}</div></div>
                <div><strong>Action readiness</strong><div>{readiness(person)}</div></div>
                {contactOptions.map((contact) => <div key={contact.label}>
                  <strong>{contact.label}</strong>
                  <div>{contact.href ? <a href={contact.href}>{contact.value}</a> : <span className="muted">Not recorded</span>}</div>
                </div>)}
              </div>
              <div className="page-actions outreach-card-actions"><Link className="button outreach-card-primary-action" href={employeeHref}>{fieldMode ? "Open and record" : "Open outreach record"}</Link></div>
            </article>;
          })}
        </div>}
      {!unavailable && results.people.length ? <Pagination previousHref={results.previousCursor ? href(results, results.previousCursor, fieldMode) : null} historyBackFallbackHref={hasCursor && !results.previousCursor ? href(results, null, fieldMode) : null} nextHref={results.nextCursor ? href(results, results.nextCursor, fieldMode) : null} label={`Showing up to ${results.pageSize} of ${results.total}`} /> : null}
    </SectionCard>
  </div></ProtectedPage>;
}
