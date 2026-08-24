import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DataTable,
  DisclosureCard,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  SectionCard,
  StatCard,
  StatusBadge,
  UnavailableState,
  type StatusTone,
} from "@/components/DesignSystem";
import { NewHireAssignmentControl } from "@/components/NewHireAssignmentControl";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { newHireLifecycle, type NewHireLifecycleStage } from "@/lib/new-hire-lifecycle";
import { getNewHireAssignmentOptions } from "@/lib/new-hire-assignment";
import {
  DEFAULT_NEW_HIRE_PAGE_SIZE,
  getNewHireQueue,
  type NewHireContactState,
  type NewHireQueuePage,
} from "@/lib/new-hires";
import { hydrateNewHireQueueFromProtectedPii } from "@/lib/pii-protected-new-hire-read";
import { hydrateEngagementFormOptionsFromProtectedPii } from "@/lib/pii-protected-outreach-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function emptyResults(): NewHireQueuePage {
  return {
    people: [],
    term: "",
    assignment: "all",
    contact: "all",
    membershipStatus: "",
    daysWithin: null,
    pageSize: DEFAULT_NEW_HIRE_PAGE_SIZE,
    total: 0,
    summary: { neverEngaged: 0, unassigned: 0, openFollowups: 0, members: 0 },
    nextCursor: null,
  };
}

function href(results: NewHireQueuePage, cursor: string | null) {
  const params = new URLSearchParams();
  if (results.term) params.set("q", results.term);
  params.set("assignment", results.assignment);
  params.set("contact", results.contact);
  if (results.membershipStatus) params.set("membershipStatus", results.membershipStatus);
  if (results.daysWithin) params.set("days", String(results.daysWithin));
  params.set("limit", String(results.pageSize));
  if (cursor) params.set("cursor", cursor);
  return `/new-hires?${params.toString()}`;
}

function contactPresentation(state: NewHireContactState): { label: string; tone: StatusTone } {
  switch (state) {
    case "overdue_followup": return { label: "Overdue follow-up", tone: "danger" };
    case "followup_open": return { label: "Follow-up open", tone: "warning" };
    case "never_engaged": return { label: "No conversation yet", tone: "pending" };
    default: return { label: "Contacted", tone: "ready" };
  }
}

function lifecycleTone(stage: NewHireLifecycleStage): StatusTone {
  switch (stage) {
    case "membership_resolved": return "ready";
    case "conversation_completed": return "info";
    case "contact_attempted": return "pending";
    case "assigned": return "info";
    default: return "warning";
  }
}

function hireDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function dateTime(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(new Date(value));
}

function daysLabel(value: number) {
  if (value === 0) return "Today";
  return `${value} day${value === 1 ? "" : "s"} ago`;
}

function organizerLabel(person: NewHireQueuePage["people"][number]) {
  if (!person.assigned) return "No current organizer assignment";
  const parts = [
    person.primaryOrganizers ? `Primary: ${person.primaryOrganizers}` : "",
    person.backupOrganizers ? `Backup: ${person.backupOrganizers}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Assigned";
}

function membershipStatusLabel(status: string) {
  if (status === "member") return "Member";
  if (status === "nonmember") return "Nonmember";
  if (status === "unknown") return "Unknown";
  return status;
}

export default async function NewHiresPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "assignNewHires")) redirect("/unauthorized");

  const parameters = await searchParams;
  const hasCursor = typeof parameters.cursor === "string" && parameters.cursor.length > 0;
  const canOpenEmployee = can(user.role, "recordEngagement");
  const canAssignNewHires = can(user.role, "assignNewHires");
  let results = emptyResults();
  let assignmentOptions: Awaited<ReturnType<typeof getNewHireAssignmentOptions>> = [];
  let assignmentOptionsUnavailable = false;
  let unavailable = false;
  let protectedReadEnabled = false;
  try {
    const context = await resolveWorkspaceContext(user);
    const legacyResults = await getNewHireQueue(context, {
      term: parameters.q,
      assignment: parameters.assignment,
      contact: parameters.contact,
      membershipStatus: parameters.membershipStatus,
      days: parameters.days,
      pageSize: parameters.limit,
      cursor: parameters.cursor,
    });
    results = await hydrateNewHireQueueFromProtectedPii(context.organizationId, legacyResults);
    protectedReadEnabled = isPiiProtectedReadEnabled();

    if (canAssignNewHires) {
      try {
        const legacyAssignmentOptions = await getNewHireAssignmentOptions(context);
        const hydrated = await hydrateEngagementFormOptionsFromProtectedPii(context.organizationId, {
          assignments: [],
          assignees: legacyAssignmentOptions,
          actionDefinitions: [],
        });
        assignmentOptions = hydrated.assignees;
      } catch {
        assignmentOptionsUnavailable = true;
      }
    }
  } catch {
    unavailable = true;
  }

  const advancedFilterCount = results.membershipStatus ? 1 : 0;
  const hireCountLabel = `${results.total} ${results.total === 1 ? "new hire" : "new hires"}`;
  const paginationLabel = results.total > results.people.length
    ? `Showing ${results.people.length} of ${results.total} hires`
    : `Showing ${results.people.length} ${results.people.length === 1 ? "hire" : "hires"}`;

  return <ProtectedPage permission="assignNewHires"><div className="content new-hires-page">
    <PageHeader
      eyebrow="Members"
      title="New hires"
      description="Track new Local 801 hires from assignment through first conversation and membership resolution."
    />

    <SectionCard className="new-hires-filter-card" title="Find new hires" description="Narrow the list by contact, assignment, membership status, or hire date.">
      <form className="new-hire-search-form" action="/new-hires" method="get">
        <FilterBar>
          <div className="field new-hire-search-field">
            <label htmlFor="new-hire-search">Search</label>
            <input id="new-hire-search" name="q" type="search" maxLength={100} defaultValue={results.term} placeholder="Name, department, section, classification, or work email" />
          </div>
          <div className="field new-hire-contact-field">
            <label htmlFor="new-hire-contact">Contact</label>
            <select id="new-hire-contact" name="contact" defaultValue={results.contact}>
              <option value="all">Any contact status</option>
              <option value="never-engaged">No conversation yet</option>
              <option value="follow-up-open">Open follow-up</option>
              <option value="engaged">Contacted, no open follow-up</option>
            </select>
          </div>
          <div className="field new-hire-assignment-field">
            <label htmlFor="new-hire-assignment">Assignment</label>
            <select id="new-hire-assignment" name="assignment" defaultValue={results.assignment}>
              <option value="all">Any assignment status</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </div>
          <div className="field new-hire-days-field">
            <label htmlFor="new-hire-days">Hired within</label>
            <select id="new-hire-days" name="days" defaultValue={results.daysWithin ? String(results.daysWithin) : "all"}>
              <option value="all">All recorded hires</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </select>
          </div>
          <button className="button new-hire-search-submit" type="submit">Update list</button>
          <details className="new-hire-more-filters" open={advancedFilterCount > 0}>
            <summary>More filters{advancedFilterCount ? ` (${advancedFilterCount} applied)` : ""}</summary>
            <div className="new-hire-advanced-filter-grid">
              <div className="field">
                <label htmlFor="new-hire-membership">Membership</label>
                <select id="new-hire-membership" name="membershipStatus" defaultValue={results.membershipStatus}>
                  <option value="">Any membership status</option>
                  <option value="member">Member</option>
                  <option value="nonmember">Nonmember</option>
                  <option value="unknown">Unknown</option>
                </select>
              </div>
            </div>
          </details>
        </FilterBar>
      </form>
    </SectionCard>

    {!unavailable ? <section className="metrics-grid new-hire-summary" aria-label="New-hire summary">
      <StatCard label="New hires" value={results.total} detail="People in this view" tone="brand" />
      <StatCard label="No conversation yet" value={results.summary.neverEngaged} detail="No recorded contact" tone="attention" />
      <StatCard label="Unassigned" value={results.summary.unassigned} detail="No current organizer assignment" tone="attention" />
      <StatCard label="Open follow-up" value={results.summary.openFollowups} detail="Follow-up still outstanding" />
    </section> : null}

    <SectionCard
      className="new-hires-results-card"
      title="New-hire records"
      description={unavailable ? "The protected new-hire list could not be loaded safely." : `${hireCountLabel} Match the current hire-date, contact, assignment, and membership filters.`}
      badge={!unavailable && protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
    >
      {unavailable ? <UnavailableState title="New hires are unavailable" description="We couldn’t load the protected new-hire list safely, so no member details are shown." />
        : results.people.length === 0 ? <EmptyState title="No matching new hires" description="No active Local 801 hire records match the filters you chose." />
        : <>
          {results.total > 25 ? <div className="new-hire-results-toolbar">
            <form className="new-hire-page-size" action="/new-hires" method="get">
              {results.term ? <input type="hidden" name="q" value={results.term} /> : null}
              <input type="hidden" name="contact" value={results.contact} />
              <input type="hidden" name="assignment" value={results.assignment} />
              {results.membershipStatus ? <input type="hidden" name="membershipStatus" value={results.membershipStatus} /> : null}
              {results.daysWithin ? <input type="hidden" name="days" value={String(results.daysWithin)} /> : null}
              <label htmlFor="new-hire-limit">Show</label>
              <select id="new-hire-limit" name="limit" aria-label="New hires per page" defaultValue={String(results.pageSize)}>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
              <span>per page</span>
              <button className="button secondary new-hire-apply-size" type="submit">Apply</button>
            </form>
          </div> : null}

          <div className="new-hire-desktop-results">
            <DataTable caption="New hires" headers={["Employee ID", "Person", "Hire Date", "Job Status", "Classification", "Department / Work Location", "Work Email", "Work Phone", "Cell Phone", "Home Phone", "Home Email", "Progress", "Assignment", "Action"]}>
              {results.people.map((person) => {
                const contact = contactPresentation(person.contactState);
                const lifecycle = newHireLifecycle(person);
                return <tr key={`${person.hireDate}:${person.handle}`}>
                  <td><span className="data-mono">{person.employeeReference}</span></td>
                  <td>
                    <strong>{canOpenEmployee ? <Link href={`/outreach/${person.handle}`}>{person.displayName}</Link> : person.displayName}</strong>
                    <div className="muted">{membershipStatusLabel(person.membershipStatus)}</div>
                  </td>
                  <td>
                    <strong>{hireDate(person.hireDate)}</strong>
                    <div className="muted">{daysLabel(person.daysSinceHire)}</div>
                  </td>
                  <td>{person.jobStatus || <span className="muted">Not recorded</span>}</td>
                  <td>{person.classification || <span className="muted">Not recorded</span>}</td>
                  <td>{person.department || <span className="muted">Not recorded</span>}<div className="muted">{person.workLocation || "Work location not recorded"}</div></td>
                  <td><div>{person.workEmail ? <a href={`mailto:${person.workEmail}`}>{person.workEmail}</a> : <span className="muted">Not recorded</span>}</div><div><StatusBadge tone={contact.tone}>{contact.label}</StatusBadge></div></td>
                  <td>{person.workPhone ? <a href={`tel:${person.workPhone}`}>{person.workPhone}</a> : <span className="muted">Not recorded</span>}</td>
                  <td>{person.cellPhone ? <a href={`tel:${person.cellPhone}`}>{person.cellPhone}</a> : <span className="muted">Not recorded</span>}</td>
                  <td>{person.homePhone ? <a href={`tel:${person.homePhone}`}>{person.homePhone}</a> : <span className="muted">Not recorded</span>}</td>
                  <td>{person.homeEmail ? <a href={`mailto:${person.homeEmail}`}>{person.homeEmail}</a> : <span className="muted">Not recorded</span>}</td>
                  <td>
                    <div className="new-hire-progress-badges">
                      <StatusBadge tone={lifecycleTone(lifecycle.stage)}>{lifecycle.label}</StatusBadge>
                      <span className="new-hire-membership-status">Membership: {membershipStatusLabel(person.membershipStatus)}</span>
                    </div>
                    <div className="muted">Step {lifecycle.step} of {lifecycle.totalSteps}</div>
                  </td>
                  <td>
                    <StatusBadge tone={person.assigned ? "info" : "warning"}>{person.assigned ? "Assigned" : "Unassigned"}</StatusBadge>
                    <div className="muted">{organizerLabel(person)}</div>
                    {!person.assigned && canAssignNewHires
                      ? assignmentOptionsUnavailable
                        ? <div className="muted">Assignment options are temporarily unavailable.</div>
                        : <NewHireAssignmentControl employeeHandle={person.handle} employeeName={person.displayName} assignees={assignmentOptions} />
                      : null}
                  </td>
                  <td className="new-hire-action-cell">
                    {canOpenEmployee
                      ? <Link className="button secondary new-hire-member360-button" aria-label={`Open outreach record for ${person.displayName}`} href={`/outreach/${person.handle}`}>Outreach record <span aria-hidden="true">→</span></Link>
                      : <Link className="button secondary new-hire-member360-button" href={`/directory?scope=authorized&q=${encodeURIComponent(person.displayName)}`}>View directory</Link>}
                  </td>
                </tr>;
              })}
            </DataTable>
          </div>

          <div className="new-hire-mobile-results" aria-label="New hires">
            {results.people.map((person) => {
              const contact = contactPresentation(person.contactState);
              const lifecycle = newHireLifecycle(person);
              return <article className="new-hire-person-row" key={`${person.hireDate}:${person.handle}`}>
                <div className="new-hire-person-heading">
                  <h3>{canOpenEmployee ? <Link href={`/outreach/${person.handle}`}>{person.displayName}</Link> : person.displayName}</h3>
                  <StatusBadge tone={lifecycleTone(lifecycle.stage)}>{lifecycle.label}</StatusBadge>
                </div>
                <div className="new-hire-person-meta">Hired {hireDate(person.hireDate)} · {daysLabel(person.daysSinceHire)}</div>
                <div className="muted data-mono">{person.employeeReference}</div>
                <div className="new-hire-mobile-progress">
                  <span>Step {lifecycle.step} of {lifecycle.totalSteps}</span>
                  <span className="new-hire-membership-status">Membership: {membershipStatusLabel(person.membershipStatus)}</span>
                </div>
                <div className="new-hire-mobile-work">
                  <strong>{person.department || "Department not recorded"}</strong>
                  <span>{person.classification || "Classification not recorded"} · {person.workLocation || "Work location not recorded"}</span>
                </div>
                <div className="new-hire-mobile-detail">
                  <strong>Assignment</strong>
                  <div><StatusBadge tone={person.assigned ? "info" : "warning"}>{person.assigned ? "Assigned" : "Unassigned"}</StatusBadge></div>
                  <span>{organizerLabel(person)}</span>
                  {!person.assigned && canAssignNewHires
                    ? assignmentOptionsUnavailable
                      ? <span>Assignment options are temporarily unavailable.</span>
                      : <NewHireAssignmentControl employeeHandle={person.handle} employeeName={person.displayName} assignees={assignmentOptions} />
                    : null}
                </div>
                <div className="new-hire-mobile-detail">
                  <strong>Contact</strong>
                  <div><StatusBadge tone={contact.tone}>{contact.label}</StatusBadge></div>
                  {person.latestEngagementAt || person.openFollowupCount ? <span>
                    {person.latestEngagementAt ? `Last: ${dateTime(person.latestEngagementAt)}${person.latestOutcome ? ` · ${person.latestOutcome}` : ""}` : null}
                    {person.openFollowupCount ? `${person.latestEngagementAt ? " · " : ""}${person.overdueFollowupCount ? `${person.overdueFollowupCount} overdue` : `${person.openFollowupCount} open`}${person.nextFollowupAt ? ` · next ${dateTime(person.nextFollowupAt)}` : ""}` : ""}
                  </span> : null}
                </div>
                <div className="new-hire-person-email">
                  <span>{person.workEmail ? <a href={`mailto:${person.workEmail}`}>{person.workEmail}</a> : <span className="muted">Work email not recorded</span>}</span>
                  <span>{person.workPhone ? <a href={`tel:${person.workPhone}`}>{person.workPhone}</a> : <span className="muted">Work phone not recorded</span>}</span>
                </div>
                {canOpenEmployee
                  ? <Link className="new-hire-member360-link" aria-label={`Open outreach record for ${person.displayName}`} href={`/outreach/${person.handle}`}>Outreach record <span aria-hidden="true">→</span></Link>
                  : <Link className="new-hire-member360-link" href={`/directory?scope=authorized&q=${encodeURIComponent(person.displayName)}`}>View directory <span aria-hidden="true">→</span></Link>}
              </article>;
            })}
          </div>

          {(hasCursor || results.nextCursor || results.total > results.people.length) ? <Pagination label={paginationLabel} historyBackFallbackHref={hasCursor ? href(results, null) : null} nextHref={results.nextCursor ? href(results, results.nextCursor) : null} /> : null}
        </>}
    </SectionCard>

    <DisclosureCard className="new-hires-journey-disclosure" title="How the new-hire journey works" description="Stages move forward from recorded work. They are progress markers, not scores.">
      <div className="new-hire-journey">
        <div className="workflow-step-list" aria-label="New-hire stages">
          {[
            ["1", "New", "No organizer assignment or contact recorded"],
            ["2", "Assigned", "Organizer assigned"],
            ["3", "Contact attempted", "At least one contact attempt recorded"],
            ["4", "Conversation completed", "A successful conversation is recorded"],
            ["5", "Membership resolved", "Conversation complete and membership status known"],
          ].map(([step, label, detail]) => <div className="workflow-step" key={step}><span className="workflow-step-number" aria-hidden="true">{step}</span><div><strong>{label}</strong><div className="muted">{detail}</div></div></div>)}
        </div>
      </div>
    </DisclosureCard>
  </div></ProtectedPage>;
}
