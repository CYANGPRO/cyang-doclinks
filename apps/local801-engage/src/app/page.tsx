import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertBanner, EmptyState, PageHeader, SectionCard, StatCard, UnavailableState } from "@/components/DesignSystem";
import { dashboardForRole } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getDashboardMetrics } from "@/lib/metrics";
import { measureServerOperation } from "@/lib/performance-timing";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function metricNumber(value: number | string) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type AttentionItem = {
  key: string;
  priority: number;
  title: string;
  detail: string;
  href: string;
  action: string;
};

export default async function HomePage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  const metrics = await measureServerOperation("page.home.data", async () => {
    const context = await resolveWorkspaceContext(user);
    return getDashboardMetrics(context);
  });
  const dashboard = dashboardForRole(user.role);
  const membershipRole = dashboard.membership;
  const organizingRole = dashboard.organizing;
  const organizationWideOrganizing = ["system_owner", "local_admin", "cat_admin"].includes(user.role);
  const outreachScope = organizationWideOrganizing ? "authorized" : "assigned";
  const followupScope = organizationWideOrganizing ? "authorized" : "mine";
  const member360ActionLabel = organizationWideOrganizing ? "Open member outreach" : "Open my outreach list";

  const importsInReview = metricNumber(metrics.importsInReview);
  const overdueFollowups = metricNumber(metrics.overdueFollowups);
  const followupsDueToday = metricNumber(metrics.followupsDueToday);
  const followupsDue = overdueFollowups + followupsDueToday;
  const assignedAttention90 = metricNumber(metrics.assignedAttention90);
  const newHiresAwaitingFirstEngagement14 = metricNumber(metrics.newHiresAwaitingFirstEngagement14);

  const attentionItems: AttentionItem[] = [];
  if (organizingRole && overdueFollowups > 0) {
    attentionItems.push({
      key: "overdue-followups",
      priority: 1,
      title: `${overdueFollowups} overdue follow-up${overdueFollowups === 1 ? "" : "s"}`,
      detail: "These follow-ups are already past due.",
      href: `/follow-ups?scope=${followupScope}&focus=overdue`,
      action: "Open overdue follow-ups",
    });
  }
  if (membershipRole && importsInReview > 0) {
    attentionItems.push({
      key: "imports",
      priority: 2,
      title: `${importsInReview} import${importsInReview === 1 ? "" : "s"} ready for review`,
      detail: "Validated changes are waiting for Membership Data review.",
      href: "/imports",
      action: "Review imports",
    });
  }
  if (organizingRole && followupsDueToday > 0) {
    attentionItems.push({
      key: "today-followups",
      priority: 3,
      title: `${followupsDueToday} follow-up${followupsDueToday === 1 ? "" : "s"} due today`,
      detail: "These are due before the end of today.",
      href: `/follow-ups?scope=${followupScope}&focus=today`,
      action: "Open today’s follow-ups",
    });
  }
  if (membershipRole && newHiresAwaitingFirstEngagement14 > 0) {
    attentionItems.push({
      key: "new-hires",
      priority: 4,
      title: `${newHiresAwaitingFirstEngagement14} new hire${newHiresAwaitingFirstEngagement14 === 1 ? "" : "s"} still need a first conversation`,
      detail: "They are at least 14 days past hire with no recorded contact.",
      href: "/new-hires",
      action: "Open new hires",
    });
  }
  if (organizingRole && assignedAttention90 > 0) {
    attentionItems.push({
      key: "contact-gap",
      priority: 5,
      title: `${assignedAttention90} ${assignedAttention90 === 1 ? "person hasn’t" : "people haven’t"} had a recorded contact in 90 days`,
      detail: "Open member outreach to see who may need a conversation.",
      href: `/outreach?scope=${outreachScope}&focus=attention`,
      action: member360ActionLabel,
    });
  }
  attentionItems.sort((a, b) => a.priority - b.priority);
  const hasAttention = attentionItems.length > 0;

  const title = membershipRole && organizingRole
    ? "Today’s work"
    : membershipRole
      ? "Membership at a glance"
      : organizingRole
      ? "Your organizing work"
        : "Reporting workspace";

  const followupHref = overdueFollowups > 0
    ? `/follow-ups?scope=${followupScope}&focus=overdue`
    : followupsDueToday > 0
      ? `/follow-ups?scope=${followupScope}&focus=today`
      : `/follow-ups?scope=${followupScope}`;

  return (
    <div className="content">
      <PageHeader
        eyebrow="Engaging Local 801"
        title={title}
        description={membershipRole || organizingRole ? "Start with overdue follow-ups, pending reviews, and assigned conversations, then check the current Local 801 totals below." : "Open web reports for the Local 801 totals and trends available to your role."}
        actions={organizingRole
          ? <Link className="button" href={`/outreach?scope=${outreachScope}&focus=attention`}>{member360ActionLabel}</Link>
          : membershipRole
            ? <Link className="button" href="/imports">Review imports</Link>
            : <Link className="button" href="/reports">Open reports</Link>}
      />
      {user.authentication === "preview"
        ? <AlertBanner title="Preview environment" tone="preview">Values below come from the isolated Preview environment when available.</AlertBanner>
        : null}

      {metrics.source === "unavailable" ? (
        <SectionCard><UnavailableState title="Workspace totals unavailable" description="CAT couldn’t load the current Local 801 totals, so it is not showing old or estimated numbers." /></SectionCard>
      ) : (
        <>
          {(membershipRole || organizingRole) ? <div className="dashboard-layout">
            <SectionCard
              className="priority-panel"
              title="Work requiring attention"
              description={hasAttention ? `${attentionItems.length} ${attentionItems.length === 1 ? "overdue follow-up or pending review appears" : "overdue follow-ups and pending reviews appear"} below in urgency order.` : "No overdue follow-ups or pending reviews currently require attention."}
            >
              {!hasAttention ? <EmptyState title="Nothing urgent right now" description="Your routine lists, follow-ups, and reports are still available from the navigation." /> : <div className="priority-list">
                {attentionItems.map((item, index) => <Link className="priority-row" href={item.href} key={item.key}>
                  <span className="priority-index" aria-hidden="true">{index + 1}</span>
                  <span className="priority-copy"><strong>{item.title}</strong><span>{item.detail}</span></span>
                  <span className="priority-action">{item.action}<span aria-hidden="true">→</span></span>
                </Link>)}
              </div>}
            </SectionCard>
            <SectionCard className="snapshot-panel" title="Current Local 801 totals" description="Live membership and organizing counts available to your role.">
              <div className="metrics-grid dashboard-metrics">
              {membershipRole ? <>
                <StatCard
                  label="Membership"
                  value={`${metrics.members} / ${metrics.represented}`}
                  detail={`${metrics.membershipPercentage} are members`}
                  tone="brand"
                  href="/membership"
                />
                <StatCard
                  label="Imports in review"
                  value={metrics.importsInReview}
                  detail="Ready for Membership Data review"
                  tone={importsInReview > 0 ? "attention" : "default"}
                  href="/imports"
                />
                <StatCard
                  label="New hires this month"
                  value={metrics.newHiresThisMonth}
                  detail={`${newHiresAwaitingFirstEngagement14} still need a first conversation`}
                  href="/new-hires"
                />
              </> : null}
              {organizingRole ? <>
                <StatCard
                  label="Open assignments"
                  value={metrics.openAssignments}
                  tone="brand"
                  href={`/outreach?scope=${outreachScope}&focus=all`}
                />
                <StatCard
                  label="Follow-ups due"
                  value={followupsDue}
                  detail={`${overdueFollowups} overdue · ${followupsDueToday} today`}
                  tone={followupsDue > 0 ? "attention" : "default"}
                  href={followupHref}
                />
                <StatCard
                  label="No contact in 90 days"
                  value={metrics.assignedAttention90}
                  detail="People who may need a conversation"
                  tone={assignedAttention90 > 0 ? "attention" : "default"}
                  href={`/outreach?scope=${outreachScope}&focus=attention`}
                />
              </> : null}
            </div>
            </SectionCard>
          </div> : <SectionCard className="report-start" title="Choose a report" description="Open the reporting workspace to compare current membership, engagement, campaign, and data-quality trends."><div className="page-actions"><Link className="button" href="/reports">Browse reports</Link></div></SectionCard>}
        </>
      )}
    </div>
  );
}
