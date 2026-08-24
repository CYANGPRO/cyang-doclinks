import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DataTable,
  DisclosureCard,
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
import { reportValueLabel } from "@/lib/report-labels";
import { measureServerOperation } from "@/lib/performance-timing";

type ReportView = "overview" | "membership" | "new-hires" | "engagement" | "campaigns" | "cat-actions" | "data-quality";

const reportTabs = [
  { key: "overview", label: "Outreach coverage", state: "ready" },
  { key: "membership", label: "Membership", state: "ready" },
  { key: "new-hires", label: "New hires", state: "ready" },
  { key: "engagement", label: "Outreach activity", state: "ready" },
  { key: "campaigns", label: "Campaigns", state: "ready" },
  { key: "cat-actions", label: "CAT actions", state: "ready" },
  { key: "data-quality", label: "Data quality", state: "ready" },
] as const;

const reportDescriptions: Record<Exclude<ReportView, "data-quality">, string> = {
  overview: "Compare organizer assignments, recorded contact coverage, overdue follow-ups, and new-hire contact timing.",
  membership: "Review represented membership totals and changes over time.",
  "new-hires": "Review conversion and first-contact progress for recorded hires.",
  engagement: "Review recorded outreach contacts, organizer activity, contact methods, outcomes, and follow-up workload.",
  campaigns: "Compare campaign population, contact, and completion.",
  "cat-actions": "Review CAT Action task workload, deadlines, and completion.",
};

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
  return `Updated ${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(new Date(value))}`;
}

function statusLabel(value: string) {
  return reportValueLabel(value);
}

function reportNavigation(activeView: ReportView) {
  const activeTab = reportTabs.find((tab) => tab.key === activeView) ?? reportTabs[0];
  return (
    <>
      <p className="muted report-current-view">
        Viewing <strong>{activeTab.label}</strong>. Choose another report below.
      </p>
      <nav aria-label="Report views" className="report-view-nav">
        {reportTabs.map((tab) => tab.state === "ready" ? (
          <a
            key={tab.key}
            href={tab.key === "data-quality" ? "/reports/data-quality" : `/reports?view=${tab.key}`}
            aria-current={activeView === tab.key ? "page" : undefined}
            className={activeView === tab.key ? "button" : "button secondary"}
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

function directoryDrilldown(dimension: "classification" | "department" | "workLocation", label: string) {
  const params = new URLSearchParams({ scope: "authorized", limit: "100", [dimension]: label });
  return `/directory?${params}`;
}

function membershipStatusDrilldown(status?: "member" | "nonmember" | "unknown") {
  const params = new URLSearchParams({ scope: "authorized", limit: "100" });
  if (status) params.set("membershipStatus", status);
  return `/directory?${params}`;
}

function breakdownTable(title: string, dimension: "classification" | "department" | "workLocation", rows: MembershipBreakdown[], canDrilldown: boolean) {
  return (
    <SectionCard title={title} description={`Showing ${Math.min(rows.length, 50)} group${Math.min(rows.length, 50) === 1 ? "" : "s"}.`}>
      {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} data`} description="No membership totals are available for this organization." /> : (
        <DataTable caption={title} headers={[dimension === "classification" ? "Classification" : dimension === "department" ? "Department" : "Work location", "Represented", "Members", "Nonmembers", "Other / unknown", "Member rate"]}>
          {rows.map((row) => (
            <tr key={row.label}>
              <td><strong>{canDrilldown && row.label !== "Unspecified" ? <Link href={directoryDrilldown(dimension, row.label)}>{row.label}</Link> : row.label}</strong></td>
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
    return <EmptyState title="No membership changes" description="No additions or drops are available in the latest reporting period." />;
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
    return <EmptyState title="No new-hire trend data" description="No new-hire conversion data is available for this organization." />;
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
  if (rows.length === 0) return <EmptyState title="No outreach activity trend" description="No recorded conversations or outreach events are available for this organization." />;
  const max = Math.max(1, ...rows.map((row) => row.eventCount));
  return <div className="grid">{rows.map((row) => <div key={row.date} style={{ display: "grid", gap: 6 }}>
    <strong>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${row.date}T00:00:00Z`))}</strong>
    <div style={{ alignItems: "center", display: "grid", gap: 8, gridTemplateColumns: "100px minmax(120px, 1fr) auto" }}>
      <span className="muted">Contacts</span>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${(row.eventCount / max) * 100}%` }} /></div>
      <strong>{whole(row.eventCount)}</strong>
    </div>
  </div>)}</div>;
}

function engagementBreakdownTable(
  title: string,
  firstHeader: string,
  rows: EngagementBreakdown[],
  drilldown: "department" | "workLocation" | null = null,
  canDrilldown = false,
  formatLabel: (value: string) => string = (value) => value,
) {
  return <SectionCard title={title} description={`Showing ${Math.min(rows.length, 50)} group${Math.min(rows.length, 50) === 1 ? "" : "s"}.`}>
    {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} data`} description="No outreach activity totals are available for this organization." /> :
      <DataTable caption={title} headers={[firstHeader, "Recorded contacts"]}>{rows.map((row) => <tr key={row.label}>
        <td><strong>{drilldown && canDrilldown && row.label !== "Unspecified" ? <Link href={directoryDrilldown(drilldown, row.label)}>{formatLabel(row.label)}</Link> : formatLabel(row.label)}</strong></td><td>{whole(row.eventCount)}</td>
      </tr>)}</DataTable>}
  </SectionCard>;
}

function newHireBreakdownTable(title: string, rows: NewHireBreakdown[]) {
  const dimensionLabel = title.endsWith("job status") ? "Job status" : title.endsWith("department") ? "Department" : "Work location";
  return (
    <SectionCard title={title} description={`Showing ${Math.min(rows.length, 50)} group${Math.min(rows.length, 50) === 1 ? "" : "s"}.`}>
      {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} data`} description="No new-hire totals are available for this organization." /> : (
        <DataTable caption={title} headers={[title === "New hires by department" ? "Department" : "Work location", "New hires"]}>
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
    <SectionCard title="Campaign population and completion" description={`Population, assignment, contact, and completion for ${Math.min(rows.length, 50)} campaign${Math.min(rows.length, 50) === 1 ? "" : "s"}.`}>
      {rows.length === 0 ? <EmptyState title="No campaign performance data" description="No active or closed campaign totals are available for this organization." /> : (
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
    <SectionCard title="CAT Action workload and completion" description={`Task counts, overdue work, completion, and participation for ${Math.min(rows.length, 50)} CAT Action${Math.min(rows.length, 50) === 1 ? "" : "s"}.`}>
      {rows.length === 0 ? <EmptyState title="No CAT Action performance data" description="No CAT Action totals are available for this organization." /> : (
        <DataTable caption="CAT Action performance" headers={["CAT Action", "Status", "Tasks", "Open", "Completed", "Overdue", "Participants", "Completion"]}>
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
  if (view === "data-quality") redirect("/reports/data-quality");
  const emptyReports = () => ({
    commandCenterReport: null as Awaited<ReturnType<typeof getEngagementCommandCenterReport>> | null,
    membershipReport: null as Awaited<ReturnType<typeof getMembershipReport>> | null,
    newHireReport: null as Awaited<ReturnType<typeof getNewHireReport>> | null,
    engagementReport: null as Awaited<ReturnType<typeof getEngagementReport>> | null,
    campaignReport: null as Awaited<ReturnType<typeof getCampaignReport>> | null,
    catActionReport: null as Awaited<ReturnType<typeof getCatActionReport>> | null,
    protectedReadEnabled: false,
  });
  let loadedReports = emptyReports();

  try {
    loadedReports = await measureServerOperation(`page.reports.${view}`, async () => {
      const loaded = emptyReports();
      const context = await resolveWorkspaceContext(user);
      const limit = await enforceAuthenticatedRateLimit({ organizationId: context.organizationId, userId: context.userId, policy: "download_export" });
      if (!limit.ok) throw new Error("Report rate limit denied.");
      if (view === "overview") {
        const report = await getEngagementCommandCenterReport(context, params);
        loaded.commandCenterReport = await hydrateCommandCenterReportFromProtectedPii(context.organizationId, report);
      } else if (view === "new-hires") loaded.newHireReport = await getNewHireReport(context);
      else if (view === "engagement") {
        const report = await getEngagementReport(context);
        loaded.engagementReport = await hydrateEngagementReportFromProtectedPii(context.organizationId, report);
      } else if (view === "campaigns") loaded.campaignReport = await getCampaignReport(context);
      else if (view === "cat-actions") loaded.catActionReport = await getCatActionReport(context);
      else loaded.membershipReport = await getMembershipReport(context);
      await recordReportAccess(context, view);
      loaded.protectedReadEnabled = isPiiProtectedReadEnabled();
      return loaded;
    });
  } catch {
    // Fail closed. Never substitute placeholder report values when the reporting query is unavailable.
  }
  const {
    commandCenterReport,
    membershipReport,
    newHireReport,
    engagementReport,
    campaignReport,
    catActionReport,
    protectedReadEnabled,
  } = loadedReports;

  const activeReport = reportTabs.find((tab) => tab.key === view) ?? reportTabs[0];
  const canDrilldown = can(user.role, "viewDirectory");

  return <ProtectedPage permission="viewReports"><div className="content route-reports-page reports-workspace-page">
    <PageHeader
      eyebrow="Reports"
      title={`${activeReport.label} report`}
      description={reportDescriptions[view as Exclude<ReportView, "data-quality">]}
    />

    <SectionCard title="Choose a report" description="Select the Local 801 totals and trends you need." className="report-selector-panel" badge={protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}>
      {reportNavigation(view)}
    </SectionCard>

    {view === "overview" ? (
      !commandCenterReport ? (
        <SectionCard title="Outreach coverage and workload"><UnavailableState title="Outreach coverage unavailable" description="We couldn’t load assignment, contact, follow-up, and new-hire timing totals for your current access. No substitute numbers are shown." /></SectionCard>
      ) : <EngagementCommandCenter report={commandCenterReport} />
    ) : view === "cat-actions" ? (
      !catActionReport ? (
        <SectionCard title="CAT Action reporting"><UnavailableState title="CAT Action report unavailable" description="We couldn’t load the CAT Action summary for your current access." /></SectionCard>
      ) : <>
        <SectionCard title="CAT Action totals" description="Counts of non-archived CAT Actions, tasks, completion, overdue work, and participants. Restricted strategy content is never included.">
          <div className="metrics-grid">
            <StatCard label="CAT actions" value={whole(catActionReport.overview.actionCount)} detail="Non-archived actions" tone="brand" />
            <StatCard label="Active actions" value={whole(catActionReport.overview.activeActionCount)} detail="Currently active" tone="brand" />
            <StatCard label="Tasks" value={whole(catActionReport.overview.taskCount)} detail={`${whole(catActionReport.overview.openTaskCount)} currently open`} />
            <StatCard label="Completed tasks" value={whole(catActionReport.overview.completedTaskCount)} detail={`${percent(catActionReport.overview.completionRate)} task completion`} />
            <StatCard label="Overdue tasks" value={whole(catActionReport.overview.overdueTaskCount)} detail="Open tasks past their due date" tone={catActionReport.overview.overdueTaskCount > 0 ? "attention" : "default"} />
            <StatCard label="Participants" value={whole(catActionReport.overview.participantCount)} detail="Distinct assignees with completed tasks" />
          </div>
        </SectionCard>
        <SectionCard title="CAT Actions by status" description="Non-archived CAT Actions grouped by their current workflow status.">
          {catActionReport.actionStatuses.length === 0 ? <EmptyState title="No CAT Action status data" description="No CAT Action status totals are available for this organization." /> : (
            <DataTable caption="CAT action status" headers={["Status", "CAT actions"]}>
              {catActionReport.actionStatuses.map((row) => <tr key={row.status}><td><strong>{statusLabel(row.status)}</strong></td><td>{whole(row.actionCount)}</td></tr>)}
            </DataTable>
          )}
        </SectionCard>
        <SectionCard title="Tasks by status" description={`Showing ${Math.min(catActionReport.taskStatuses.length, 20)} task status group${Math.min(catActionReport.taskStatuses.length, 20) === 1 ? "" : "s"}.`}>
          {catActionReport.taskStatuses.length === 0 ? <EmptyState title="No CAT Action task data" description="No task status totals are available for this organization." /> : (
            <DataTable caption="CAT action task status" headers={["Status", "Tasks"]}>
              {catActionReport.taskStatuses.map((row) => <tr key={row.status}><td><strong>{statusLabel(row.status)}</strong></td><td>{whole(row.taskCount)}</td></tr>)}
            </DataTable>
          )}
        </SectionCard>
        {catActionPerformanceTable(catActionReport.actions)}
      </>
    ) : view === "campaigns" ? (
      !campaignReport ? (
        <SectionCard title="Campaign reporting"><UnavailableState title="Campaign report unavailable" description="We couldn’t load the campaign summary for your current access." /></SectionCard>
      ) : <>
        <SectionCard title="Campaign totals" description="Counts of non-archived campaigns, participants, organizer assignments, recorded contacts, and completed work.">
          <div className="metrics-grid">
            <StatCard label="Campaigns" value={whole(campaignReport.overview.campaignCount)} detail="Non-archived campaigns" tone="brand" />
            <StatCard label="Active campaigns" value={whole(campaignReport.overview.activeCampaignCount)} detail="Currently active" tone="brand" />
            <StatCard label="Population" value={whole(campaignReport.overview.populationCount)} detail={`${percent(campaignReport.overview.assignmentRate)} assigned`} />
            <StatCard label="Contacted" value={whole(campaignReport.overview.contactedCount)} detail={`${percent(campaignReport.overview.coverageRate)} population coverage`} tone={campaignReport.overview.coverageRate < 100 ? "attention" : "default"} />
          </div>
        </SectionCard>
        <SectionCard title="Campaigns by status" description="Non-archived campaigns grouped by their current workflow status.">
          {campaignReport.statuses.length === 0 ? <EmptyState title="No campaign status data" description="No campaign status totals are available for this organization." /> : (
            <DataTable caption="Campaign status" headers={["Status", "Campaigns"]}>
              {campaignReport.statuses.map((row) => <tr key={row.status}><td><strong>{statusLabel(row.status)}</strong></td><td>{whole(row.campaignCount)}</td></tr>)}
            </DataTable>
          )}
        </SectionCard>
        {campaignPerformanceTable(campaignReport.campaigns)}
      </>
    ) : view === "engagement" ? (
      !engagementReport ? (
        <SectionCard title="Outreach activity"><UnavailableState title="Outreach activity report unavailable" description="We couldn’t load recorded contacts, organizer activity, and follow-up totals for your current access." /></SectionCard>
      ) : <>
        <SectionCard title="Recorded outreach totals" description="Counts of recorded contacts, organizers with activity, and open or completed follow-ups.">
          <div className="metrics-grid">
            <StatCard label="Recorded contacts" value={whole(engagementReport.overview.eventCount)} detail="Non-voided conversation and contact records" tone="brand" />
            <StatCard label="Active organizers" value={whole(engagementReport.overview.activeOrganizerCount)} detail="Organizers with recorded activity" tone="brand" />
            <StatCard label="Follow-ups" value={whole(engagementReport.overview.followupCount)} detail="Recorded follow-up items" />
            <StatCard label="Open follow-ups" value={whole(engagementReport.overview.openFollowupCount)} detail="Follow-ups currently open" tone={engagementReport.overview.openFollowupCount > 0 ? "attention" : "default"} />
          </div>
        </SectionCard>
        <SectionCard title="Recorded contacts by day" description="Daily recorded outreach activity for the most recent 30 days with data.">{engagementTrend(engagementReport.daily)}</SectionCard>
        {engagementBreakdownTable("Contact methods", "Contact method", engagementReport.contactMethods, null, false, reportValueLabel)}
        {engagementBreakdownTable("Contact outcomes", "Outcome", engagementReport.outcomes, null, false, reportValueLabel)}
        {engagementBreakdownTable("Activity by department", "Department", engagementReport.departments, "department", canDrilldown)}
        {engagementBreakdownTable("Activity by work location", "Work location", engagementReport.workLocations, "workLocation", canDrilldown)}
        {engagementBreakdownTable("Activity by organizer", "Organizer", engagementReport.organizers)}
        <SectionCard title="Follow-ups by status" description={`Showing ${Math.min(engagementReport.followupStatuses.length, 20)} follow-up status group${Math.min(engagementReport.followupStatuses.length, 20) === 1 ? "" : "s"}.`}>
          {engagementReport.followupStatuses.length === 0 ? <EmptyState title="No follow-up data" description="No follow-up status totals are available for this organization." /> : <DataTable caption="Follow-up status" headers={["Status", "Follow-ups"]}>{engagementReport.followupStatuses.map((row) => <tr key={row.label}><td><strong>{statusLabel(row.label)}</strong></td><td>{whole(row.followupCount)}</td></tr>)}</DataTable>}
        </SectionCard>
        <SectionCard title="Campaign contact coverage" description={`Assigned and contacted counts for ${Math.min(engagementReport.campaignCoverage.length, 50)} campaign${Math.min(engagementReport.campaignCoverage.length, 50) === 1 ? "" : "s"}.`}>
          {engagementReport.campaignCoverage.length === 0 ? <EmptyState title="No campaign coverage data" description="No campaign contact coverage is available for this organization." /> : <DataTable caption="Campaign engagement coverage" headers={["Campaign", "Assigned", "Contacted", "Coverage"]}>{engagementReport.campaignCoverage.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{whole(row.assignedCount)}</td><td>{whole(row.contactedCount)}</td><td>{percent(row.coverageRate)}</td></tr>)}</DataTable>}
        </SectionCard>
      </>
    ) : view === "new-hires" ? (
      !newHireReport ? (
        <SectionCard title="New-hire reporting">
          <UnavailableState title="New-hire report unavailable" description="We couldn’t load the new-hire summary for your current access." />
        </SectionCard>
      ) : <>
        <SectionCard title="New-hire membership and contact totals" description="Counts of recorded hires, current members, people contacted, and people with no recorded contact.">
          <div className="metrics-grid">
            <StatCard label="New hires" value={whole(newHireReport.overview.newHireCount)} detail="Recorded hire events" tone="brand" />
            <StatCard label="Current members" value={whole(newHireReport.overview.currentMemberCount)} detail={`${percent(newHireReport.overview.conversionRate)} conversion rate`} tone="brand" />
            <StatCard label="Contacted" value={whole(newHireReport.overview.engagedCount)} detail={`${percent(newHireReport.overview.engagementRate)} have at least one recorded contact`} />
            <StatCard label="Not yet contacted" value={whole(newHireReport.overview.notYetEngagedCount)} detail="No recorded contact yet" tone={newHireReport.overview.notYetEngagedCount > 0 ? "attention" : "default"} />
          </div>
        </SectionCard>

        <SectionCard title="New hires by hire month" description="The latest 12 hire months, with the current-member count and conversion rate for each month.">
          {newHireTrend(newHireReport.monthly)}
        </SectionCard>

        {newHireBreakdownTable("New hires by department", newHireReport.departments)}
        {newHireBreakdownTable("New hires by work location", newHireReport.workLocations)}
        {newHireBreakdownTable("New hires by job status", newHireReport.jobStatuses)}
      </>
    ) : !membershipReport ? (
      <SectionCard title="Membership reporting">
        <UnavailableState title="Membership report unavailable" description="We couldn’t load the membership summary for your current access." />
      </SectionCard>
    ) : <>
      <SectionCard title="Current membership totals" description={refreshedLabel(membershipReport.overview.refreshedAt)}>
        <div className="metrics-grid">
          <StatCard label="Represented" value={whole(membershipReport.overview.representedCount)} detail="Active represented records" tone="brand" href={canDrilldown ? membershipStatusDrilldown() : undefined} />
          <StatCard label="Members" value={whole(membershipReport.overview.memberCount)} detail={`${percent(membershipReport.overview.membershipRate)} of represented`} tone="brand" href={canDrilldown ? membershipStatusDrilldown("member") : undefined} />
          <StatCard label="Nonmembers" value={whole(membershipReport.overview.nonmemberCount)} detail="Current nonmember status" href={canDrilldown ? membershipStatusDrilldown("nonmember") : undefined} />
          <StatCard label="Other / unknown" value={whole(membershipReport.overview.otherCount)} detail="Included in represented denominator" tone={membershipReport.overview.otherCount > 0 ? "attention" : "default"} href={canDrilldown ? membershipStatusDrilldown("unknown") : undefined} />
        </div>
      </SectionCard>

      <SectionCard title="Membership additions and drops" description="Monthly additions, drops, and net change for the latest 12 months with recorded activity.">
        {changesChart(membershipReport.monthlyChanges)}
      </SectionCard>

      {breakdownTable("Membership by classification", "classification", membershipReport.classifications, canDrilldown)}
      {breakdownTable("Membership by department", "department", membershipReport.departments, canDrilldown)}
      {breakdownTable("Membership by work location", "workLocation", membershipReport.workLocations, canDrilldown)}
    </>}
    <DisclosureCard title="About these reports" description="Day-to-day summaries live inside Engaging Local 801." className="route-secondary-panel reports-reference-panel">
      <p className="page-copy">Reports use only the information authorized for your current role. Open the linked work queue when you need person-level details and your role permits it.</p>
    </DisclosureCard>
  </div></ProtectedPage>;
}
