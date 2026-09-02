import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertBanner, AppliedFilterSummary, DisclosureCard, EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { FieldConnectionStatus } from "@/components/FieldConnectionStatus";
import { MobileFieldViewSwitch } from "@/components/MobileFieldViewSwitch";
import { ProtectedPage } from "@/components/ProtectedPage";
import { QueueDensity } from "@/components/QueueDensity";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDateTime } from "@/lib/date-format";
import { fieldPersonHref, fieldQueueHref, member360Href, normalizeFieldModeContext, standardQueueHref } from "@/lib/field-mode";
import { DEFAULT_OUTREACH_PAGE_SIZE, getOutreachQueue, type OutreachPriority, type OutreachQueuePage } from "@/lib/outreach";
import { getProtectedOutreachQueue } from "@/lib/pii-protected-outreach-query";
import { getPiiProtectedReadMode } from "@/lib/pii-protected-read";
import { hydrateOutreachAssigneeOptionsFromProtectedPii } from "@/lib/pii-protected-outreach-read";
import { getOutreachAssignmentOptions } from "@/lib/outreach-assignment";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function emptyResults(): OutreachQueuePage {
  return {
    people: [], term: "", requestedScope: "assigned", effectiveScope: "assigned", focus: "all",
    assigneeHandle: null, actionHandle: null,
    pageSize: DEFAULT_OUTREACH_PAGE_SIZE, total: 0, previousCursor: null, nextCursor: null,
  };
}

function href(results: OutreachQueuePage, cursor: string | null, fieldMode: boolean, standardView: boolean) {
  const params = new URLSearchParams();
  if (!fieldMode && results.term) params.set("q", results.term);
  if (fieldMode) params.set("field", "1");
  if (!fieldMode && standardView) params.set("view", "standard");
  params.set("scope", fieldMode ? results.effectiveScope : results.requestedScope);
  params.set("focus", results.focus);
  if (results.assigneeHandle) params.set("assignee", results.assigneeHandle);
  if (results.actionHandle) params.set("action", results.actionHandle);
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
  return formatCatDateTime(value);
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

function focusLabel(focus: OutreachQueuePage["focus"]) {
  if (focus === "attention") return "Needs attention";
  if (focus === "never-engaged") return "No conversation recorded";
  if (focus === "stale") return "90+ days since contact";
  if (focus === "assigned") return "Active organizer assignment";
  if (focus === "unassigned") return "No active organizer assignment";
  if (focus === "contacted") return "Contact recorded";
  if (focus === "willing") return "Willing to act";
  return "";
}

export default async function OutreachPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const parameters = await searchParams;
  const hasCursor = typeof parameters.cursor === "string" && parameters.cursor.length > 0;
  const requestedFieldContext = normalizeFieldModeContext(parameters);
  const fieldMode = requestedFieldContext.enabled;
  const standardView = !fieldMode && (Array.isArray(parameters.view) ? parameters.view[0] : parameters.view) === "standard";
  let results = emptyResults();
  let unavailable = false;
  let protectedReadMode: "legacy" | "preview" | "protected" = "legacy";
  let assigneeOptions: Array<{ handle: string; label: string; current?: boolean }> = [];
  try {
    const context = await resolveWorkspaceContext(user);
    protectedReadMode = getPiiProtectedReadMode();
    const input = {
      term: fieldMode ? undefined : parameters.q,
      scope: parameters.scope,
      focus: parameters.focus,
      assignee: parameters.assignee,
      action: parameters.action,
      pageSize: parameters.limit,
      cursor: parameters.cursor,
    };
    const queuePromise = protectedReadMode === "legacy"
      ? getOutreachQueue(context, input)
      : getProtectedOutreachQueue(context, input);
    const optionsPromise = can(user.role, "assignOutreach")
      ? getOutreachAssignmentOptions(context).then((rawOptions) => protectedReadMode === "legacy"
        ? rawOptions
        : hydrateOutreachAssigneeOptionsFromProtectedPii(context.organizationId, rawOptions))
      : Promise.resolve([]);
    [results, assigneeOptions] = await Promise.all([queuePromise, optionsPromise]);
  } catch {
    unavailable = true;
  }

  const constrained = results.requestedScope !== results.effectiveScope;
  const canonicalFieldContext = {
    scope: results.effectiveScope,
    focus: results.focus === "willing" || results.focus === "assigned" || results.focus === "unassigned" || results.focus === "contacted" ? "all" as const : results.focus,
    limit: results.pageSize === 50 ? 50 as const : 25 as const,
  };
  const startFieldHref = fieldQueueHref(canonicalFieldContext);
  const exitFieldHref = standardQueueHref(canonicalFieldContext);
  const currentQueueHref = href(results, typeof parameters.cursor === "string" ? parameters.cursor : null, fieldMode, standardView);
  const filterSummary = [
    !fieldMode && results.term ? `Search: ${results.term}` : "",
    results.focus !== "all" ? `Focus: ${focusLabel(results.focus)}` : "",
    !fieldMode && results.requestedScope === "authorized" ? "Everyone I can access" : "",
    results.assigneeHandle ? `Organizer: ${assigneeOptions.find((option) => option.handle === results.assigneeHandle)?.label ?? "selected organizer"}` : "",
    results.actionHandle ? "Specific willing action" : "",
  ].filter(Boolean);

  return <ProtectedPage permission="recordEngagement"><div className={`content outreach-page ${fieldMode ? "outreach-field-queue-page" : "outreach-plan-page"}`}>
    <PageHeader
      eyebrow={fieldMode ? "Member outreach · Field view" : "Member outreach"}
      title={fieldMode ? "Field outreach list" : "My outreach list"}
      description={fieldMode
        ? "Work through your current list one person at a time. When you come back, the list refreshes using the latest assignments and follow-ups."
        : "The people you’re responsible for, ordered so overdue follow-ups and people who need attention rise to the top."}
      actions={<MobileFieldViewSwitch
        allowAutomaticMobileDefault={!standardView}
        fieldHref={startFieldHref}
        fieldMode={fieldMode}
        standardHref={exitFieldHref}
      />}
    />

    {fieldMode ? <>
      <FieldConnectionStatus />
      <AlertBanner title="Field view needs a connection" tone="preview">
        Member details, notes, and form responses are never saved for offline use. If your connection drops, reconnect before opening or recording member work.
      </AlertBanner>
    </> : null}

    <DisclosureCard className="outreach-filter-card queue-filter-panel" title={fieldMode ? "Choose this field pass" : "Choose what to work on"} description={fieldMode ? "Pick the focus for this pass. Search is turned off in field view so names and search text are not carried from person to person." : filterSummary.length ? `${filterSummary.length} filter${filterSummary.length === 1 ? "" : "s"} applied. Open to change the current view.` : "Use these filters to narrow your list. Your role and assignments still control who you can see."} defaultOpen={fieldMode || filterSummary.length === 0}>
      <form action="/outreach" method="get">
        <FilterBar>
          {fieldMode ? <input type="hidden" name="field" value="1" /> : <div className="field"><label htmlFor="outreach-search">Search</label><input id="outreach-search" name="q" type="search" maxLength={100} defaultValue={results.term} placeholder="Name, department, location, classification, or work email" /></div>}
          {standardView ? <input type="hidden" name="view" value="standard" /> : null}
          {results.actionHandle ? <input type="hidden" name="action" value={results.actionHandle} /> : null}
          <div className="field"><label htmlFor="outreach-focus">Focus</label><select id="outreach-focus" name="focus" defaultValue={results.focus}><option value="all">Everyone in my list</option><option value="attention">Needs attention</option><option value="assigned">Active organizer assignment</option><option value="unassigned">No active organizer</option><option value="contacted">Contact recorded</option><option value="never-engaged">No conversation recorded</option><option value="stale">90+ days since contact</option><option value="willing">Willing to act</option></select></div>
          <div className="field"><label htmlFor="outreach-scope">Scope</label><select id="outreach-scope" name="scope" defaultValue={fieldMode ? results.effectiveScope : results.requestedScope}><option value="assigned">My assignments</option><option value="authorized">Everyone I can access</option></select></div>
          {!fieldMode && assigneeOptions.length ? <div className="field"><label htmlFor="outreach-assignee">Organizer</label><select id="outreach-assignee" name="assignee" defaultValue={results.assigneeHandle ?? ""}><option value="">All organizers</option>{assigneeOptions.map((option) => <option key={option.handle} value={option.handle}>{option.label}{option.current ? " (you)" : ""}</option>)}</select></div> : null}
          <div className="field"><label htmlFor="outreach-limit">Rows</label><select id="outreach-limit" name="limit" defaultValue={String(results.pageSize)}><option value="25">25</option><option value="50">50</option></select></div>
          <button className="button" type="submit">Update list</button>
        </FilterBar>
      </form>
      {constrained ? <p className="muted">Your CAT role only shows people where you’re a current primary or backup organizer.</p> : null}
    </DisclosureCard>

    <SectionCard className="outreach-primary-queue" title={fieldMode ? "People in this field pass" : "People assigned for outreach"} description={unavailable ? undefined : peopleCountLabel(results.total)} badge={protectedReadMode === "protected" && !unavailable ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}>
      {!fieldMode && !unavailable ? <AppliedFilterSummary items={filterSummary} clearHref={standardView ? "/outreach?view=standard" : "/outreach"} /> : null}
      {unavailable ? <UnavailableState title="Your list is unavailable" description="We couldn’t load your outreach list. Check your connection and try again; CAT will not show partial member information." />
        : results.people.length === 0 ? <EmptyState title="No one matches this view" description="Try a different focus, scope, or search." />
        : <QueueDensity label="Outreach results"><div className="stack">
          {results.people.map((person) => {
            const state = priority(person.priority);
            const employeeHref = fieldMode ? fieldPersonHref(person.handle, canonicalFieldContext) : member360Href(person.handle, currentQueueHref);
            const contactOptions = [
              { label: "Cell phone", value: person.cellPhone, href: person.cellPhone ? `tel:${person.cellPhone}` : null },
              { label: "Home phone", value: person.homePhone, href: person.homePhone ? `tel:${person.homePhone}` : null },
              { label: "Work phone", value: person.workPhone, href: person.workPhone ? `tel:${person.workPhone}` : null },
              { label: "Home email", value: person.homeEmail, href: person.homeEmail ? `mailto:${person.homeEmail}` : null },
              { label: "Work email", value: person.workEmail, href: person.workEmail ? `mailto:${person.workEmail}` : null },
            ].filter((contact) => contact.href);
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
                <div><strong>Action readiness</strong><div>{person.willingActionLabels.length ? <>Willing: {person.willingActionLabels.join(", ")}</> : readiness(person)}</div></div>
                <div className="outreach-contact-summary"><strong>Available contact</strong><div>{contactOptions.length ? contactOptions.map((contact) => <span key={contact.label}><span className="muted">{contact.label}: </span><a href={contact.href!}>{contact.value}</a></span>) : <span className="muted">No phone or email recorded</span>}</div></div>
              </div>
              <div className="page-actions outreach-card-actions"><Link className="button outreach-card-primary-action" href={employeeHref}>{fieldMode ? "Open and record" : "Open outreach record"}</Link></div>
            </article>;
          })}
        </div></QueueDensity>}
      {!unavailable && results.people.length ? <Pagination previousHref={results.previousCursor ? href(results, results.previousCursor, fieldMode, standardView) : null} historyBackFallbackHref={hasCursor && !results.previousCursor ? href(results, null, fieldMode, standardView) : null} nextHref={results.nextCursor ? href(results, results.nextCursor, fieldMode, standardView) : null} label={`Showing up to ${results.pageSize} of ${results.total}`} /> : null}
    </SectionCard>
  </div></ProtectedPage>;
}
