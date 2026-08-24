import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertBanner, PageHeader, SectionCard, StatCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { can, dashboardForRole } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getDashboardMetrics } from "@/lib/metrics";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export default async function HomePage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  const context = await resolveWorkspaceContext(user);
  const metrics = await getDashboardMetrics(context);
  const source = `${metrics.reportingDate} · ${metrics.sourceSnapshot}`;
  const dashboard = dashboardForRole(user.role);
  const membershipRole = dashboard.membership;
  const organizingRole = dashboard.organizing;

  return (
    <div className="content">
      <PageHeader
        eyebrow="Operational overview"
        title={membershipRole ? "Membership and data operations" : organizingRole ? "Your organizing workspace" : "Reports workspace"}
        description="A role-aware summary of current authorized work. Every metric is aggregated server-side and organization scoped."
        actions={membershipRole ? <Link className="button" href="/imports">Review imports</Link> : organizingRole ? <Link className="button" href="/outreach">Open my outreach</Link> : <Link className="button" href="/reports">Open reports</Link>}
      />
      {user.authentication === "production"
        ? <AlertBanner title="Production workspace">Values below come from the protected Local 801 production database and are limited to the signed-in user&apos;s authorized role.</AlertBanner>
        : <AlertBanner title="Synthetic Preview" tone="preview">No real member data. Values below come from the isolated Preview database when available.</AlertBanner>}

      {metrics.source === "unavailable" ? (
        <SectionCard><UnavailableState title="Operational metrics unavailable" description="The protected Local 801 database could not provide aggregate metrics. No static values are substituted." /></SectionCard>
      ) : (
        <section className="metrics-grid" aria-label="Authorized dashboard metrics">
          {membershipRole ? <>
            <StatCard label="Represented" value={metrics.represented} detail={source} tone="brand" />
            <StatCard label="Members" value={metrics.members} detail={source} />
            <StatCard label="Membership" value={metrics.membershipPercentage} detail={source} />
            <StatCard label="Imports in review" value={metrics.importsInReview} detail="Requires data-team review" tone="attention" />
            <StatCard label="New hires this month" value={metrics.newHiresThisMonth} detail={source} />
            <StatCard label="Additions this month" value={metrics.additionsThisMonth} detail={source} />
            <StatCard label="Drops this month" value={metrics.dropsThisMonth} detail={source} />
          </> : null}
          {organizingRole ? <>
            <StatCard label="Open assignments" value={metrics.openAssignments} detail="Authorized organization aggregate" tone="brand" />
            <StatCard label="Overdue follow-ups" value={metrics.overdueFollowups} detail="Action required" tone="attention" />
            {dashboard.campaigns ? <StatCard label="Active campaigns" value={metrics.activeCampaigns} detail={source} /> : null}
            {dashboard.catActions ? <StatCard label="Active CAT actions" value={metrics.openCatActions} detail={source} /> : null}
          </> : null}
        </section>
      )}

      <SectionCard title="Authorized work areas" badge={<StatusBadge tone="info">Role scoped</StatusBadge>}>
        <div className="review-summary">
          {membershipRole ? <Link className="button secondary" href="/membership">Membership summary</Link> : null}
          {can(user.role, "viewDirectory") ? <Link className="button secondary" href="/directory">Directory search</Link> : null}
          {organizingRole ? <Link className="button secondary" href="/follow-ups">Follow-up queue</Link> : null}
          {can(user.role, "viewReports") ? <Link className="button secondary" href="/reports">Report catalog</Link> : null}
        </div>
      </SectionCard>
    </div>
  );
}
