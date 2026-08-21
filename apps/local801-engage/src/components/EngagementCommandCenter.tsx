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
  return `last ${period.replace("d", " days")}`;
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

export function EngagementCommandCenter({ report }: { report: EngagementCommandCenterReport }) {
  const coverageRows = report.filters.breakdown === "department" ? report.departments : report.workLocations;
  const coverageLabel = report.filters.breakdown === "department" ? "Department" : "Work location";
  const recentLabel = periodLabel(report.filters.period);
  const attentionCount = report.overview.neverEngagedCount
    + report.overview.unassignedCount
    + report.followups.overdueCount
    + report.newHires.missed14DayTargetCount;

  return <>
    <SectionCard title="Engagement filters" description="Filters update the entire command center while keeping the detailed reports available for drill-down." badge={<StatusBadge tone="info">Bookmarkable</StatusBadge>}>
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
          <span className="muted">Employee group</span>
          <select name="group" defaultValue={report.filters.employeeGroup}>
            <option value="all">All represented</option>
            <option value="new-hires">New hires in period</option>
          </select>
        </label>
        <button className="button" type="submit">Apply filters</button>
        <a className="button secondary" href="/reports?view=overview">Reset</a>
      </form>
    </SectionCard>

    {attentionCount > 0 ? <AlertBanner title="Engagement needs attention">
      Current filters show {whole(report.overview.neverEngagedCount)} never engaged, {whole(report.overview.unassignedCount)} unassigned, {whole(report.followups.overdueCount)} overdue follow-ups, and {whole(report.newHires.missed14DayTargetCount)} new hires missed the 14-day first-engagement target.
    </AlertBanner> : null}

    <SectionCard title="Engagement command center" description={`Unique-employee coverage for ${recentLabel}; event volume is intentionally kept separate from employee reach.`} badge={<StatusBadge tone="ready">Aggregate only</StatusBadge>}>
      <div className="metrics-grid">
        <StatCard label="Represented" value={whole(report.overview.representedCount)} detail="Employees in the filtered cohort" tone="brand" />
        <StatCard label="Assigned" value={whole(report.overview.assignedCount)} detail={`${percent(report.overview.assignmentRate)} assignment coverage`} tone="brand" />
        <StatCard label="Ever engaged" value={whole(report.overview.everEngagedCount)} detail={`${percent(report.overview.coverageRate)} employee coverage`} />
        <StatCard label="Engaged in period" value={whole(report.overview.recentEngagedCount)} detail={`${percent(report.overview.recentCoverageRate)} of represented`} />
      </div>
    </SectionCard>

    <SectionCard title="Coverage journey" description="Distinct-employee coverage indicators. They are not required to be sequential, and a recorded engagement is not automatically treated as a successful conversation." badge={<StatusBadge tone="info">Unique employees</StatusBadge>}>
      <DataTable caption="Engagement coverage journey" headers={["Stage", "Employees", "Coverage"]}>
        <tr><td><strong>Represented</strong></td><td>{whole(report.overview.representedCount)}</td><td>100.0%</td></tr>
        <tr><td><strong>Assigned</strong></td><td>{whole(report.overview.assignedCount)}</td><td>{percent(report.overview.assignmentRate)}</td></tr>
        <tr><td><strong>Ever engaged</strong></td><td>{whole(report.overview.everEngagedCount)}</td><td>{percent(report.overview.coverageRate)}</td></tr>
        <tr><td><strong>Willing to act</strong></td><td>{whole(report.actionReadiness.willingEmployeeCount)}</td><td>{percent(report.actionReadiness.willingEmployeeRate)}</td></tr>
        <tr><td><strong>Engaged in period</strong></td><td>{whole(report.overview.recentEngagedCount)}</td><td>{percent(report.overview.recentCoverageRate)}</td></tr>
      </DataTable>
    </SectionCard>

    <SectionCard title="Needs attention" description="These are aggregate workload signals. Person-level work remains in Outreach and Follow-ups, subject to their own permissions." badge={<StatusBadge tone="info">Operational gaps</StatusBadge>}>
      <div className="metrics-grid">
        <StatCard label="Never engaged" value={whole(report.overview.neverEngagedCount)} detail="No non-voided engagement on record" tone={report.overview.neverEngagedCount > 0 ? "attention" : "default"} />
        <StatCard label="Unassigned" value={whole(report.overview.unassignedCount)} detail="No active engagement assignment" tone={report.overview.unassignedCount > 0 ? "attention" : "default"} />
        <StatCard label="Stale 90+ days" value={whole(report.overview.stale90Count)} detail="Previously engaged, but last engagement is over 90 days old" tone={report.overview.stale90Count > 0 ? "attention" : "default"} />
        <StatCard label="Overdue follow-ups" value={whole(report.followups.overdueCount)} detail="Outstanding and past due" tone={report.followups.overdueCount > 0 ? "attention" : "default"} />
        <StatCard label="Missed 14-day target" value={whole(report.newHires.missed14DayTargetCount)} detail="First recorded engagement occurred late or has not occurred" tone={report.newHires.missed14DayTargetCount > 0 ? "attention" : "default"} />
      </div>
    </SectionCard>

    <SectionCard title="Engagement depth" description={`How many engagement events each represented employee has in the ${recentLabel}.`} badge={<StatusBadge tone="info">Distinct employees</StatusBadge>}>
      <DataTable caption="Engagement depth" headers={["Depth", "Employees", "Share of cohort"]}>
        {report.depth.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{whole(row.employeeCount)}</td><td>{percent(row.employeeRate)}</td></tr>)}
      </DataTable>
    </SectionCard>

    <SectionCard title="Employee action readiness" description="Current running willingness profile across the filtered employee cohort. Individual willingness can grow across engagements; an employee may also decline a specific action or decline all actions. The current state persists until a later response changes it." badge={<StatusBadge tone="info">Current state</StatusBadge>}>
      <div className="metrics-grid">
        <StatCard label="Readiness recorded" value={whole(report.actionReadiness.actionSignalCount)} detail={`${percent(report.actionReadiness.readinessCaptureRate)} of ever-engaged employees have a current action response`} />
        <StatCard label="Willing to act" value={whole(report.actionReadiness.willingEmployeeCount)} detail={`${percent(report.actionReadiness.willingEmployeeRate)} of represented employees`} tone="brand" />
        <StatCard label="Considering" value={whole(report.actionReadiness.consideringEmployeeCount)} detail="Considering at least one action, with no current willing action" />
        <StatCard label="Completed an action" value={whole(report.actionReadiness.completedEmployeeCount)} detail="Completed at least one currently tracked employee action" />
        <StatCard label="Declines all actions" value={whole(report.actionReadiness.declinesAllCount)} detail="Explicit employee preference; prior willingness stays in history but is not current" />
        <StatCard label="Specific-action declines" value={whole(report.actionReadiness.specificDeclineEmployeeCount)} detail="Declined one or more listed actions" />
        <StatCard label="No readiness recorded" value={whole(report.actionReadiness.noActionSignalCount)} detail="No current action willingness, consideration, decline, or all-actions posture recorded" />
      </div>
      <div className="stat-detail" style={{ marginTop: 12 }}>Current willing action selections: {whole(report.actionReadiness.willingActionCount)} across {whole(report.actionReadiness.willingEmployeeCount)} employees. Completed action selections: {whole(report.actionReadiness.completedActionCount)}.</div>
    </SectionCard>

    <SectionCard title="Willingness by action" description="The action catalog is dynamic. Actions can be organization-wide or linked to a campaign or CAT action, and can be ranked from engagement level 1 through 5." badge={<StatusBadge tone="info">Top {Math.min(report.actionReadinessByAction.length, 50)} shown</StatusBadge>}>
      {report.actionReadinessByAction.length === 0 ? <EmptyState title="No employee action catalog yet" description="No active employee action choices have been defined. The action catalog can be added without changing the employee engagement history model." /> : (
        <DataTable caption="Employee willingness by action" headers={["Action", "Engagement level", "Willing", "Considering", "Declined", "Completed"]}>
          {report.actionReadinessByAction.map((row) => <tr key={`${row.engagementLevel}:${row.label}`}>
            <td><strong>{row.label}</strong></td>
            <td>Level {whole(row.engagementLevel)}</td>
            <td>{whole(row.willingCount)}</td>
            <td>{whole(row.consideringCount)}</td>
            <td>{whole(row.declinedCount)}</td>
            <td>{whole(row.completedCount)}</td>
          </tr>)}
        </DataTable>
      )}
    </SectionCard>

    <SectionCard title="Action willingness depth" description="How many actions each represented employee is currently willing to take. A decline-all response resets earlier willingness without erasing its history." badge={<StatusBadge tone="info">Engagement ladder</StatusBadge>}>
      <DataTable caption="Action willingness depth" headers={["Current willing actions", "Employees", "Share of cohort"]}>
        {report.actionReadinessDepth.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{whole(row.employeeCount)}</td><td>{percent(row.employeeRate)}</td></tr>)}
      </DataTable>
    </SectionCard>

    <SectionCard title="Coverage gaps" description={`Compare unique employee coverage by ${coverageLabel.toLowerCase()}.`} badge={<StatusBadge tone="info">Top {Math.min(coverageRows.length, 50)} shown</StatusBadge>}>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <a className="button secondary" aria-current={report.filters.breakdown === "department" ? "page" : undefined} href={filterUrl(report, "department")}>By department</a>
        <a className="button secondary" aria-current={report.filters.breakdown === "work-location" ? "page" : undefined} href={filterUrl(report, "work-location")}>By work location</a>
      </div>
      {coverageRows.length === 0 ? <EmptyState title="No coverage breakdown" description="No employees match the current filters." /> : (
        <DataTable caption={`Coverage by ${coverageLabel.toLowerCase()}`} headers={[coverageLabel, "Represented", "Ever engaged", "Recent", "Never", "Coverage", "Recent coverage"]}>
          {coverageRows.map((row) => <tr key={row.label}>
            <td><strong>{row.label}</strong></td>
            <td>{whole(row.representedCount)}</td>
            <td>{whole(row.everEngagedCount)}</td>
            <td>{whole(row.recentEngagedCount)}</td>
            <td>{whole(row.neverEngagedCount)}</td>
            <td>{percent(row.coverageRate)}</td>
            <td>{percent(row.recentCoverageRate)}</td>
          </tr>)}
        </DataTable>
      )}
    </SectionCard>

    <SectionCard title="Follow-up health" description="Outstanding workload, due-date risk, and completion timing for follow-ups tied to the filtered employee cohort." badge={<StatusBadge tone="info">Workflow health</StatusBadge>}>
      <div className="metrics-grid">
        <StatCard label="Outstanding" value={whole(report.followups.outstandingCount)} detail="Not yet completed" />
        <StatCard label="Overdue" value={whole(report.followups.overdueCount)} detail="Outstanding and past due" tone={report.followups.overdueCount > 0 ? "attention" : "default"} />
        <StatCard label="Due in 7 days" value={whole(report.followups.dueSoonCount)} detail="Upcoming outstanding work" />
        <StatCard label="Completed" value={whole(report.followups.completedCount)} detail={report.followups.averageCloseDays === null ? "Average close time unavailable" : `${report.followups.averageCloseDays.toFixed(1)} average days to close`} />
      </div>
    </SectionCard>

    <SectionCard title="New-hire contact timeliness" description="Measures the first recorded engagement on or after the most recent hire date. It does not treat pre-hire engagement as new-hire outreach." badge={<StatusBadge tone="info">Selected period</StatusBadge>}>
      {report.newHires.hireCount === 0 ? <EmptyState title="No new hires in this cohort" description="No recorded hires match the current filters and period." /> : (
        <div className="metrics-grid">
          <StatCard label="New hires" value={whole(report.newHires.hireCount)} detail="Most recent hire per employee" tone="brand" />
          <StatCard label="Within 7 days" value={whole(report.newHires.engagedWithin7Count)} detail={`${percent(report.newHires.within7Rate)} received a recorded engagement`} />
          <StatCard label="Within 14 days" value={whole(report.newHires.engagedWithin14Count)} detail={`${percent(report.newHires.within14Rate)} received a recorded engagement`} />
          <StatCard label="Within 30 days" value={whole(report.newHires.engagedWithin30Count)} detail={`${percent(report.newHires.within30Rate)} received a recorded engagement`} />
        </div>
      )}
    </SectionCard>

    <SectionCard title="CAT team coverage" description={`Assignment coverage and recorded activity for ${recentLabel}. This measures follow-through on assigned employees rather than ranking CAT members by raw event count.`} badge={<StatusBadge tone="info">Top {Math.min(report.organizers.length, 50)} shown</StatusBadge>}>
      {report.organizers.length === 0 ? <EmptyState title="No CAT organizer activity" description="No assignments, engagement events, or follow-ups match the current filters." /> : (
        <DataTable caption="CAT team coverage" headers={["CAT organizer", "Assigned", "Reached in period", "Coverage", "Events", "Outstanding follow-ups", "Overdue"]}>
          {report.organizers.map((row) => <tr key={row.label}>
            <td><strong>{row.label}</strong></td>
            <td>{whole(row.assignedCount)}</td>
            <td>{whole(row.reachedInPeriodCount)}</td>
            <td>{percent(row.coverageRate)}</td>
            <td>{whole(row.engagementEventCount)}</td>
            <td>{whole(row.outstandingFollowupCount)}</td>
            <td>{whole(row.overdueFollowupCount)}</td>
          </tr>)}
        </DataTable>
      )}
    </SectionCard>
  </>;
}
