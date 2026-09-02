import {
  AlertBanner,
  DataTable,
  EmptyState,
  SectionCard,
  StatCard,
  StatusBadge,
} from "@/components/DesignSystem";
import type { EngagementCommandCenterReport } from "@/lib/engagement-command-center";

function whole(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function percent(value: number) {
  return `${value.toFixed(1)}%`;
}

function periodLabel(period: EngagementCommandCenterReport["filters"]["period"]) {
  if (period === "all") return "all recorded time";
  return `the last ${period.replace("d", " days")}`;
}

function filterUrl(report: EngagementCommandCenterReport, breakdown: "department" | "work-location") {
  const params = new URLSearchParams({
    view: "overview",
    period: report.filters.period,
    group: report.filters.employeeGroup,
    breakdown,
  });
  if (report.filters.department) params.set("department", report.filters.department);
  if (report.filters.workLocation) params.set("location", report.filters.workLocation);
  if (report.filters.membershipStatus) params.set("membership", report.filters.membershipStatus);
  return `/reports?${params.toString()}`;
}

function outreachUrl(focus: "all" | "assigned" | "contacted" | "never-engaged" | "stale" | "unassigned" | "willing" = "all", extra?: Record<string, string>) {
  const params = new URLSearchParams({ scope: "authorized", focus, limit: "50", ...extra });
  return `/outreach?${params.toString()}`;
}

export function EngagementCommandCenter({ report, canOpenPeople }: { report: EngagementCommandCenterReport; canOpenPeople: boolean }) {
  const coverageRows = report.filters.breakdown === "department" ? report.departments : report.workLocations;
  const coverageLabel = report.filters.breakdown === "department" ? "Department" : "Work location";
  const recentLabel = periodLabel(report.filters.period);
  const attentionCount = report.overview.neverEngagedCount
    + report.overview.unassignedCount
    + report.followups.overdueCount
    + report.newHires.missed14DayTargetCount;

  return <>
    <SectionCard title="Filter outreach coverage" description="Apply the same period, department, work location, membership, and employee-group filters to every section below. The filtered URL can be saved as a browser bookmark.">
      <form method="get" action="/reports" className="toolbar" style={{ alignItems: "end", display: "flex", flexWrap: "wrap", gap: 12 }}>
        <input type="hidden" name="view" value="overview" />
        <input type="hidden" name="breakdown" value={report.filters.breakdown} />
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">Period</span>
          <select name="period" defaultValue={report.filters.period}>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="180d">Last 180 days</option>
            <option value="all">All recorded time</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">Department</span>
          <select name="department" defaultValue={report.filters.department ?? ""}>
            <option value="">All departments</option>
            {report.filterOptions.departments.map((label) => <option key={label} value={label}>{label}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">Work location</span>
          <select name="location" defaultValue={report.filters.workLocation ?? ""}>
            <option value="">All locations</option>
            {report.filterOptions.workLocations.map((label) => <option key={label} value={label}>{label}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">Membership</span>
          <select name="membership" defaultValue={report.filters.membershipStatus ?? ""}>
            <option value="">All statuses</option>
            <option value="member">Members</option>
            <option value="nonmember">Nonmembers</option>
            <option value="unknown">Other / unknown</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">Group</span>
          <select name="group" defaultValue={report.filters.employeeGroup}>
            <option value="all">All represented</option>
            <option value="new-hires">New hires in period</option>
          </select>
        </label>
        <button className="button" type="submit">Apply filters</button>
        <a className="button secondary" href="/reports?view=overview">Reset</a>
      </form>
    </SectionCard>

    {attentionCount > 0 ? <AlertBanner title="Some work needs attention">
      This view includes {whole(report.overview.neverEngagedCount)} with no recorded contact, {whole(report.overview.unassignedCount)} unassigned, {whole(report.followups.overdueCount)} overdue follow-ups, and {whole(report.newHires.missed14DayTargetCount)} new hires without a first recorded contact within 14 days.
    </AlertBanner> : null}

    <SectionCard title="Assignment and contact coverage" description={`Represented people assigned to an organizer or reached during ${recentLabel}. Recorded contact volume is reported separately so repeated contacts do not inflate the number of people reached.`}>
      <div className="metrics-grid">
        <StatCard label="Represented" value={whole(report.overview.representedCount)} detail="People in this view" tone="brand" href={canOpenPeople ? outreachUrl() : undefined} />
        <StatCard label="Assigned" value={whole(report.overview.assignedCount)} detail={`${percent(report.overview.assignmentRate)} assignment coverage`} tone="brand" href={canOpenPeople ? outreachUrl("assigned") : undefined} />
        <StatCard label="Ever contacted" value={whole(report.overview.everEngagedCount)} detail={`${percent(report.overview.coverageRate)} of represented`} href={canOpenPeople ? outreachUrl("contacted") : undefined} />
        <StatCard label="Contacted in period" value={whole(report.overview.recentEngagedCount)} detail={`${percent(report.overview.recentCoverageRate)} of represented`} />
      </div>
    </SectionCard>

    <SectionCard title="People reached and willing to act" description="These are counts of people, not a required sequence. A recorded contact does not automatically mean a successful conversation.">
      <DataTable caption="Outreach reach" headers={["Stage", "People", "Coverage"]}>
        <tr><td><strong>{canOpenPeople ? <a href={outreachUrl()}>Represented</a> : "Represented"}</strong></td><td>{whole(report.overview.representedCount)}</td><td>100.0%</td></tr>
        <tr><td><strong>{canOpenPeople ? <a href={outreachUrl("assigned")}>Assigned</a> : "Assigned"}</strong></td><td>{whole(report.overview.assignedCount)}</td><td>{percent(report.overview.assignmentRate)}</td></tr>
        <tr><td><strong>{canOpenPeople ? <a href={outreachUrl("contacted")}>Ever contacted</a> : "Ever contacted"}</strong></td><td>{whole(report.overview.everEngagedCount)}</td><td>{percent(report.overview.coverageRate)}</td></tr>
        <tr><td><strong>{canOpenPeople ? <a href={outreachUrl("willing")}>Willing to act</a> : "Willing to act"}</strong></td><td>{whole(report.actionReadiness.willingEmployeeCount)}</td><td>{percent(report.actionReadiness.willingEmployeeRate)}</td></tr>
        <tr><td><strong>Contacted in period</strong></td><td>{whole(report.overview.recentEngagedCount)}</td><td>{percent(report.overview.recentCoverageRate)}</td></tr>
      </DataTable>
    </SectionCard>

    <SectionCard title="Outreach gaps requiring review" description="These totals identify missing assignments, old or missing contacts, overdue follow-ups, and missed new-hire contact targets. Open Member outreach or Follow-ups for authorized person-level work.">
      <div className="metrics-grid">
        <StatCard label="No contact recorded" value={whole(report.overview.neverEngagedCount)} detail="No recorded contact on file" tone={report.overview.neverEngagedCount > 0 ? "attention" : "default"} href={canOpenPeople ? outreachUrl("never-engaged") : undefined} />
        <StatCard label="Unassigned" value={whole(report.overview.unassignedCount)} detail="No active organizer assignment" tone={report.overview.unassignedCount > 0 ? "attention" : "default"} href={canOpenPeople ? outreachUrl("unassigned") : undefined} />
        <StatCard label="90+ days since contact" value={whole(report.overview.stale90Count)} detail="Last recorded contact is more than 90 days old" tone={report.overview.stale90Count > 0 ? "attention" : "default"} href={canOpenPeople ? outreachUrl("stale") : undefined} />
        <StatCard label="Overdue follow-ups" value={whole(report.followups.overdueCount)} detail="Open and past due" tone={report.followups.overdueCount > 0 ? "attention" : "default"} href={canOpenPeople ? "/follow-ups" : undefined} />
        <StatCard label="Missed 14-day new-hire target" value={whole(report.newHires.missed14DayTargetCount)} detail="First recorded contact happened late or has not happened yet" tone={report.newHires.missed14DayTargetCount > 0 ? "attention" : "default"} href={canOpenPeople ? "/new-hires" : undefined} />
      </div>
    </SectionCard>

    <SectionCard title="Recorded contact frequency" description={`Represented people grouped by how many outreach contacts were recorded during ${recentLabel}.`}>
      <DataTable caption="Contact frequency" headers={["Recorded contacts", "People", "Share of group"]}>
        {report.depth.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{whole(row.employeeCount)}</td><td>{percent(row.employeeRate)}</td></tr>)}
      </DataTable>
    </SectionCard>

    <SectionCard title="Current action responses" description="Current willingness, consideration, completion, and decline responses for organizing actions. Earlier responses remain in history when the current response changes.">
      <div className="metrics-grid">
        <StatCard label="Readiness recorded" value={whole(report.actionReadiness.actionSignalCount)} detail={`${percent(report.actionReadiness.readinessCaptureRate)} of people ever contacted have a current action response`} />
        <StatCard label="Willing to act" value={whole(report.actionReadiness.willingEmployeeCount)} detail={`${percent(report.actionReadiness.willingEmployeeRate)} of represented people`} tone="brand" href={canOpenPeople ? outreachUrl("willing") : undefined} />
        <StatCard label="Considering" value={whole(report.actionReadiness.consideringEmployeeCount)} detail="Considering at least one action, with no current willing action" />
        <StatCard label="Completed an action" value={whole(report.actionReadiness.completedEmployeeCount)} detail="Completed at least one currently tracked action" />
        <StatCard label="Declines all actions" value={whole(report.actionReadiness.declinesAllCount)} detail="Current preference is to decline all listed actions" />
        <StatCard label="Specific-action declines" value={whole(report.actionReadiness.specificDeclineEmployeeCount)} detail="Declined one or more listed actions" />
        <StatCard label="No readiness recorded" value={whole(report.actionReadiness.noActionSignalCount)} detail="No current action response on file" />
      </div>
      <div className="stat-detail" style={{ marginTop: 12 }}>Current willing selections: {whole(report.actionReadiness.willingActionCount)} across {whole(report.actionReadiness.willingEmployeeCount)} people. Completed selections: {whole(report.actionReadiness.completedActionCount)}.</div>
    </SectionCard>

    <SectionCard title="Responses by organizing action" description={`Standard and custom responses for ${Math.min(report.actionReadinessByAction.length, 50)} action${Math.min(report.actionReadinessByAction.length, 50) === 1 ? "" : "s"}.`}>
      {report.actionReadinessByAction.length === 0 ? <EmptyState title="No actions set up yet" description="There are no active action choices to report on." /> : (
        <DataTable caption="Willingness by action" headers={["Action", "Engagement level", "Willing", "Considering", "Declined", "Completed", "Additional responses"]}>
          {report.actionReadinessByAction.map((row) => <tr key={`${row.engagementLevel}:${row.label}`}>
            <td><strong>{canOpenPeople ? <a href={outreachUrl("willing", { action: row.handle })}>{row.label}</a> : row.label}</strong></td>
            <td>Level {whole(row.engagementLevel)}</td>
            <td>{canOpenPeople && row.willingCount > 0 ? <a href={outreachUrl("willing", { action: row.handle })}>{whole(row.willingCount)}</a> : whole(row.willingCount)}</td>
            <td>{whole(row.consideringCount)}</td>
            <td>{whole(row.declinedCount)}</td>
            <td>{whole(row.completedCount)}</td>
            <td>{row.customResponses.length ? <div className="page-actions compact-actions">{row.customResponses.map((response) => <StatusBadge key={response.value} tone="info">{response.label}: {whole(response.count)}</StatusBadge>)}</div> : <span className="muted">None configured</span>}</td>
          </tr>)}
        </DataTable>
      )}
    </SectionCard>

    <SectionCard title="Number of current willing actions per person" description="People grouped by their number of current willing responses. A decline-all response clears current willingness without erasing earlier history.">
      <DataTable caption="Action willingness depth" headers={["Current willing actions", "People", "Share of group"]}>
        {report.actionReadinessDepth.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{whole(row.employeeCount)}</td><td>{percent(row.employeeRate)}</td></tr>)}
      </DataTable>
    </SectionCard>

    <SectionCard title="Contact coverage by department or work location" description={`Represented, contacted, recent, and never-contacted counts for ${Math.min(coverageRows.length, 50)} ${coverageLabel.toLowerCase()} group${Math.min(coverageRows.length, 50) === 1 ? "" : "s"}.`}>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <a className="button secondary" aria-current={report.filters.breakdown === "department" ? "page" : undefined} href={filterUrl(report, "department")}>By department</a>
        <a className="button secondary" aria-current={report.filters.breakdown === "work-location" ? "page" : undefined} href={filterUrl(report, "work-location")}>By work location</a>
      </div>
      {coverageRows.length === 0 ? <EmptyState title="No coverage breakdown" description="No one matches the current filters." /> : (
        <DataTable caption={`Coverage by ${coverageLabel.toLowerCase()}`} headers={[coverageLabel, "Represented", "Ever contacted", "Recent", "Never", "Coverage"]}>
          {coverageRows.map((row) => <tr key={row.label}>
            <td><strong>{canOpenPeople ? <a href={outreachUrl("all", { q: row.label })}>{row.label}</a> : row.label}</strong></td>
            <td>{whole(row.representedCount)}</td>
            <td>{whole(row.everEngagedCount)}</td>
            <td>{whole(row.recentEngagedCount)}</td>
            <td>{whole(row.neverEngagedCount)}</td>
            <td>{percent(row.coverageRate)}</td>
          </tr>)}
        </DataTable>
      )}
    </SectionCard>

    <SectionCard title="Follow-up workload" description="Outstanding, overdue, due-soon, and completed follow-ups, including average completion time when available.">
      <div className="metrics-grid">
        <StatCard label="Outstanding" value={whole(report.followups.outstandingCount)} detail="Not yet completed" />
        <StatCard label="Overdue" value={whole(report.followups.overdueCount)} detail="Open and past due" tone={report.followups.overdueCount > 0 ? "attention" : "default"} />
        <StatCard label="Due in 7 days" value={whole(report.followups.dueSoonCount)} detail="Upcoming work" />
        <StatCard label="Completed" value={whole(report.followups.completedCount)} detail={report.followups.averageCloseDays === null ? "Average close time unavailable" : `${report.followups.averageCloseDays.toFixed(1)} average days to close`} />
      </div>
    </SectionCard>

    <SectionCard title="New-hire first-contact timing" description="First recorded outreach contact on or after the latest hire date, grouped into 7-, 14-, and 30-day windows. Earlier contacts are excluded.">
      {report.newHires.hireCount === 0 ? <EmptyState title="No new hires in this group" description="No recorded hires match the current filters and period." /> : (
        <div className="metrics-grid">
          <StatCard label="New hires" value={whole(report.newHires.hireCount)} detail="Most recent hire per person" tone="brand" />
          <StatCard label="Within 7 days" value={whole(report.newHires.engagedWithin7Count)} detail={`${percent(report.newHires.within7Rate)} had a recorded contact`} />
          <StatCard label="Within 14 days" value={whole(report.newHires.engagedWithin14Count)} detail={`${percent(report.newHires.within14Rate)} had a recorded contact`} />
          <StatCard label="Within 30 days" value={whole(report.newHires.engagedWithin30Count)} detail={`${percent(report.newHires.within30Rate)} had a recorded contact`} />
        </div>
      )}
    </SectionCard>

    <SectionCard title="Organizer assignment and contact coverage" description={`Assigned people, recorded contacts, and open follow-ups for ${Math.min(report.organizers.length, 50)} organizer${Math.min(report.organizers.length, 50) === 1 ? "" : "s"} during ${recentLabel}. Open an organizer's list to review people and change direct assignments.`}>
      {canOpenPeople ? <div className="toolbar" style={{ marginBottom: 12 }}><a className="button secondary" href={outreachUrl()}>Open assignment oversight</a></div> : null}
      {report.organizers.length === 0 ? <EmptyState title="No CAT organizer activity" description="No assignments, recorded contacts, or follow-ups match the current filters." /> : (
        <DataTable caption="CAT team coverage" headers={["CAT organizer", "Assigned", "Reached in period", "Coverage", "Follow-ups"]}>
          {report.organizers.map((row) => <tr key={row.label}>
            <td><strong>{canOpenPeople ? <a href={outreachUrl("all", { assignee: row.handle })}>{row.label}</a> : row.label}</strong></td>
            <td>{whole(row.assignedCount)}</td>
            <td>{whole(row.reachedInPeriodCount)}</td>
            <td>{percent(row.coverageRate)}</td>
            <td>{whole(row.outstandingFollowupCount)} open<div className="muted">{whole(row.overdueFollowupCount)} overdue</div></td>
          </tr>)}
        </DataTable>
      )}
    </SectionCard>
  </>;
}
