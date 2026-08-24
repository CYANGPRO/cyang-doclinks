import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, DisclosureCard, EmptyState, PageHeader, SectionCard, StatCard, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getMembershipBreakdowns, getMembershipSummary, unavailableMembershipSummary } from "@/lib/membership";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type MembershipGroup = "classification" | "department" | "location";

const membershipGroups: Array<{ key: MembershipGroup; label: string; header: string }> = [
  { key: "classification", label: "Classification", header: "Classification" },
  { key: "department", label: "Department", header: "Department" },
  { key: "location", label: "Section name", header: "Section name" },
];

function selectedGroup(value: string | string[] | undefined): MembershipGroup {
  const selected = Array.isArray(value) ? value[0] : value;
  return selected === "department" || selected === "location" ? selected : "classification";
}

function countLabel(value: number | "—", singular: string, plural: string) {
  if (typeof value !== "number") return `— ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

function snapshotLabel(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
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
  const group = selectedGroup(params.group);
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
  const activeGroup = membershipGroups.find((item) => item.key === group) ?? membershipGroups[0];
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

      <SectionCard className="membership-breakdown-card" title="Membership by group" description="Compare current membership across one group at a time. Results appear alphabetically by group name.">
        <nav
          aria-label="Membership breakdown views"
          style={{
            display: "flex",
            gap: 8,
            margin: "0 0 14px",
            overflowX: "auto",
            padding: "2px 2px 6px",
            scrollbarWidth: "thin",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {membershipGroups.map((item) => (
            <Link
              key={item.key}
              href={`/membership?group=${item.key}`}
              aria-current={group === item.key ? "page" : undefined}
              className={group === item.key ? "button" : "button secondary"}
              style={{ flex: "0 0 auto", minHeight: 38, padding: "8px 12px", whiteSpace: "nowrap" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {visibleBreakdowns.length === 0 ? (
          <EmptyState title={`No ${activeGroup.label.toLowerCase()} data`} description="No current membership totals are available for this group." />
        ) : (
          <DataTable caption={`Membership by ${activeGroup.label.toLowerCase()}`} headers={[activeGroup.header, "Represented", "Members", "Membership"]}>
            {visibleBreakdowns.map((row) => <tr key={`${row.dimension}-${row.label}`}>
              <td><strong>{row.label === "Unspecified" ? row.label : <Link href={drilldownHref(group, row.label)}>{row.label}</Link>}</strong></td>
              <td>{row.represented}</td>
              <td>{row.members}</td>
              <td>{row.membershipPercentage}</td>
            </tr>)}
          </DataTable>
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
