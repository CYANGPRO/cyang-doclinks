import { notFound, redirect } from "next/navigation";
import { MemberEmailBroadcastActions, MemberEmailBroadcastComposer } from "@/components/MemberEmailBroadcastControls";
import { DataTable, EmptyState, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { listMemberEmailBroadcasts } from "@/lib/member-email-broadcasts";
import { memberEmailPreviewEnabled } from "@/lib/member-email-preview-policy";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

export default async function EmailBroadcastsPage() {
  if (!memberEmailPreviewEnabled()) notFound();
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "sendMemberEmail")) redirect("/unauthorized");
  let broadcasts: Awaited<ReturnType<typeof listMemberEmailBroadcasts>> | null = null;
  try {
    broadcasts = await listMemberEmailBroadcasts(await resolveWorkspaceContext(user));
  } catch {
    // Fail closed rather than display a partial protected recipient workflow.
  }

  return <ProtectedPage permission="sendMemberEmail"><div className="content route-email-broadcasts-page queue-first-page">
    <PageHeader
      eyebrow="Programs · Preview only"
      title="Email broadcasts"
      description="Build and approve an all-member communication against a frozen synthetic membership snapshot. Delivery is simulated and cannot reach a provider."
    />
    <SectionCard title="Create Preview broadcast" description="Check the latest approved snapshot, then encrypt the draft and freeze its synthetic recipient population." badge={<StatusBadge tone="pending">Provider disabled</StatusBadge>}>
      <MemberEmailBroadcastComposer />
    </SectionCard>
    <SectionCard title="Preview workflow" description="The creator submits the draft; a different authorized administrator approves it; delivery remains simulated." badge={<StatusBadge tone="info">Two-person approval</StatusBadge>}>
      {!broadcasts ? <UnavailableState title="Broadcast workflow unavailable" description="CAT could not establish the protected Preview broadcast state, so no incomplete results are shown." />
        : broadcasts.length === 0 ? <EmptyState title="No Preview broadcasts" description="Create the first synthetic draft after checking the recipient preview." />
          : <DataTable caption="Preview email broadcast workflow" headers={["Subject", "Status", "Snapshot", "Audience", "Schedule", "Actions"]}>
            {broadcasts.map((broadcast) => <tr key={broadcast.handle}>
              <td><strong>{broadcast.subject}</strong><br /><span className="muted">Created {new Date(broadcast.createdAt).toLocaleString()}</span></td>
              <td><StatusBadge tone={broadcast.status === "simulated" ? "ready" : broadcast.status === "approved" ? "info" : "pending"}>{broadcast.status}</StatusBadge></td>
              <td>{broadcast.snapshotDate}</td>
              <td>{broadcast.eligible} eligible<br /><span className="muted">{broadcast.missing} missing · {broadcast.duplicate} duplicate · {broadcast.suppressed} suppressed</span></td>
              <td>{broadcast.scheduledFor ? new Date(broadcast.scheduledFor).toLocaleString() : "Manual simulation"}</td>
              <td><MemberEmailBroadcastActions handle={broadcast.handle} status={broadcast.status} requiresDifferentApprover={broadcast.requiresDifferentApprover} /></td>
            </tr>)}
          </DataTable>}
    </SectionCard>
  </div></ProtectedPage>;
}
