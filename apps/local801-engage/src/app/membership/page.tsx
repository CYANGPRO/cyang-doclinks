import { redirect } from "next/navigation";
import { DataTable, PageHeader, SectionCard, StatCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getMembershipBreakdowns, getMembershipSummary, unavailableMembershipSummary } from "@/lib/membership";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export default async function MembershipPage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageImports")) redirect("/unauthorized");
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
  return <ProtectedPage permission="manageImports"><div className="content">
    <PageHeader eyebrow="Members" title="Membership" description="Decision-useful current state and bounded SQL aggregates from the latest approved organization snapshot." />
    {summary.source === "unavailable" ? <SectionCard><UnavailableState title="Approved snapshot unavailable" description="Membership totals are withheld until the private database can provide an approved snapshot." /></SectionCard> : <>
      <section className="metrics-grid" aria-label="Membership summary">
        <StatCard label="Represented" value={summary.represented} detail={summary.sourceLabel} tone="brand" />
        <StatCard label="Members" value={summary.members} detail={summary.sourceLabel} />
        <StatCard label="Nonmembers" value={summary.nonmembers} detail={summary.sourceLabel} />
        <StatCard label="Membership" value={percentage} detail="Members ÷ represented" />
        <StatCard label="Net change" value={net} detail="Current month additions minus drops" tone="attention" />
      </section>
      <SectionCard title="Organization breakdowns" badge={<StatusBadge tone="info">SQL aggregates</StatusBadge>}>
        <DataTable caption="Membership breakdowns" headers={["Dimension", "Group", "Represented", "Members", "Membership"]}>
          {breakdowns.map((row) => <tr key={`${row.dimension}-${row.label}`}><td>{row.dimension === "job_status" ? "Job status" : row.dimension.charAt(0).toUpperCase() + row.dimension.slice(1)}</td><td><strong>{row.label}</strong></td><td>{row.represented}</td><td>{row.members}</td><td>{row.membershipPercentage}</td></tr>)}
        </DataTable>
      </SectionCard>
    </>}
  </div></ProtectedPage>;
}
