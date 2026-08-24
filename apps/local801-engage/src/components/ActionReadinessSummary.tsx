import { DataTable, EmptyState, SectionCard, StatCard, UnavailableState } from "@/components/DesignSystem";
import type { ScopedActionReadinessSummary as ReadinessSummary } from "@/lib/action-readiness-summary";

export function ActionReadinessSummary({
  summary,
  unavailable = false,
  subject,
}: {
  summary: ReadinessSummary | null;
  unavailable?: boolean;
  subject: "campaign" | "CAT action";
}) {
  return <SectionCard
    title="Action readiness"
    description={`See how people currently responded to the actions connected to this ${subject}. These are recorded responses—not campaign completion and not a hidden member score.`}
  >
    {unavailable || !summary ? <UnavailableState title="Action readiness unavailable" description="We couldn’t load this summary safely. No person-level details are shown in its place." />
      : summary.actionCount === 0 ? <EmptyState title="No actions connected yet" description={`There are no Action Readiness items connected to this ${subject} right now.`} />
      : <>
        <section className="metrics-grid" aria-label={`${subject} action readiness summary`}>
          <StatCard label="Actions" value={summary.actionCount} detail={`Connected to this ${subject}`} tone="brand" />
          <StatCard label="Willing" value={summary.willing} detail="Current responses" />
          <StatCard label="Considering" value={summary.considering} detail="Current responses" />
          <StatCard label="Completed" value={summary.completed} detail="Current responses" />
          <StatCard label="Declined" value={summary.declined} detail="Current responses" />
        </section>
        <DataTable caption={`${subject} action readiness`} headers={["Action", "Engagement level", "Willing", "Considering", "Completed", "Declined"]}>
          {summary.actions.map((action) => <tr key={`${action.engagementLevel}:${action.label}`}>
            <td><strong>{action.label}</strong></td>
            <td>{action.engagementLevel}</td>
            <td>{action.willing}</td>
            <td>{action.considering}</td>
            <td>{action.completed}</td>
            <td>{action.declined}</td>
          </tr>)}
        </DataTable>
      </>}
  </SectionCard>;
}
