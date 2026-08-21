import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DataTable,
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
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import {
  DEFAULT_NEW_HIRE_PAGE_SIZE,
  getNewHireQueue,
  type NewHireContactState,
  type NewHireQueuePage,
} from "@/lib/new-hires";
import { hydrateNewHireQueueFromProtectedPii } from "@/lib/pii-protected-new-hire-read";
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
    case "never_engaged": return { label: "Never engaged", tone: "pending" };
    default: return { label: "Engaged", tone: "ready" };
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
  if (!person.assigned) return "No open outreach assignment";
  const parts = [
    person.primaryOrganizers ? `Primary: ${person.primaryOrganizers}` : "",
    person.backupOrganizers ? `Backup: ${person.backupOrganizers}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Open assignment";
}

export default async function NewHiresPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageImports")) redirect("/unauthorized");

  const parameters = await searchParams;
  let results = emptyResults();
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
  } catch {
    unavailable = true;
  }

  const canOpenEmployee = can(user.role, "recordEngagement");

  return <ProtectedPage permission="manageImports"><div className="content">
    <PageHeader
      eyebrow="Members"
      title="New hires"
      description="Work the latest Local 0801 hires by contact state, outreach assignment, membership status, and days since hire without exposing raw identifiers."
    />

    <SectionCard title="Queue controls" description="Search, filters, totals, and pagination are applied on the server inside the authorized organization workspace.">
      <form action="/new-hires" method="get">
        <FilterBar>
          <div className="field">
            <label htmlFor="new-hire-search">Search</label>
            <input id="new-hire-search" name="q" type="search" maxLength={100} defaultValue={results.term} placeholder="Name, department, location, classification, or work email" />
          </div>
          <div className="field">
            <label htmlFor="new-hire-contact">Contact state</label>
            <select id="new-hire-contact" name="contact" defaultValue={results.contact}>
              <option value="all">Any contact state</option>
              <option value="never-engaged">Never engaged</option>
              <option value="follow-up-open">Open follow-up</option>
              <option value="engaged">Engaged, no open follow-up</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-hire-assignment">Assignment</label>
            <select id="new-hire-assignment" name="assignment" defaultValue={results.assignment}>
              <option value="all">Any assignment state</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-hire-membership">Membership</label>
            <select id="new-hire-membership" name="membershipStatus" defaultValue={results.membershipStatus}>
              <option value="">Any membership status</option>
              <option value="member">Member</option>
              <option value="nonmember">Nonmember</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-hire-days">Hired within</label>
            <select id="new-hire-days" name="days" defaultValue={results.daysWithin ? String(results.daysWithin) : "all"}>
              <option value="all">All recorded hires</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-hire-limit">Rows</label>
            <select id="new-hire-limit" name="limit" defaultValue={String(results.pageSize)}>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
          <button className="button" type="submit">Update queue</button>
        </FilterBar>
      </form>
    </SectionCard>

    {!unavailable ? <section className="metrics-grid" aria-label="New-hire queue summary">
      <StatCard label="Matches" value={results.total} detail="Current server-side filters" tone="brand" />
      <StatCard label="Never engaged" value={results.summary.neverEngaged} detail="No recorded engagement" tone="attention" />
      <StatCard label="Unassigned" value={results.summary.unassigned} detail="No open outreach assignment" tone="attention" />
      <StatCard label="Open follow-up" value={results.summary.openFollowups} detail="Follow-up still outstanding" />
      <StatCard label="Current members" value={results.summary.members} detail="Membership status = member" />
    </section> : null}

    <SectionCard title="New-hire queue" badge={<StatusBadge tone={unavailable ? "warning" : "info"}>{unavailable ? "Unavailable" : protectedReadEnabled ? `Protected PII · ${results.total} hires` : `${results.total} hires`}</StatusBadge>}>
      {unavailable ? <UnavailableState title="New-hire queue unavailable" description="New-hire records are withheld because an authorized database and protected-PII context could not be established." />
        : results.people.length === 0 ? <EmptyState title="No matching new hires" description="No active Local 0801 hire records matched the current server-side filters." />
        : <>
          <DataTable caption="Authorized new-hire queue" headers={["Person", "Hire Date", "Job Status", "Classification", "Department / Work Location", "Work Email", "Work Phone", "Cell Phone", "Home Phone", "Home Email", "Membership", "Assignment", "Outreach", "Action"]}>
            {results.people.map((person) => {
              const contact = contactPresentation(person.contactState);
              return <tr key={`${person.hireDate}:${person.handle}`}>
                <td>
                  <strong>{person.displayName}</strong>
                </td>
                <td>
                  <strong>{hireDate(person.hireDate)}</strong>
                  <div className="muted">{daysLabel(person.daysSinceHire)}</div>
                </td>
                <td>{person.jobStatus || "—"}</td>
                <td>{person.classification || "—"}</td>
                <td>{person.department || "—"}<div className="muted">{person.workLocation || "Work location unavailable"}</div></td>
                <td>{person.workEmail ? <a href={`mailto:${person.workEmail}`}>{person.workEmail}</a> : "—"}</td>
                <td>{person.workPhone || "—"}</td>
                <td>{person.cellPhone || "—"}</td>
                <td>{person.homePhone || "—"}</td>
                <td>{person.homeEmail ? <a href={`mailto:${person.homeEmail}`}>{person.homeEmail}</a> : "—"}</td>
                <td><StatusBadge>{person.membershipStatus}</StatusBadge></td>
                <td>
                  <StatusBadge tone={person.assigned ? "info" : "warning"}>{person.assigned ? "Assigned" : "Unassigned"}</StatusBadge>
                  <div className="muted">{organizerLabel(person)}</div>
                </td>
                <td>
                  <StatusBadge tone={contact.tone}>{contact.label}</StatusBadge>
                  <div className="muted">
                    {person.latestEngagementAt ? `Last: ${dateTime(person.latestEngagementAt)}${person.latestOutcome ? ` · ${person.latestOutcome}` : ""}` : "No engagement recorded"}
                    {person.openFollowupCount ? <><br />{person.overdueFollowupCount ? `${person.overdueFollowupCount} overdue` : `${person.openFollowupCount} open`}{person.nextFollowupAt ? ` · next ${dateTime(person.nextFollowupAt)}` : ""}</> : null}
                  </div>
                </td>
                <td>
                  {canOpenEmployee
                    ? <Link className="button secondary" href={`/outreach/${person.handle}`}>Open employee</Link>
                    : <Link className="button secondary" href={`/directory?scope=authorized&q=${encodeURIComponent(person.displayName)}`}>View directory</Link>}
                </td>
              </tr>;
            })}
          </DataTable>
          <Pagination label={`Showing up to ${results.pageSize} of ${results.total}`} nextHref={results.nextCursor ? href(results, results.nextCursor) : null} />
        </>}
    </SectionCard>
  </div></ProtectedPage>;
}
