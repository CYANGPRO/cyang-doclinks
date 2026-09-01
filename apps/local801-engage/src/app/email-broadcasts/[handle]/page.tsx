import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader, SectionCard, StatusBadge, type StatusTone } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getMemberEmailBroadcastPreview } from "@/lib/member-email-broadcasts";
import { memberEmailPreviewEnabled, memberEmailRealTestSummary } from "@/lib/member-email-preview-policy";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

function statusTone(status: string): StatusTone {
  if (status === "simulated") return "ready";
  if (status === "approved") return "info";
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
  if (!memberEmailPreviewEnabled()) notFound();
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "sendMemberEmail")) redirect("/unauthorized");
  const [{ handle }, context] = await Promise.all([params, resolveWorkspaceContext(user)]);
  const email = await getMemberEmailBroadcastPreview(context, handle);
  if (!email) notFound();
  const realTest = memberEmailRealTestSummary();
  const sentMessage = email.realTestSentAt
    ? `A real Preview test was accepted for ${realTest.recipient ?? "the configured test address"} on ${dateTime(email.realTestSentAt)}.`
    : email.simulatedAt
      ? `Synthetic member delivery was recorded on ${dateTime(email.simulatedAt)}. No member email was sent.`
      : "This Preview email has not been sent yet.";

  return <ProtectedPage permission="sendMemberEmail"><div className="content route-email-broadcast-preview-page">
    <PageHeader
      eyebrow="Programs · Email broadcasts"
      title="Email preview"
      description="Review the protected copy CAT retained for this Preview broadcast."
      actions={<Link className="button secondary" href="/email-broadcasts">Back to broadcasts</Link>}
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
      </dl>
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
      <p className={styles.previewNotice}><strong>Preview boundary:</strong> member delivery remains simulated. Only the configured one-address test can leave CAT through Resend.</p>
    </SectionCard>
  </div></ProtectedPage>;
}
