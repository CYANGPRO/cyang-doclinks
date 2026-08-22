import { redirect } from "next/navigation";
import {
  AlertBanner,
  DataTable,
  EmptyState,
  PageHeader,
  SectionCard,
  StatCard,
  StatusBadge,
  UnavailableState,
} from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { EngagementCommandCenter } from "@/components/EngagementCommandCenter";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getCampaignReport, type CampaignPerformance } from "@/lib/campaign-reports";
import { getCatActionReport, type CatActionPerformance } from "@/lib/cat-action-reports";
import { getEngagementCommandCenterReport } from "@/lib/engagement-command-center";
import {
  hydrateCommandCenterReportFromProtectedPii,
  hydrateEngagementReportFromProtectedPii,
} from "@/lib/pii-protected-report-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import {
  getEngagementReport,
  getMembershipReport,
  getNewHireReport,
  type EngagementBreakdown,
  type EngagementTrendPoint,
  type MembershipBreakdown,
  type MembershipChangePoint,
  type NewHireBreakdown,
  type NewHireTrendPoint,
} from "@/lib/reports";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceAuthenticatedRateLimit } from "@/lib/rate-limit";
import { recordReportAccess } from "@/lib/report-access";

type ReportView = "overview" | "membership" | "new-hires" | "engagement" | "campaigns" | "cat-actions" | "data-quality";

const reportTabs = [
  { key: "overview", label: "Overview", state: "ready" },
  { key: "membership", label: "Membership", state: "ready" },
  { key: "new-hires", label: "New hires", state: "ready" },
  { key: "engagement", label: "Engagement", state: "ready" },
  { key: "campaigns", label: "Campaigns", state: "ready" },
  { key: "cat-actions", label: "CAT actions", state: "ready" },
  { key: "data-quality", label: "Data quality", state: "ready" },
] as const;

function selectedView(value: string | string[] | undefined): ReportView {
  const selected = Array.isArray(value) ? value[0] : value;
  return selected === "membership" || selected === "new-hires" || selected === "engagement" || selected === "campaigns" || selected === "cat-actions" || selected === "data-quality"
    ? selected
    : "overview";
}

function whole(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function percent(value: number) {
  return `${value.toFixed(1)}%`;
}

function monthLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function refreshedLabel(value: string | null) {
  if (!value) return "Refresh time unavailable";
  return `Database refreshed ${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(new Date(value))}`;
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

function reportNavigation(activeView: ReportView) {
  const activeTab = reportTabs.find((tab) => tab.key === activeView) ?? reportTabs[0];
  return (
    <>
      <p className="muted" style={{ fontSize: ".82rem", margin: "0 0 10px" }}>
        Viewing <strong style={{ color: "var(--text)" }}>{activeTab.label}</strong>. Swipe or scroll the tabs for another report.
      </p>
      <nav
        aria-label="Report views"
        style={{
          display: "flex",
          gap: 8,
          margin: 0,
          overflowX: "auto",
          padding: "2px 2px 8px",
          scrollbarWidth: "thin",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {reportTabs.map((tab) => tab.state === "ready" ? (
          <a
            key={tab.key}
            href={`/reports?view=${tab.key}`}
            aria-current={activeView === tab.key ? "page" : undefined}
            className={activeView === tab.key ? "button" : "button secondary"}
            style={{ flex: "0 0 auto", minHeight: 38, padding: "8px 12px", whiteSpace: "nowrap" }}
          >
            {tab.label}
          </a>
        ) : (
          <span key={tab.key} aria-disabled="true" title={`${tab.label} reporting is coming in a later stage`}>
            <StatusBadge tone="pending">{tab.label} · upcoming</StatusBadge>
          </span>
        ))}
      </nav>
    </>
  );
}

function breakdownTable(title: string, rows: MembershipBreakdown[]) {
  const dimensionLabel = title.endsWith("job status") ? "Job status" : title.endsWith("department") ? "Department" : "Work location";
  return (
    <SectionCard title={title} badge={<StatusBadge tone="info">Top {Math.min(rows.length, 50)} shown</StatusBadge>}>
      {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} data`} description="No aggregate membership rows are available for this organization." /> : (
        <DataTable caption={title} headers={[dimensionLabel, "Represented", "Members", "Nonmembers", "Other / unknown", "Member rate"]}>
          {rows.map((row) => (
            <tr key={row.label}>
              <td><strong>{row.label}</strong></td>
              <td>{whole(row.representedCount)}</td>
              <td>{whole(row.memberCount)}</td>
              <td>{whole(row.nonmemberCount)}</td>
              <td>{whole(row.otherCount)}</td>
              <td>{percent(row.membershipRate)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

function changesChart(rows: MembershipChangePoint[]) {
  if (rows.length === 0) {
    return <EmptyState title="No membership changes" description="No additions or drops are available in the most recent reporting period." />;
  }
  const max = Math.max(1, ...rows.flatMap((row) => [row.additions, row.drops]));
  return (
    <div className="grid">
      {rows.map((row) => (
        <div key={row.month} style={{ display: "grid", gap: 6 }}>
          <strong>{monthLabel(row.month)}</strong>
          <div style={{ alignItems: "center", display: "grid", gap: 8, gridTemplateColumns: "72px minmax(120px, 1fr) auto" }}>
            <span className="muted">Additions</span>
            <div className="progress-track"><div className="progress-fill" style={{ background: "var(--success)", width: `${(row.additions / max) * 100}%` }} /></div>
            <strong>{whole(row.additions)}</strong>
          </div>
          <div style={{ alignItems: "center", display: "grid", gap: 8, gridTemplateColumns: "72px minmax(120px, 1fr) auto" }}>
            <span className="muted">Drops</span>
            <div className="progress-track"><div className="progress-fill" style={{ background: "var(--danger)", width: `${(row.drops / max) * 100}%` }} /></div>
            <strong>{whole(row.drops)}</strong>
          </div>
          <div className="stat-detail">Net change: {row.netChange > 0 ? "+" : ""}{whole(row.netChange)}</div>
        </div>
      ))}
    </div>
  );
}

function newHireTrend(rows: NewHireTrendPoint[]) {
  if (rows.length === 0) {
    return <EmptyState title="No new-hire trend data" description="No aggregate new-hire conversion rows are available for this organization." />;
  }
  const max = Math.max(1, ...rows.map((row) => row.newHires));
  return (
    <div className="grid">
      {rows.map((row) => (
        <div key={row.month} style={{ display: "grid", gap: 6 }}>
          <strong>{monthLabel(row.month)}</strong>
          <div style={{ alignItems: "center", display: "grid", gap: 8, gridTemplateColumns: "88px minmax(120px, 1fr) auto" }}>
            <span className="muted">New hires</span>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${(row.newHires / max) * 100}%` }} /></div>
            <strong>{whole(row.newHires)}</strong>
          </div>
          <div className="stat-detail">Current members: {whole(row.currentMembers)} · Conversion: {percent(row.conversionRate)}</div>
        </div>
      ))}
    </div>
  );
}

function engagementTrend(rows: EngagementTrendPoint[]) {
  if (rows.length === 0) return <EmptyState title="No engagement trend data" description="No aggregate engagement events are available for this organization." />;
  const max = Math.max(1, ...rows.map((row) => row.eventCount));
  return <div className="grid">{rows.map((row) => <div key={row.date} style={{ display: "grid", gap: 6 }}>
    <strong>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${row.date}T00:00:00Z`))}</strong>
    <div style={{ alignItems: "center", display: "grid", gap: 8, gridTemplateColumns: "100px minmax(120px, 1fr) auto" }}>
      <span className="muted">Engagements</span>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${(row.eventCount / max) * 100}%` }} /></div>
      <strong>{whole(row.eventCount)}</strong>
    </div>
  </div>)}</div>;
}

function engagementBreakdownTable(title: string, firstHeader: string, rows: EngagementBreakdown[]) {
  return <SectionCard title={title} badge={<StatusBadge tone="info">Top {Math.min(rows.length, 50)} shown</StatusBadge>}>
    {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} data`} description="No aggregate engagement rows are available for this organization." /> :
      <DataTable caption={title} headers={[firstHeader, "Engagement events"]}>{rows.map((row) => <tr key={row.label}>
        <td><strong>{row.label}</strong></td><td>{whole(row.eventCount)}</td>
      </tr>)}</DataTable>}
  </SectionCard>;
}

function newHireBreakdownTable(title: string, rows: NewHireBreakdown[]) {
  const dimensionLabel = title.endsWith("job status") ? "Job status" : title.endsWith("department") ? "Department" : "Work location";
  return (
    <SectionCard title={title} badge={<StatusBadge tone="info">Top {Math.min(rows.length, 50)} shown</StatusBadge>}>
      {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} data`} description="No aggregate new-hire rows are available for this organization." /> : (
        <DataTable caption={title} headers={[dimensionLabel, "New hires"]}>
          {rows.map((row) => (
            <tr key={row.label}>
              <td><strong>{row.label}</strong></td>
              <td>{whole(row.newHireCount)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

function campaignPerformanceTable(rows: CampaignPerformance[]) {
  return (
    <SectionCard title="Campaign performance" description="Current aggregate population, assignment, contact, and completion coverage by non-archived campaign." badge={<StatusBadge tone="info">Top {Math.min(rows.length, 50)} shown</StatusBadge>}>
      {rows.length === 0 ? <EmptyState title="No campaign performance data" description="No non-archived campaigns are available for this organization." /> : (
        <DataTable caption="Campaign performance" headers={["Campaign", "Status", "Population", "Assigned", "Contacted", "Completed", "Coverage"]}>
          {rows.map((row) => (
            <tr key={`${row.name}:${row.status}`}>
              <td><strong>{row.name}</strong></td>
              <td>{statusLabel(row.status)}</td>
              <td>{whole(row.populationCount)}</td>
              <td>{whole(row.assignedCount)} <span className="muted">({percent(row.assignmentRate)})</span></td>
              <td>{whole(row.contactedCount)}</td>
              <td>{whole(row.completedCount)} <span className="muted">({percent(row.completionRate)})</span></td>
              <td>{percent(row.coverageRate)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

function catActionPerformanceTable(rows: CatActionPerformance[]) {
  return (
    <SectionCard title="CAT action performance" description="Aggregate task workload, completion, overdue work, and completed-task participation by non-archived CAT action." badge={<StatusBadge tone="info">Top {Math.min(rows.length, 50)} shown</StatusBadge>}>
      {rows.length === 0 ? <EmptyState title="No CAT action performance data" description="No non-archived CAT actions are available for this organization." /> : (
        <DataTable caption="CAT action performance" headers={["CAT action", "Status", "Tasks", "Open", "Completed", "Overdue", "Participants", "Completion"]}>
          {rows.map((row, index) => (
            <tr key={`${row.name}:${row.status}:${index}`}>
              <td><strong>{row.name}</strong></td>
              <td>{statusLabel(row.status)}</td>
              <td>{whole(row.taskCount)}</td>
              <td>{whole(row.openTaskCount)}</td>
              <td>{whole(row.completedTaskCount)}</td>
              <td>{whole(row.overdueTaskCount)}</td>
              <td>{whole(row.participantCount)}</td>
              <td>{percent(row.completionRate)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "viewReports")) redirect("/unauthorized");

  const params = await searchParams;
  const view = selectedView(params.view);
  let commandCenterReport: Awaited<ReturnType<typeof getEngagementCommandCenterReport>> | null = null;
  let membershipReport: Awaited<ReturnType<typeof getMembershipReport>> | null = null;
  let newHireReport: Awaited<ReturnType<typeof getNewHireReport>> | null = null;
  let engagementReport: Awaited<ReturnType<typeof getEngagementReport>> | null = null;
  let campaignReport: Awaited<ReturnType<typeof getCampaignReport>> | null = null;
  let catActionReport: Awaited<ReturnType<typeof getCatActionReport>> | null = null;
  let protectedReadEnabled = false;

  try {
    const context = await resolveWorkspaceContext(user);
    const limit = await enforceAuthenticatedRateLimit({ organizationId: context.organizationId, userId: context.userId, policy: "download_export" });
    if (!limit.ok) throw new Error("Report rate limit denied.");
    if (view === "overview") {
      const report = await getEngagementCommandCenterReport(context, params);
      commandCenterReport = await hydrateCommandCenterReportFromProtectedPii(context.organizationId, report);
    } else if (view === "new-hires") newHireReport = await getNewHireReport(context);
    else if (view === "engagement") {
      const report = await getEngagementReport(context);
      engagementReport = await hydrateEngagementReportFromProtectedPii(context.organizationId, report);
    } else if (view === "campaigns") campaignReport = await getCampaignReport(context);
    else if (view === "cat-actions") catActionReport = await getCatActionReport(context);
    else membershipReport = await getMembershipReport(context);
    await recordReportAccess(context, view);
    protectedReadEnabled = isPiiProtectedReadEnabled();
  } catch {
    // Fail closed. Never substitute synthetic report values when the reporting query is unavailable.
  }

  return <ProtectedPage permission="viewReports"><div className="content">
    <PageHeader
      eyebrow="Information"
      title="Reports"
      description="Local 801 engagement command center plus detailed aggregate reports for coverage, membership, campaigns, CAT activity, and data quality."
    />
    <AlertBanner title="Native website reporting">
      These dashboards read the Local 801 reporting views directly through the authenticated server, with no external BI dependency for normal operational reporting.
    </AlertBanner>

    <SectionCard title="Reports & analysis" badge={<StatusBadge tone={protectedReadEnabled ? "info" : "ready"}>{protectedReadEnabled ? "Protected PII" : "Native website reports"}</StatusBadge>}>
      {reportNavigation(view)}
    </SectionCard>

    {view === "overview" ? (
      !commandCenterReport ? (
        <SectionCard title="Engagement command center"><UnavailableState title="Engagement command center unavailable" description="The reporting service could not establish an authorized aggregate view. No fallback metrics are shown." /></SectionCard>
      ) : <EngagementCommandCenter report={commandCenterReport} />
    ) : view === "cat-actions" ? (
      !catActionReport ? (
        <SectionCard title="CAT action reporting"><UnavailableState title="CAT action report unavailable" description="The reporting service could not establish an authorized aggregate view. No fallback metrics are shown." /></SectionCard>
      ) : <>
        <SectionCard title="CAT action overview" description="Aggregate action workload and task completion across non-archived CAT actions. Restricted strategy content is never included." badge={<StatusBadge tone="info">Aggregate only</StatusBadge>}>
          <div className="metrics-grid">
            <StatCard label="CAT actions" value={whole(catActionReport.overview.actionCount)} detail="Non-archived actions" tone="brand" />
            <StatCard label="Active actions" value={whole(catActionReport.overview.activeActionCount)} detail="Currently active" tone="brand" />
            <StatCard label="Tasks" value={whole(catActionReport.overview.taskCount)} detail={`${whole(catActionReport.overview.openTaskCount)} currently open`} />
            <StatCard label="Completed tasks" value={whole(catActionReport.overview.completedTaskCount)} detail={`${percent(catActionReport.overview.completionRate)} task completion`} />
            <StatCard label="Overdue tasks" value={whole(catActionReport.overview.overdueTaskCount)} detail="Open tasks past their due date" tone={catActionReport.overview.overdueTaskCount > 0 ? "attention" : "default"} />
            <StatCard label="Participants" value={whole(catActionReport.overview.participantCount)} detail="Distinct assignees with completed tasks" />
          </div>
        </SectionCard>
        <SectionCard title="CAT action status" badge={<StatusBadge tone="info">Non-archived</StatusBadge>}>
          {catActionReport.actionStatuses.length === 0 ? <EmptyState title="No CAT action status data" description="No aggregate CAT action status rows are available for this organization." /> : (
            <DataTable caption="CAT action status" headers={["Status", "CAT actions"]}>
              {catActionReport.actionStatuses.map((row) => <tr key={row.status}><td><strong>{statusLabel(row.status)}</strong></td><td>{whole(row.actionCount)}</td></tr>)}
            </DataTable>
          )}
        </SectionCard>
        <SectionCard title="Task status" badge={<StatusBadge tone="info">Top {Math.min(catActionReport.taskStatuses.length, 20)} shown</StatusBadge>}>
          {catActionReport.taskStatuses.length === 0 ? <EmptyState title="No CAT action task data" description="No aggregate task status rows are available for this organization." /> : (
            <DataTable caption="CAT action task status" headers={["Status", "Tasks"]}>
              {catActionReport.taskStatuses.map((row) => <tr key={row.status}><td><strong>{statusLabel(row.status)}</strong></td><td>{whole(row.taskCount)}</td></tr>)}
            </DataTable>
          )}
        </SectionCard>
        {catActionPerformanceTable(catActionReport.actions)}
      </>
    ) : view === "campaigns" ? (
      !campaignReport ? (
        <SectionCard title="Campaign reporting"><UnavailableState title="Campaign report unavailable" description="The reporting service could not establish an authorized aggregate view. No fallback metrics are shown." /></SectionCard>
      ) : <>
        <SectionCard title="Campaign overview" description="Aggregate campaign workload and engagement coverage across non-archived campaigns." badge={<StatusBadge tone="info">Aggregate only</StatusBadge>}>
          <div className="metrics-grid">
            <StatCard label="Campaigns" value={whole(campaignReport.overview.campaignCount)} detail="Non-archived campaigns" tone="brand" />
            <StatCard label="Active campaigns" value={whole(campaignReport.overview.activeCampaignCount)} detail="Currently active" tone="brand" />
            <StatCard label="Population" value={whole(campaignReport.overview.populationCount)} detail={`${percent(campaignReport.overview.assignmentRate)} assigned`} />
            <StatCard label="Contacted" value={whole(campaignReport.overview.contactedCount)} detail={`${percent(campaignReport.overview.coverageRate)} population coverage`} tone={campaignReport.overview.coverageRate < 100 ? "attention" : "default"} />
          </div>
        </SectionCard>
        <SectionCard title="Campaign status" badge={<StatusBadge tone="info">Non-archived</StatusBadge>}>
          {campaignReport.statuses.length === 0 ? <EmptyState title="No campaign status data" description="No aggregate campaign status rows are available for this organization." /> : (
            <DataTable caption="Campaign status" headers={["Status", "Campaigns"]}>
              {campaignReport.statuses.map((row) => <tr key={row.status}><td><strong>{statusLabel(row.status)}</strong></td><td>{whole(row.campaignCount)}</td></tr>)}
            </DataTable>
          )}
        </SectionCard>
        {campaignPerformanceTable(campaignReport.campaigns)}
      </>
    ) : view === "engagement" ? (
      !engagementReport ? (
        <SectionCard title="Engagement reporting"><UnavailableState title="Engagement report unavailable" description="The reporting service could not establish an authorized aggregate view. No fallback metrics are shown." /></SectionCard>
      ) : <>
        <SectionCard title="Engagement overview" description="Aggregate activity, organizer participation, and follow-up workload." badge={<StatusBadge tone="info">Aggregate only</StatusBadge>}>
          <div className="metrics-grid">
            <StatCard label="Engagement events" value={whole(engagementReport.overview.eventCount)} detail="Recorded, non-voided engagement events" tone="brand" />
            <StatCard label="Active organizers" value={whole(engagementReport.overview.activeOrganizerCount)} detail="Organizers with recorded engagement" tone="brand" />
            <StatCard label="Follow-ups" value={whole(engagementReport.overview.followupCount)} detail="Recorded follow-up items" />
            <StatCard label="Open follow-ups" value={whole(engagementReport.overview.openFollowupCount)} detail="Follow-ups currently marked open" tone={engagementReport.overview.openFollowupCount > 0 ? "attention" : "default"} />
          </div>
        </SectionCard>
        <SectionCard title="Engagement over time" description="Most recent 30 days that contain recorded engagement activity." badge={<StatusBadge tone="info">Daily activity</StatusBadge>}>{engagementTrend(engagementReport.daily)}</SectionCard>
        {engagementBreakdownTable("Contact methods", "Contact method", engagementReport.contactMethods)}
        {engagementBreakdownTable("Engagement outcomes", "Outcome", engagementReport.outcomes)}
        {engagementBreakdownTable("Engagement by department", "Department", engagementReport.departments)}
        {engagementBreakdownTable("Engagement by work location", "Work location", engagementReport.workLocations)}
        {engagementBreakdownTable("Engagement by organizer", "Organizer", engagementReport.organizers)}
        <SectionCard title="Follow-up status" badge={<StatusBadge tone="info">Top {Math.min(engagementReport.followupStatuses.length, 20)} shown</StatusBadge>}>
          {engagementReport.followupStatuses.length === 0 ? <EmptyState title="No follow-up data" description="No aggregate follow-up status rows are available for this organization." /> : <DataTable caption="Follow-up status" headers={["Status", "Follow-ups"]}>{engagementReport.followupStatuses.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{whole(row.followupCount)}</td></tr>)}</DataTable>}
        </SectionCard>
        <SectionCard title="Campaign engagement coverage" badge={<StatusBadge tone="info">Top {Math.min(engagementReport.campaignCoverage.length, 50)} shown</StatusBadge>}>
          {engagementReport.campaignCoverage.length === 0 ? <EmptyState title="No campaign coverage data" description="No aggregate campaign engagement coverage is available for this organization." /> : <DataTable caption="Campaign engagement coverage" headers={["Campaign", "Assigned", "Contacted", "Coverage"]}>{engagementReport.campaignCoverage.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{whole(row.assignedCount)}</td><td>{whole(row.contactedCount)}</td><td>{percent(row.coverageRate)}</td></tr>)}</DataTable>}
        </SectionCard>
      </>
    ) : view === "new-hires" ? (
      !newHireReport ? (
        <SectionCard title="New-hire reporting">
          <UnavailableState title="New-hire report unavailable" description="The reporting service could not establish an authorized aggregate view. No fallback metrics are shown." />
        </SectionCard>
      ) : <>
        <SectionCard title="New-hire overview" description="Current aggregate conversion and engagement status for recorded hires." badge={<StatusBadge tone="info">Aggregate only</StatusBadge>}>
          <div className="metrics-grid">
            <StatCard label="New hires" value={whole(newHireReport.overview.newHireCount)} detail="Recorded hire events" tone="brand" />
            <StatCard label="Current members" value={whole(newHireReport.overview.currentMemberCount)} detail={`${percent(newHireReport.overview.conversionRate)} conversion rate`} tone="brand" />
            <StatCard label="Engaged" value={whole(newHireReport.overview.engagedCount)} detail={`${percent(newHireReport.overview.engagementRate)} have at least one engagement`} />
            <StatCard label="Not yet engaged" value={whole(newHireReport.overview.notYetEngagedCount)} detail="No recorded engagement yet" tone={newHireReport.overview.notYetEngagedCount > 0 ? "attention" : "default"} />
          </div>
        </SectionCard>

        <SectionCard title="New hires over time" description="Most recent 12 hire months, with current-member conversion for each cohort." badge={<StatusBadge tone="info">Cohort conversion</StatusBadge>}>
          {newHireTrend(newHireReport.monthly)}
        </SectionCard>

        {newHireBreakdownTable("New hires by department", newHireReport.departments)}
        {newHireBreakdownTable("New hires by work location", newHireReport.workLocations)}
        {newHireBreakdownTable("New hires by job status", newHireReport.jobStatuses)}
      </>
    ) : !membershipReport ? (
      <SectionCard title={view === "data-quality" ? "Data quality" : "Membership reporting"}>
        <UnavailableState title="Membership report unavailable" description="The reporting service could not establish an authorized aggregate view. No fallback metrics are shown." />
      </SectionCard>
    ) : view === "data-quality" ? (
      <SectionCard title="Data quality" description="Aggregate indicators only; no names, emails, identifiers, or person-level rows are rendered." badge={<StatusBadge tone="info">Membership data</StatusBadge>}>
        <div className="metrics-grid two-grid">
          <StatCard label="Missing names" value={whole(membershipReport.dataQuality.missingNames)} detail="Records with a blank first or last name" tone={membershipReport.dataQuality.missingNames > 0 ? "attention" : "default"} />
          <StatCard label="Missing work email" value={whole(membershipReport.dataQuality.missingWorkEmail)} detail="Records without an active work-email contact" tone={membershipReport.dataQuality.missingWorkEmail > 0 ? "attention" : "default"} />
        </div>
      </SectionCard>
    ) : <>
      <SectionCard title="Membership overview" description={refreshedLabel(membershipReport.overview.refreshedAt)} badge={<StatusBadge tone="info">Aggregate only</StatusBadge>}>
        <div className="metrics-grid">
          <StatCard label="Represented" value={whole(membershipReport.overview.representedCount)} detail="Active represented records" tone="brand" />
          <StatCard label="Members" value={whole(membershipReport.overview.memberCount)} detail={`${percent(membershipReport.overview.membershipRate)} of represented`} tone="brand" />
          <StatCard label="Nonmembers" value={whole(membershipReport.overview.nonmemberCount)} detail="Current nonmember status" />
          <StatCard label="Other / unknown" value={whole(membershipReport.overview.otherCount)} detail="Included in represented denominator" tone={membershipReport.overview.otherCount > 0 ? "attention" : "default"} />
        </div>
      </SectionCard>

      <SectionCard title="Membership changes" description="Most recent 12 months that contain an addition or drop." badge={<StatusBadge tone="info">Adds vs drops</StatusBadge>}>
        {changesChart(membershipReport.monthlyChanges)}
      </SectionCard>

      {breakdownTable("Membership by department", membershipReport.departments)}
      {breakdownTable("Membership by work location", membershipReport.workLocations)}
      {breakdownTable("Membership by job status", membershipReport.jobStatuses)}
    </>}
  </div></ProtectedPage>;
}
