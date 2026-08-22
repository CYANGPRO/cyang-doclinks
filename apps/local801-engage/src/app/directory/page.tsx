import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { DEFAULT_DIRECTORY_PAGE_SIZE, getDirectoryPage, type DirectoryPage as Results } from "@/lib/directory";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceAuthenticatedRateLimit } from "@/lib/rate-limit";

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
function dateLabel(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

export default async function DirectoryPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "viewDirectory")) redirect("/unauthorized");
  const canOpenEmployee = can(user.role, "recordEngagement");
  const parameters = await searchParams;
  let results = emptyResults(); let unavailable = false; let protectedReadEnabled = false;
  try {
    const context = await resolveWorkspaceContext(user);
    const limit = await enforceAuthenticatedRateLimit({ organizationId: context.organizationId, userId: context.userId, policy: "search" });
    if (!limit.ok) throw new Error("Directory rate limit denied.");
    results = await getDirectoryPage(context, { term: parameters.q, scope: parameters.scope, pageSize: parameters.limit, cursor: parameters.cursor, membershipStatus: parameters.membershipStatus, department: parameters.department, classification: parameters.classification, workLocation: parameters.workLocation });
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
  return <ProtectedPage permission="viewDirectory"><div className="content">
    <PageHeader eyebrow="Members" title="Directory" description="Fast, server-side lookup with organization isolation, assignment scope for CAT roles, deterministic keyset pagination, and minimized contact fields." />
    <SectionCard>
      <form action="/directory" method="get">
        <FilterBar>
          <div className="field"><label htmlFor="directory-search">Search</label><input id="directory-search" name="q" type="search" maxLength={100} defaultValue={results.term} placeholder="Name, department, location, classification, or work email" /></div>
          <div className="field"><label htmlFor="directory-scope">Scope</label><select id="directory-scope" name="scope" defaultValue={results.requestedScope}><option value="assigned">Assigned records</option><option value="authorized">All authorized records</option></select></div>
          <div className="field"><label htmlFor="membershipStatus">Membership status</label><select id="membershipStatus" name="membershipStatus" defaultValue={results.filters.membershipStatus}><option value="">Any status</option><option value="member">Member</option><option value="nonmember">Nonmember</option><option value="unknown">Unknown</option></select></div>
          <div className="field"><label htmlFor="department">Department</label><input id="department" name="department" maxLength={80} defaultValue={results.filters.department} /></div>
          <div className="field"><label htmlFor="classification">Classification</label><input id="classification" name="classification" maxLength={80} defaultValue={results.filters.classification} /></div>
          <div className="field"><label htmlFor="workLocation">Work location</label><input id="workLocation" name="workLocation" maxLength={80} defaultValue={results.filters.workLocation} /></div>
          <div className="field"><label htmlFor="limit">Rows per page</label><select id="limit" name="limit" defaultValue={String(results.pageSize)}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></div>
          <button className="button" type="submit">Search directory</button>
        </FilterBar>
      </form>
      {constrained ? <p className="muted">Your role is limited to current primary or backup assignments. Query parameters cannot broaden this scope.</p> : null}
    </SectionCard>
    <SectionCard title="Results" badge={<StatusBadge tone={unavailable ? "warning" : "info"}>{unavailable ? "Unavailable" : protectedReadEnabled ? `Protected PII · ${results.total} found` : `${results.total} found`}</StatusBadge>}>
      {unavailable ? <UnavailableState title="Directory unavailable" description="Results are withheld because an authorized database and protected-PII context could not be established." /> : results.people.length === 0 ? <EmptyState title="No matching records" description="No active, authorized records matched the current server-side filters." /> : <>
        <DataTable caption="Authorized directory results" headers={canOpenEmployee ? ["Person", "Hire Date", "Job Status", "Classification", "Department / Work Location", "Work Email", "Work Phone", "Cell Phone", "Home Phone", "Home Email", "Action"] : ["Person", "Hire Date", "Job Status", "Classification", "Department / Work Location", "Work Email", "Work Phone", "Cell Phone", "Home Phone", "Home Email"]}>
          {results.people.map((person) => <tr key={person.handle}>
            <td><strong>{person.displayName}</strong>{person.membershipStatus ? <div><StatusBadge>{person.membershipStatus}</StatusBadge></div> : null}</td>
            <td>{dateLabel(person.hireDate)}</td>
            <td>{person.jobStatus || "—"}</td>
            <td>{person.classification || "—"}</td>
            <td>{person.department || "—"}<div className="muted">{person.workLocation || "Work location unavailable"}</div></td>
            <td>{person.workEmail ? <a href={`mailto:${person.workEmail}`}>{person.workEmail}</a> : "—"}</td>
            <td>{person.workPhone || "—"}</td>
            <td>{person.cellPhone || "—"}</td>
            <td>{person.homePhone || "—"}</td>
            <td>{person.homeEmail ? <a href={`mailto:${person.homeEmail}`}>{person.homeEmail}</a> : "—"}</td>
            {canOpenEmployee ? <td><Link className="button secondary" href={`/outreach/${person.handle}`}>Open employee</Link></td> : null}
          </tr>)}
        </DataTable>
        <Pagination previousHref={results.previousCursor ? href(results, results.previousCursor) : null} nextHref={results.nextCursor ? href(results, results.nextCursor) : null} label={`Showing up to ${results.pageSize} of ${results.total}`} />
      </>}
    </SectionCard>
  </div></ProtectedPage>;
}
