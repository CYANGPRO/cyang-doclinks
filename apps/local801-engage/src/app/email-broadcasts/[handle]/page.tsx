import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader, SectionCard, StatusBadge, type StatusTone } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getMemberEmailBroadcastPreview } from "@/lib/member-email-broadcasts";
import { memberEmailRuntimeEnabled, memberEmailRuntimeSummary } from "@/lib/member-email-preview-policy";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

function statusTone(status: string): StatusTone {
  if (status === "simulated" || status === "sent") return "ready";
  if (status === "approved" || status === "queued" || status === "sending") return "info";
  if (status === "failed") return "blocked";
  if (status === "cancelled") return "neutral";
  return "pending";
}

function fileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : null;
}

export default async function EmailBroadcastPreviewPage({ params }: { params: Promise<{ handle: string }> }) {
  if (!memberEmailRuntimeEnabled()) notFound();
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "sendMemberEmail")) redirect("/unauthorized");
  const [{ handle }, context] = await Promise.all([params, resolveWorkspaceContext(user)]);
  const email = await getMemberEmailBroadcastPreview(context, handle);
  if (!email) notFound();
  const runtime = memberEmailRuntimeSummary();
  const isPreview = runtime.mode === "preview";
  const sentMessage = isPreview
    ? email.realTestSentAt
      ? `A real Preview test was accepted for ${runtime.recipient ?? "the configured test address"} on ${dateTime(email.realTestSentAt)}.`
      : email.simulatedAt
        ? `Synthetic member delivery was recorded on ${dateTime(email.simulatedAt)}. No member email was sent.`
        : "This Preview email has not been sent yet."
    : email.status === "sent"
      ? `Provider submission completed on ${dateTime(email.completedAt)}. Delivery receipts continue to update below.`
      : email.status === "failed"
        ? "Delivery stopped after an error. Review the totals before retrying."
        : "This notice has not completed delivery yet.";

  return <ProtectedPage permission="sendMemberEmail"><div className="content route-email-broadcast-preview-page">
    <PageHeader
      eyebrow="Programs · Email broadcasts"
      title={isPreview ? "Email preview" : "Member notice"}
      description={`Review the protected copy CAT retained for this ${isPreview ? "Preview broadcast" : "member notice"}.`}
      actions={<><Link className="button secondary" href={`/email-broadcasts?copy=${email.handle}`}>Use as new draft</Link><Link className="button secondary" href="/email-broadcasts">Back to broadcasts</Link></>}
    />
    <SectionCard
      title={email.subject}
      description={sentMessage}
      badge={<StatusBadge tone={statusTone(email.status)}>{email.status}</StatusBadge>}
    >
      <dl className={styles.deliveryDetails}>
        <div><dt>Audience</dt><dd>{email.audienceLabel}</dd></div>
        <div><dt>Eligible recipients</dt><dd>{email.eligible}</dd></div>
        <div><dt>Snapshot</dt><dd>{email.snapshotDate}</dd></div>
        <div><dt>Created</dt><dd>{dateTime(email.createdAt)}</dd></div>
        <div><dt>Schedule</dt><dd>{dateTime(email.scheduledFor) ?? "Manual send after approval"}</dd></div>
        <div><dt>Attachments</dt><dd>{email.attachments.length}</dd></div>
        {!isPreview ? <><div><dt>From</dt><dd>{email.senderAddress ?? runtime.from ?? "Not assigned"}</dd></div><div><dt>Replies go to</dt><dd>{email.replyToAddress ?? runtime.replyTo ?? "Not assigned"}</dd></div></> : null}
      </dl>
      {!isPreview ? <section className={styles.attachments} aria-labelledby="delivery-report-title">
        <div><h3 id="delivery-report-title">Delivery report</h3><p>Aggregate provider status; recipient addresses remain protected.</p></div>
        <dl className={styles.deliveryDetails}>
          <div><dt>Pending</dt><dd>{email.deliveryCounts.pending}</dd></div>
          <div><dt>Accepted</dt><dd>{email.deliveryCounts.accepted}</dd></div>
          <div><dt>Delivered</dt><dd>{email.deliveryCounts.delivered}</dd></div>
          <div><dt>Failed</dt><dd>{email.deliveryCounts.failed}</dd></div>
        </dl>
      </section> : null}
      <div className={styles.emailFrame}>
        <div className={styles.emailHeader}>
          <span>Subject</span>
          <strong>{email.subject}</strong>
        </div>
        <div className={styles.emailBody} dangerouslySetInnerHTML={{ __html: email.html }} />
      </div>
      <section className={styles.attachments} aria-labelledby="email-attachments-title">
        <div>
          <h3 id="email-attachments-title">Attachments</h3>
          <p>These are the approved CAT Documents frozen with this email.</p>
        </div>
        {email.attachments.length === 0 ? <p className="muted">No attachments were selected.</p> : <ul>
          {email.attachments.map((attachment, index) => <li key={`${attachment.originalFilename}-${index}`}>
            <div><strong>{attachment.title}</strong><span>{attachment.originalFilename} · {fileSize(attachment.byteSize)}</span></div>
            {attachment.available && attachment.handle
              ? <a className="button secondary compact-button" href={`/api/documents/${attachment.handle}/download`}>Download</a>
              : <span className={styles.unavailable}>No longer available</span>}
          </li>)}
        </ul>}
      </section>
      <p className={styles.previewNotice}>{isPreview ? <><strong>Preview boundary:</strong> member delivery remains simulated. Only the configured one-address test can leave CAT through Resend.</> : <><strong>Production notice:</strong> delivery uses the independent CAT Resend integration. Replies route to {email.replyToAddress ?? runtime.replyTo ?? "the configured reply address"}.</>}</p>
    </SectionCard>
  </div></ProtectedPage>;
}
