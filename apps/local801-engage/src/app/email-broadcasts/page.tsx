import { notFound, redirect } from "next/navigation";
import { MemberEmailBroadcastComposer } from "@/components/MemberEmailBroadcastControls";
import { MemberEmailBroadcastArchive } from "@/components/MemberEmailBroadcastArchive";
import { PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { safeProductionAuthInternalFailure } from "@/lib/auth-failure-diagnostics";
import { getPreviewUser } from "@/lib/authz.server";
import {
  getMemberEmailBroadcastPreview,
  listMemberEmailAttachmentOptions,
  listMemberEmailAudienceOptions,
  listMemberEmailBroadcasts,
  listMemberEmailTemplates,
} from "@/lib/member-email-broadcasts";
import { memberEmailRuntimeEnabled, memberEmailRuntimeSummary } from "@/lib/member-email-preview-policy";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

export default async function EmailBroadcastsPage({ searchParams }: { searchParams: Promise<{ copy?: string }> }) {
  if (!memberEmailRuntimeEnabled()) notFound();
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "sendMemberEmail")) redirect("/unauthorized");
  const runtime = memberEmailRuntimeSummary();
  const isPreview = runtime.mode === "preview";
  let broadcasts: Awaited<ReturnType<typeof listMemberEmailBroadcasts>> | null = null;
  let audienceOptions: Awaited<ReturnType<typeof listMemberEmailAudienceOptions>> | null = null;
  let attachmentOptions: Awaited<ReturnType<typeof listMemberEmailAttachmentOptions>> | null = null;
  let initialDraft: Awaited<ReturnType<typeof getMemberEmailBroadcastPreview>> = null;
  let templates: Awaited<ReturnType<typeof listMemberEmailTemplates>> | null = null;
  try {
    const requestedCopy = (await searchParams).copy;
    const context = await resolveWorkspaceContext(user);
    const [broadcastResult, audienceResult, attachmentResult, templateResult, copyResult] = await Promise.allSettled([
      listMemberEmailBroadcasts(context),
      listMemberEmailAudienceOptions(context),
      listMemberEmailAttachmentOptions(context),
      listMemberEmailTemplates(context),
      requestedCopy ? getMemberEmailBroadcastPreview(context, requestedCopy) : Promise.resolve(null),
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
    if (copyResult.status === "fulfilled") initialDraft = copyResult.value;
    if (templateResult.status === "fulfilled") templates = templateResult.value;
    else console.error("[local801-member-email-safe-failure]", JSON.stringify({
      operation: "list-templates",
      ...safeProductionAuthInternalFailure(templateResult.reason),
    }));
  } catch (error) {
    console.error("[local801-member-email-safe-failure]", JSON.stringify({
      operation: "resolve-workspace",
      ...safeProductionAuthInternalFailure(error),
    }));
  }

  return <ProtectedPage permission="sendMemberEmail"><div className="content route-email-broadcasts-page queue-first-page">
    <PageHeader
      eyebrow={`Programs · ${isPreview ? "Preview only" : "Member notices"}`}
      title="Email broadcasts"
      description={isPreview
        ? "Choose a higher-level audience, then build and approve a communication against a frozen synthetic recipient snapshot. Member delivery stays simulated; one configured test address can use Resend."
        : "Create a member notice against a frozen recipient snapshot, route it through two-person approval, and monitor delivery without exposing recipient addresses."}
    />
    <SectionCard title={`Create ${isPreview ? "Preview broadcast" : "member notice"}`} description={`Check the latest approved snapshot, then encrypt the draft and freeze its ${isPreview ? "synthetic " : ""}recipient population.`} badge={<StatusBadge tone={runtime.providerReady ? "info" : "pending"}>{runtime.providerReady ? isPreview ? "One-address Resend test" : "Production Resend ready" : "Provider disabled"}</StatusBadge>}>
      {audienceOptions ? <MemberEmailBroadcastComposer audienceOptions={audienceOptions} attachmentOptions={attachmentOptions} templates={templates} sender={runtime.from} replyTo={runtime.replyTo} mode={runtime.mode} initialDraft={initialDraft ? {
        subject: initialDraft.subject,
        body: initialDraft.body,
        audienceKey: initialDraft.audienceKey,
        attachmentHandles: initialDraft.attachments.flatMap((attachment) => attachment.available && attachment.handle ? [attachment.handle] : []),
      } : null} />
        : <UnavailableState title="Recipient audiences unavailable" description={`CAT could not establish the protected ${isPreview ? "Preview " : ""}audience choices, so draft creation stays disabled.`} />}
    </SectionCard>
    <SectionCard title={isPreview ? "Preview workflow" : "Notice archive and delivery"} description={isPreview ? "The creator submits the draft; a different authorized administrator approves it; delivery remains simulated." : "Search past notices, review delivery totals, and control active sends. The creator cannot approve their own notice."} badge={<StatusBadge tone="info">Two-person approval</StatusBadge>}>
      {!broadcasts ? <UnavailableState title="Broadcast workflow unavailable" description={`CAT could not establish the protected ${isPreview ? "Preview " : ""}broadcast state, so no incomplete results are shown.`} />
        : <MemberEmailBroadcastArchive broadcasts={broadcasts} mode={runtime.mode} providerReady={runtime.providerReady} sender={runtime.from} replyTo={runtime.replyTo} realTestRecipient={runtime.recipient} />}
    </SectionCard>
  </div></ProtectedPage>;
}
