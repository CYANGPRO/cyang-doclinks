import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, DisclosureCard, EmptyState, PageHeader, SectionCard, StatCard, UnavailableState } from "@/components/DesignSystem";
import { MembershipGroupTabs } from "@/components/MembershipGroupTabs";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDate } from "@/lib/date-format";
import { getMembershipBreakdowns, getMembershipSummary, unavailableMembershipSummary } from "@/lib/membership";
import { isMembershipGroup, membershipGroupFromSearch, MEMBERSHIP_GROUPS, type MembershipGroup } from "@/lib/membership-group-preference";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function countLabel(value: number | "—", singular: string, plural: string) {
  if (typeof value !== "number") return `— ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

function snapshotLabel(value: string | null) {
  return formatCatDate(value);
}

function drilldownHref(group: MembershipGroup, label: string) {
  const params = new URLSearchParams({ scope: "authorized", limit: "100" });
  if (group === "classification") params.set("classification", label);
  else if (group === "department") params.set("department", label);
  else params.set("workLocation", label);
  return `/directory?${params}`;
}

export default async function MembershipPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageImports")) redirect("/unauthorized");

  const params = await searchParams;
  const requestedGroup = Array.isArray(params.group) ? params.group[0] : params.group;
  const hasExplicitGroup = isMembershipGroup(requestedGroup);
  const group = membershipGroupFromSearch(params.group);
  let summary = unavailableMembershipSummary();
  let breakdowns: Awaited<ReturnType<typeof getMembershipBreakdowns>> = [];
  try {
    const context = await resolveWorkspaceContext(user);
    [summary, breakdowns] = await Promise.all([getMembershipSummary(context), getMembershipBreakdowns(context)]);
  } catch { /* Safe unavailable state below. */ }

  const represented = typeof summary.represented === "number" ? summary.represented : 0;
  const members = typeof summary.members === "number" ? summary.members : 0;
  const percentage = summary.source === "database" && represented ? `${((members / represented) * 100).toFixed(1)}%` : "—";
  const net = typeof summary.netChange === "number" && summary.netChange > 0 ? `+${summary.netChange}` : summary.netChange;
  const canViewReports = can(user.role, "viewReports");
  const activeGroup = MEMBERSHIP_GROUPS.find((item) => item.key === group) ?? MEMBERSHIP_GROUPS[0];
  const visibleBreakdowns = breakdowns
    .filter((row) => row.dimension === group)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

  return <ProtectedPage permission="manageImports"><div className="content membership-page">
    <PageHeader eyebrow="Members" title="Membership" description="Current membership totals, recent additions and drops, and breakdowns across Local 801." />
    {summary.source === "unavailable" ? <SectionCard><UnavailableState title="Membership totals unavailable" description="We couldn’t load the latest approved membership snapshot, so no totals are shown." /></SectionCard> : <>
      <section className="metrics-grid" aria-label="Membership snapshot">
        <StatCard
          label="Membership"
          value={`${summary.members} of ${summary.represented}`}
          detail={`${percentage} · ${countLabel(summary.nonmembers, "nonmember", "nonmembers")}`}
          tone="brand"
        />
        <StatCard
          label="Changes this month"
          value={net}
          detail={`${countLabel(summary.additionsThisMonth, "addition", "additions")} · ${countLabel(summary.dropsThisMonth, "drop", "drops")}`}
          tone="attention"
        />
        <StatCard label="Approved snapshot" value={snapshotLabel(summary.snapshotDate)} detail={countLabel(summary.represented, "represented person", "represented people")} />
      </section>

      <SectionCard className="membership-breakdown-card" title="Membership by group" description="Compare current membership across one group at a time. The Office view includes every office in the latest approved snapshot.">
        <MembershipGroupTabs selectedGroup={group} hasExplicitSelection={hasExplicitGroup} />

        {visibleBreakdowns.length === 0 ? (
          <EmptyState title={`No ${activeGroup.label.toLowerCase()} data`} description="No current membership totals are available for this group." />
        ) : (
          <div className="membership-breakdown-scroll" tabIndex={0} role="region" aria-label={`Scrollable membership by ${activeGroup.label.toLowerCase()}`}>
            <DataTable caption={`Membership by ${activeGroup.label.toLowerCase()}`} headers={[activeGroup.header, "Represented", "Members", "Membership"]}>
              {visibleBreakdowns.map((row) => <tr key={`${row.dimension}-${row.label}`}>
                <td><strong>{row.label === "Unspecified" ? row.label : <Link href={drilldownHref(group, row.label)}>{row.label}</Link>}</strong></td>
                <td>{row.represented}</td>
                <td>{row.members}</td>
                <td>{row.membershipPercentage}</td>
              </tr>)}
            </DataTable>
          </div>
        )}
      </SectionCard>

      <DisclosureCard className="membership-related-work" title="Related membership work" description="Open imports, reports, new-hire work, or records that need review.">
        <nav className="page-actions membership-related-actions" aria-label="Related membership work">
          <Link className="button secondary" href="/imports">Review imports</Link>
          {canViewReports ? <Link className="button secondary" href="/reports?view=membership">Membership report</Link> : null}
          <Link className="button secondary" href="/new-hires">New hires</Link>
          <Link className="button" href="/membership/data-quality">Review data issues</Link>
        </nav>
      </DisclosureCard>
    </>}
  </div></ProtectedPage>;
}
