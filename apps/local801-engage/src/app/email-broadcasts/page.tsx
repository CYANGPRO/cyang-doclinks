import { notFound, redirect } from "next/navigation";
import { MemberEmailBroadcastActions, MemberEmailBroadcastComposer } from "@/components/MemberEmailBroadcastControls";
import { DataTable, EmptyState, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { safeProductionAuthInternalFailure } from "@/lib/auth-failure-diagnostics";
import { getPreviewUser } from "@/lib/authz.server";
import {
  listMemberEmailAttachmentOptions,
  listMemberEmailAudienceOptions,
  listMemberEmailBroadcasts,
} from "@/lib/member-email-broadcasts";
import { memberEmailPreviewEnabled, memberEmailRealTestSummary } from "@/lib/member-email-preview-policy";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

export default async function EmailBroadcastsPage() {
  if (!memberEmailPreviewEnabled()) notFound();
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "sendMemberEmail")) redirect("/unauthorized");
  const realTest = memberEmailRealTestSummary();
  let broadcasts: Awaited<ReturnType<typeof listMemberEmailBroadcasts>> | null = null;
  let audienceOptions: Awaited<ReturnType<typeof listMemberEmailAudienceOptions>> | null = null;
  let attachmentOptions: Awaited<ReturnType<typeof listMemberEmailAttachmentOptions>> | null = null;
  try {
    const context = await resolveWorkspaceContext(user);
    const [broadcastResult, audienceResult, attachmentResult] = await Promise.allSettled([
      listMemberEmailBroadcasts(context),
      listMemberEmailAudienceOptions(context),
      listMemberEmailAttachmentOptions(context),
    ]);
    if (broadcastResult.status === "fulfilled") broadcasts = broadcastResult.value;
    else console.error("[local801-member-email-safe-failure]", JSON.stringify({
      operation: "list-broadcasts",
      ...safeProductionAuthInternalFailure(broadcastResult.reason),
    }));
    if (audienceResult.status === "fulfilled") audienceOptions = audienceResult.value;
    else console.error("[local801-member-email-safe-failure]", JSON.stringify({
      operation: "list-audiences",
      ...safeProductionAuthInternalFailure(audienceResult.reason),
    }));
    if (attachmentResult.status === "fulfilled") attachmentOptions = attachmentResult.value;
    else console.error("[local801-member-email-safe-failure]", JSON.stringify({
      operation: "list-attachments",
      ...safeProductionAuthInternalFailure(attachmentResult.reason),
    }));
  } catch (error) {
    console.error("[local801-member-email-safe-failure]", JSON.stringify({
      operation: "resolve-workspace",
      ...safeProductionAuthInternalFailure(error),
    }));
  }

  return <ProtectedPage permission="sendMemberEmail"><div className="content route-email-broadcasts-page queue-first-page">
    <PageHeader
      eyebrow="Programs · Preview only"
      title="Email broadcasts"
      description="Choose a higher-level audience, then build and approve a communication against a frozen synthetic recipient snapshot. Member delivery stays simulated; one configured test address can use Resend."
    />
    <SectionCard title="Create Preview broadcast" description="Check the latest approved snapshot, then encrypt the draft and freeze its synthetic recipient population." badge={<StatusBadge tone={realTest.enabled ? "info" : "pending"}>{realTest.enabled ? "One-address Resend test" : "Provider disabled"}</StatusBadge>}>
      {audienceOptions ? <MemberEmailBroadcastComposer audienceOptions={audienceOptions} attachmentOptions={attachmentOptions} sender={realTest.from} replyTo={realTest.replyTo} />
        : <UnavailableState title="Recipient audiences unavailable" description="CAT could not establish the protected Preview audience choices, so draft creation stays disabled." />}
    </SectionCard>
    <SectionCard title="Preview workflow" description="The creator submits the draft; a different authorized administrator approves it; delivery remains simulated." badge={<StatusBadge tone="info">Two-person approval</StatusBadge>}>
      {!broadcasts ? <UnavailableState title="Broadcast workflow unavailable" description="CAT could not establish the protected Preview broadcast state, so no incomplete results are shown." />
        : broadcasts.length === 0 ? <EmptyState title="No Preview broadcasts" description="Create the first synthetic draft after checking the recipient preview." />
          : <DataTable caption="Preview email broadcast workflow" headers={["Subject", "Status", "Snapshot", "Audience", "Schedule", "Actions"]}>
            {broadcasts.map((broadcast) => <tr key={broadcast.handle}>
              <td><strong>{broadcast.subject}</strong><br /><span className="muted">Created {new Date(broadcast.createdAt).toLocaleString()}</span>{broadcast.attachmentCount > 0 ? <><br /><span className="muted">{broadcast.attachmentCount} {broadcast.attachmentCount === 1 ? "attachment" : "attachments"}</span></> : null}</td>
              <td><StatusBadge tone={broadcast.status === "simulated" ? "ready" : broadcast.status === "approved" ? "info" : "pending"}>{broadcast.status}</StatusBadge></td>
              <td>{broadcast.snapshotDate}</td>
              <td><strong>{broadcast.audienceLabel}</strong><br />{broadcast.eligible} eligible of {broadcast.representedRecipients}<br /><span className="muted">{broadcast.missing} missing · {broadcast.duplicate} duplicate · {broadcast.suppressed} suppressed</span></td>
              <td>{broadcast.scheduledFor ? new Date(broadcast.scheduledFor).toLocaleString() : "Manual simulation"}</td>
              <td><MemberEmailBroadcastActions handle={broadcast.handle} status={broadcast.status} requiresDifferentApprover={broadcast.requiresDifferentApprover} realTestRecipient={realTest.recipient} /></td>
            </tr>)}
          </DataTable>}
    </SectionCard>
  </div></ProtectedPage>;
}
