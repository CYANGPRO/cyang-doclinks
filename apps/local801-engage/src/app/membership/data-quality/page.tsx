import Link from "next/link";
import { redirect } from "next/navigation";
import { DataQualityFixControls } from "@/components/DataQualityFixControls";
import { DataTable, DisclosureCard, EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDate } from "@/lib/date-format";
import { DATA_QUALITY_ISSUES, getDataQualityQueue, type DataQualityIssueCode, type DataQualityIssueFilter, type DataQualityQueuePage, type DataQualitySummary } from "@/lib/data-quality";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const labels = new Map(DATA_QUALITY_ISSUES.map((item) => [item.code, item.label]));
const explanations = new Map(DATA_QUALITY_ISSUES.map((item) => [item.code, item.explanation]));

function href(results: DataQualityQueuePage, cursor: string | null) {
  const params = new URLSearchParams();
  if (results.issue !== "all") params.set("issue", results.issue);
  params.set("limit", String(results.pageSize));
  if (cursor) params.set("cursor", cursor);
  return `/membership/data-quality?${params}`;
}

function filterHref(issue: DataQualityIssueFilter, pageSize: number) {
  const params = new URLSearchParams();
  if (issue !== "all") params.set("issue", issue);
  params.set("limit", String(pageSize));
  return `/membership/data-quality?${params}`;
}

function formatDate(value: string | null) {
  return formatCatDate(value, "Unknown");
}

function issueCount(summary: DataQualitySummary, issue: DataQualityIssueFilter) {
  if (issue === "all") return summary.flaggedPeople;
  const counts: Record<DataQualityIssueCode, number> = {
    missing_identifier: summary.missingIdentifier,
    missing_work_email: summary.missingWorkEmail,
    missing_department: summary.missingDepartment,
    missing_classification: summary.missingClassification,
    missing_work_location: summary.missingWorkLocation,
    unknown_membership: summary.unknownMembership,
    not_in_latest_roster: summary.notInLatestRoster,
  };
  return counts[issue];
}

function peopleLabel(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? "person" : "people"}`;
}

function membershipLabel(value: string) {
  return value === "member" ? "Member" : value === "nonmember" ? "Nonmember" : "Unknown";
}

function hasDirectIssue(issues: readonly DataQualityIssueCode[]) {
  return issues.some((issue) => issue !== "not_in_latest_roster");
}

export default async function MembershipDataQualityPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageImports")) redirect("/unauthorized");
  const canOpenMember = can(user.role, "recordEngagement");
  const parameters = await searchParams;
  const hasCursor = typeof parameters.cursor === "string" && parameters.cursor.length > 0;
  let results: DataQualityQueuePage | null = null;
  let unavailable = false;
  try {
    const context = await resolveWorkspaceContext(user);
    results = await getDataQualityQueue(context, { issue: parameters.issue, pageSize: parameters.limit, cursor: parameters.cursor });
  } catch (error) {
    const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
    console.error("[local801-data-quality-safe-failure]", JSON.stringify({
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof source.code === "string" ? source.code : undefined,
      constraint: typeof source.constraint === "string" ? source.constraint : undefined,
      table: typeof source.table === "string" ? source.table : undefined,
    }));
    unavailable = true;
  }

  return <ProtectedPage permission="manageImports"><div className="content membership-data-quality-page">
    <PageHeader eyebrow="Members" title="Data quality" description="Find member records with clear gaps that need review. Fix individual records here, or use Data Imports for bulk and roster-source corrections." actions={<Link className="button secondary data-quality-header-action" href="/imports">Open data imports</Link>} />

    {unavailable || !results ? <UnavailableState title="Data quality unavailable" description="We couldn’t safely load the protected records that need review, so no issue details are shown." /> : <>
      <nav className="data-quality-summary" aria-label="Data quality issue views">
        <Link aria-current={results.issue === "all" ? "page" : undefined} className={`data-quality-summary-card${results.issue === "all" ? " active" : ""}`} href={filterHref("all", results.pageSize)}>
          <span>People needing review</span><strong>{results.summary.flaggedPeople.toLocaleString()}</strong><small>One person can have more than one issue.</small>
        </Link>
        <Link aria-current={results.issue === "missing_identifier" ? "page" : undefined} className={`data-quality-summary-card${results.issue === "missing_identifier" ? " active" : ""}`} href={filterHref("missing_identifier", results.pageSize)}>
          <span>Missing employee/member ID</span><strong>{results.summary.missingIdentifier.toLocaleString()}</strong><small>No employee or member identifier on file.</small>
        </Link>
        <Link aria-current={results.issue === "missing_work_email" ? "page" : undefined} className={`data-quality-summary-card${results.issue === "missing_work_email" ? " active" : ""}`} href={filterHref("missing_work_email", results.pageSize)}>
          <span>Missing work email</span><strong>{results.summary.missingWorkEmail.toLocaleString()}</strong><small>No active work email on file.</small>
        </Link>
        <Link aria-current={results.issue === "not_in_latest_roster" ? "page" : undefined} className={`data-quality-summary-card${results.issue === "not_in_latest_roster" ? " active" : ""}`} href={filterHref("not_in_latest_roster", results.pageSize)}>
          <span>Missing from latest roster</span><strong>{results.summary.latestRosterAvailable ? results.summary.notInLatestRoster.toLocaleString() : "—"}</strong><small>{results.summary.latestRosterAvailable ? "Review only — this is not a drop." : "No approved roster is available for comparison."}</small>
        </Link>
      </nav>

      <SectionCard className="data-quality-filter-card" title="Filter records by data issue" description="Choose one recorded data gap or review every active record with a known issue." badge={<StatusBadge tone="info">Protected PII</StatusBadge>}>
        <form action="/membership/data-quality" method="get" className="data-quality-filter-form">
          <FilterBar>
            <div className="field"><label htmlFor="issue">Issue</label><select id="issue" name="issue" defaultValue={results.issue}><option value="all">All issues ({results.summary.flaggedPeople.toLocaleString()})</option>{DATA_QUALITY_ISSUES.map((item) => <option key={item.code} value={item.code}>{item.label} ({issueCount(results.summary, item.code).toLocaleString()})</option>)}</select></div>
            <input type="hidden" name="limit" value={String(results.pageSize)} />
            <button className="button" type="submit">Apply filter</button>
          </FilterBar>
        </form>
        <p className="muted data-quality-method-note">These flags come only from information already on file and the latest approved roster. The app does not use fuzzy name matching, hidden rankings, or guesses about whether someone left.</p>
      </SectionCard>

      <SectionCard className="data-quality-review-queue" title="Records matching this data issue" description={results.people.length ? `${peopleLabel(issueCount(results.summary, results.issue))} ${issueCount(results.summary, results.issue) === 1 ? "needs" : "need"} review.` : "No active records match the selected issue."} badge={<StatusBadge tone="info">Protected PII</StatusBadge>}>
        {results.people.length === 0 ? <EmptyState title="No matching issues" description="No active records match the issue you selected." /> : <>
          {issueCount(results.summary, results.issue) > 25 ? <div className="data-quality-results-toolbar">
            <form action="/membership/data-quality" method="get" className="data-quality-page-size">
              {results.issue !== "all" ? <input type="hidden" name="issue" value={results.issue} /> : null}
              <label htmlFor="data-quality-limit">Show</label>
              <select id="data-quality-limit" name="limit" defaultValue={String(results.pageSize)} aria-label="People per page"><option value="25">25</option><option value="50">50</option></select>
              <span>per page</span>
              <button className="button secondary data-quality-apply-size" type="submit">Apply</button>
            </form>
          </div> : null}

          <div className="data-quality-desktop-results">
            <DataTable caption="Data-quality issues" headers={["Person", "Issues", "Work", "Updated", "Actions"]}>
              {results.people.map((person) => <tr key={person.handle}>
                <td><div className="person-membership-stack">{canOpenMember ? <Link className="data-quality-person-link" href={`/outreach/${person.handle}`}><strong>{person.displayName}</strong></Link> : <strong>{person.displayName}</strong>}<StatusBadge>{membershipLabel(person.membershipStatus)}</StatusBadge></div></td>
                <td>{person.issues.map((issue) => <div className="data-quality-issue" key={issue}><strong>{labels.get(issue)}</strong><div className="muted">{explanations.get(issue)}</div></div>)}</td>
                <td>{person.classification || "Classification unavailable"}<div className="muted">{person.department || "Department unavailable"}<br />{person.workLocation || "Work location unavailable"}</div></td>
                <td>{formatDate(person.updatedAt)}</td>
                <td className="data-quality-actions-cell">
                  {hasDirectIssue(person.issues) ? <DataQualityFixControls displayName={person.displayName} personHandle={person.handle} issues={person.issues} /> : null}
                  <div className="data-quality-secondary-actions">
                    {canOpenMember ? <Link href={`/outreach/${person.handle}`}>Outreach record</Link> : null}
                    <Link href="/imports">Data imports</Link>
                  </div>
                </td>
              </tr>)}
            </DataTable>
          </div>

          <div className="data-quality-mobile-results" aria-label="Data-quality issues">
            {results.people.map((person) => <article className="data-quality-mobile-row" key={person.handle}>
              <div className="data-quality-mobile-heading">
                <h3>{canOpenMember ? <Link href={`/outreach/${person.handle}`}>{person.displayName}</Link> : person.displayName}</h3>
                <StatusBadge>{membershipLabel(person.membershipStatus)}</StatusBadge>
              </div>
              <div className="data-quality-mobile-issues">{person.issues.map((issue) => <div key={issue}><strong>{labels.get(issue)}</strong><div className="muted">{explanations.get(issue)}</div></div>)}</div>
              <div className="data-quality-mobile-work"><strong>Work</strong><span>{person.classification || "Classification unavailable"}</span><span>{person.department || "Department unavailable"}</span><span>{person.workLocation || "Work location unavailable"}</span></div>
              <div className="muted data-quality-mobile-updated">Updated {formatDate(person.updatedAt)}</div>
              {hasDirectIssue(person.issues) ? <DataQualityFixControls displayName={person.displayName} personHandle={person.handle} issues={person.issues} /> : null}
              <div className="data-quality-secondary-actions">{canOpenMember ? <Link href={`/outreach/${person.handle}`}>Outreach record</Link> : null}<Link href="/imports">Data imports</Link></div>
            </article>)}
          </div>

          <Pagination historyBackFallbackHref={hasCursor ? href(results, null) : null} nextHref={results.nextCursor ? href(results, results.nextCursor) : null} label={issueCount(results.summary, results.issue) <= results.pageSize ? `Showing ${peopleLabel(issueCount(results.summary, results.issue))}` : `Showing ${results.people.length.toLocaleString()} of ${peopleLabel(issueCount(results.summary, results.issue))}`} />
        </>}
      </SectionCard>

      <DisclosureCard className="data-quality-roster-reference" title="How missing roster matches are handled" description="A missing roster match is a review flag, not proof of a drop.">
        <p>If someone is missing from the latest approved roster, this page treats it as something to review—not proof that they separated, dropped membership, or should be archived. It is not treated as a drop, separation, archive, or membership change. Review the outreach record when authorized, or correct the roster through Data Imports when the approved source is wrong.</p>
      </DisclosureCard>
    </>}
  </div></ProtectedPage>;
}
