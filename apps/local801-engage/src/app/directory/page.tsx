import Link from "next/link";
import { redirect } from "next/navigation";
import { AppliedFilterSummary, DataTable, DisclosureCard, EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { OutreachAssignmentControl } from "@/components/OutreachAssignmentControl";
import { ProtectedPage } from "@/components/ProtectedPage";
import { QueueDensity } from "@/components/QueueDensity";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDate } from "@/lib/date-format";
import { DEFAULT_DIRECTORY_PAGE_SIZE, getDirectoryPage, type DirectoryPage as Results } from "@/lib/directory";
import { hydrateDirectoryPageFromProtectedPii, isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { hydrateOutreachAssigneeOptionsFromProtectedPii } from "@/lib/pii-protected-outreach-read";
import { getOutreachAssignmentOptions } from "@/lib/outreach-assignment";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceWorkspaceRateLimit } from "@/lib/rate-limit";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
function emptyResults(): Results { return { people: [], term: "", pageSize: DEFAULT_DIRECTORY_PAGE_SIZE, total: 0, previousCursor: null, nextCursor: null, requestedScope: "assigned", effectiveScope: "assigned", filters: { membershipStatus: "", department: "", classification: "", workLocation: "" } }; }
function href(results: Results, cursor: string | null) {
  const params = new URLSearchParams();
  if (results.term) params.set("q", results.term);
  params.set("scope", results.requestedScope); params.set("limit", String(results.pageSize));
  for (const [key, value] of Object.entries(results.filters)) if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  return `/directory?${params}`;
}
function membershipStatusLabel(status: string) {
  if (status === "member") return "Member";
  if (status === "nonmember") return "Nonmember";
  if (status === "unknown") return "Unknown";
  return status;
}

export default async function DirectoryPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "viewDirectory")) redirect("/unauthorized");
  const canOpenEmployee = can(user.role, "recordEngagement");
  const canAssignEmployee = can(user.role, "assignOutreach");
  const parameters = await searchParams;
  let results = emptyResults(); let unavailable = false; let protectedReadEnabled = false;
  let assignmentOptions: Awaited<ReturnType<typeof getOutreachAssignmentOptions>> = [];
  try {
    const context = await resolveWorkspaceContext(user);
    await enforceWorkspaceRateLimit(context, "search");
    const [legacyResults, rawAssignmentOptions] = await Promise.all([
      getDirectoryPage(context, { term: parameters.q, scope: parameters.scope, pageSize: parameters.limit, cursor: parameters.cursor, membershipStatus: parameters.membershipStatus, department: parameters.department, classification: parameters.classification, workLocation: parameters.workLocation }),
      canAssignEmployee ? getOutreachAssignmentOptions(context) : Promise.resolve([]),
    ]);
    [results, assignmentOptions] = await Promise.all([
      hydrateDirectoryPageFromProtectedPii(context.organizationId, legacyResults),
      canAssignEmployee
        ? hydrateOutreachAssigneeOptionsFromProtectedPii(context.organizationId, rawAssignmentOptions)
        : Promise.resolve([]),
    ]);
    protectedReadEnabled = isPiiProtectedReadEnabled();
  } catch (error) {
    const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
    console.error("[local801-directory-safe-failure]", JSON.stringify({
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof source.code === "string" ? source.code : undefined,
      constraint: typeof source.constraint === "string" ? source.constraint : undefined,
      table: typeof source.table === "string" ? source.table : undefined,
    }));
    unavailable = true;
  }
  const constrained = results.requestedScope !== results.effectiveScope;
  const advancedFilterCount = [results.filters.department, results.filters.classification, results.filters.workLocation].filter(Boolean).length;
  const peopleLabel = `${results.total} ${results.total === 1 ? "person" : "people"}`;
  const paginationLabel = `Showing ${results.people.length} of ${results.total} people`;
  const filterSummary = [
    results.term ? `Search: ${results.term}` : "",
    results.requestedScope === "authorized" ? "Everyone I can access" : "",
    results.filters.membershipStatus ? `Membership: ${membershipStatusLabel(results.filters.membershipStatus)}` : "",
    results.filters.department ? `Department: ${results.filters.department}` : "",
    results.filters.classification ? `Classification: ${results.filters.classification}` : "",
    results.filters.workLocation ? `Section: ${results.filters.workLocation}` : "",
  ].filter(Boolean);

  return <ProtectedPage permission="viewDirectory"><div className="content directory-page">
    <PageHeader eyebrow="Members" title="Directory" description="Find employees and assign their outreach to an active CAT member or higher role." />
    <DisclosureCard className="directory-filter-card queue-filter-panel" title="Find someone" description={filterSummary.length ? `${filterSummary.length} filter${filterSummary.length === 1 ? "" : "s"} applied. Open to change the current view.` : "Search by name, workplace, classification, membership status, or work email."} defaultOpen={filterSummary.length === 0}>
      <form className="directory-search-form" action="/directory" method="get">
        <FilterBar>
          <div className="field directory-search-field"><label htmlFor="directory-search">Search</label><input id="directory-search" name="q" type="search" maxLength={100} defaultValue={results.term} placeholder="Name, department, section, classification, or work email" /></div>
          <div className="field directory-scope-field"><label htmlFor="directory-scope">Scope</label><select id="directory-scope" name="scope" defaultValue={results.requestedScope}><option value="assigned">My assignments</option><option value="authorized">Everyone I can access</option></select></div>
          <div className="field directory-status-field"><label htmlFor="membershipStatus">Membership status</label><select id="membershipStatus" name="membershipStatus" defaultValue={results.filters.membershipStatus}><option value="">Any status</option><option value="member">Member</option><option value="nonmember">Nonmember</option><option value="unknown">Unknown</option></select></div>
          <button className="button directory-search-submit" type="submit">Search</button>
          <details className="directory-more-filters" open={advancedFilterCount > 0}>
            <summary>More filters{advancedFilterCount ? ` (${advancedFilterCount} applied)` : ""}</summary>
            <div className="directory-advanced-filter-grid">
              <div className="field"><label htmlFor="department">Department</label><input id="department" name="department" maxLength={80} defaultValue={results.filters.department} /></div>
              <div className="field"><label htmlFor="classification">Classification</label><input id="classification" name="classification" maxLength={80} defaultValue={results.filters.classification} /></div>
              <div className="field"><label htmlFor="workLocation">Section name</label><input id="workLocation" name="workLocation" maxLength={80} defaultValue={results.filters.workLocation} /></div>
            </div>
          </details>
        </FilterBar>
      </form>
      {constrained ? <p className="muted">Your CAT role only shows people in your current primary or backup assignments.</p> : null}
    </DisclosureCard>
    <SectionCard
      className="directory-results-card"
      title="Directory matches"
      description={unavailable ? undefined : peopleLabel}
      badge={unavailable
        ? null
        : protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
    >
      {!unavailable ? <AppliedFilterSummary items={filterSummary} clearHref="/directory" /> : null}
      {unavailable ? <UnavailableState title="Directory unavailable" description="We couldn’t load the directory, so CAT is not showing partial member details." /> : results.people.length === 0 ? <EmptyState title="No matches" description="No one matches the search and filters you chose." /> : <>
        {results.total > 25 ? <div className="directory-results-toolbar">
          <form className="directory-page-size" action="/directory" method="get">
            {results.term ? <input type="hidden" name="q" value={results.term} /> : null}
            <input type="hidden" name="scope" value={results.requestedScope} />
            {results.filters.membershipStatus ? <input type="hidden" name="membershipStatus" value={results.filters.membershipStatus} /> : null}
            {results.filters.department ? <input type="hidden" name="department" value={results.filters.department} /> : null}
            {results.filters.classification ? <input type="hidden" name="classification" value={results.filters.classification} /> : null}
            {results.filters.workLocation ? <input type="hidden" name="workLocation" value={results.filters.workLocation} /> : null}
            <label htmlFor="directory-limit">Show</label>
            <select id="directory-limit" name="limit" defaultValue={String(results.pageSize)} aria-label="People per page"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select>
            <span>per page</span>
            <button className="button secondary directory-apply-size" type="submit">Apply</button>
          </form>
        </div> : null}

        <div className="directory-desktop-results">
          <DataTable caption="Directory results" headers={canAssignEmployee ? ["Person", "Hire Date", "Work", "Contact", "Assignment"] : ["Person", "Hire Date", "Work", "Contact"]}>
            {results.people.map((person) => <tr key={person.handle}>
              <td>
                <div className="person-membership-stack">
                  <strong>{canOpenEmployee ? <Link href={`/outreach/${person.handle}`}>{person.firstName} {person.lastName}</Link> : `${person.firstName} ${person.lastName}`}</strong>
                  {person.membershipStatus ? <StatusBadge>{membershipStatusLabel(person.membershipStatus)}</StatusBadge> : null}
                </div>
              </td>
              <td>{person.hireDate ? formatCatDate(person.hireDate) : <span className="muted">Not recorded</span>}</td>
              <td>
                <strong>{person.classification || "Classification not recorded"}</strong>
                <div>{person.department || <span className="muted">Department not recorded</span>}</div>
                <div className="muted">{person.workLocation || "Work location not recorded"}</div>
              </td>
              <td>
                <div>{person.workEmail ? <a href={`mailto:${person.workEmail}`}>{person.workEmail}</a> : <span className="muted">Work email not recorded</span>}</div>
                <div>{person.workPhone ? <a href={`tel:${person.workPhone}`}>{person.workPhone}</a> : <span className="muted">Work phone not recorded</span>}</div>
              </td>
              {canAssignEmployee ? <td><details className="directory-assignment-control">
                <summary className="button secondary">Assign employee</summary>
                <div className="directory-assignment-panel"><OutreachAssignmentControl
                  memberHandle={person.handle}
                  memberName={`${person.firstName} ${person.lastName}`}
                  assignees={assignmentOptions}
                  canDelete={false}
                  returnHref="/directory"
                /></div>
              </details></td> : null}
            </tr>)}
          </DataTable>
        </div>

        <QueueDensity label="Directory results"><div className="directory-mobile-results" aria-label="Directory results">
          {results.people.map((person) => <article className="directory-person-card" key={person.handle}>
            <div className="directory-person-heading">
              <h3>{canOpenEmployee ? <Link href={`/outreach/${person.handle}`}>{person.firstName} {person.lastName}</Link> : `${person.firstName} ${person.lastName}`}</h3>
              {person.membershipStatus ? <StatusBadge>{membershipStatusLabel(person.membershipStatus)}</StatusBadge> : null}
            </div>
            <div className="directory-person-work">
              <strong>{person.department || "Department not recorded"}</strong>
              <span>{person.classification || "Classification not recorded"}</span>
              <span>{person.workLocation || "Work location not recorded"}</span>
            </div>
            <div className="directory-person-contact">
              <span>{person.workEmail ? <a href={`mailto:${person.workEmail}`}>{person.workEmail}</a> : <span className="muted">Work email not recorded</span>}</span>
              <span>{person.workPhone ? <a href={`tel:${person.workPhone}`}>{person.workPhone}</a> : <span className="muted">Work phone not recorded</span>}</span>
            </div>
            {canOpenEmployee ? <Link className="directory-member360-link" href={`/outreach/${person.handle}`}>Outreach record <span aria-hidden="true">→</span></Link> : null}
            {canAssignEmployee ? <details className="directory-assignment-control">
              <summary className="button secondary">Assign employee</summary>
              <div className="directory-assignment-panel"><OutreachAssignmentControl
                memberHandle={person.handle}
                memberName={`${person.firstName} ${person.lastName}`}
                assignees={assignmentOptions}
                canDelete={false}
                returnHref="/directory"
              /></div>
            </details> : null}
          </article>)}
        </div></QueueDensity>

        {(results.previousCursor || results.nextCursor) ? <Pagination previousHref={results.previousCursor ? href(results, results.previousCursor) : null} nextHref={results.nextCursor ? href(results, results.nextCursor) : null} label={paginationLabel} /> : null}
      </>}
    </SectionCard>
  </div></ProtectedPage>;
}
