import "server-only";

import { createHash } from "node:crypto";
import { Resend } from "resend";
import { FatalError, RetryableError } from "workflow";
import { can, type Role } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, withLocal801Transaction } from "./db.ts";
import { downloadDocument } from "./document-storage.ts";
import { renderMemberEmailHtml, renderMemberEmailText } from "./member-email-format.ts";
import { MemberEmailBroadcastError } from "./member-email-broadcasts.ts";
import { memberEmailProductionBoundary } from "./member-email-preview-policy.ts";
import { decryptPiiField, getPiiKeyConfiguration } from "./pii-protection.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{8,160}$/;
const BATCH_SIZE = 25;

function providerIdempotencyKey(...values: string[]) {
  return `cat-member-notice/${createHash("sha256").update(values.join(":"), "utf8").digest("hex")}`;
}

export type ProductionEmailWorkflowInput = {
  organizationId: string;
  organizationSlug: string;
  broadcastHandle: string;
  actorId: string;
  actorRole: Role;
};

type BroadcastDeliveryRow = {
  id: string;
  status: string;
  scheduled_for: string | Date | null;
  eligible_count: number | string;
  subject_encrypted_payload: string;
  subject_encryption_key_version: string;
  subject_encryption_format_version: number | string;
  body_encrypted_payload: string;
  body_encryption_key_version: string;
  body_encryption_format_version: number | string;
};

type RecipientRow = {
  id: string;
  email_encrypted_payload: string;
  email_encryption_key_version: string;
  email_encryption_format_version: number | string;
};

type AttachmentRow = {
  document_id: string | null;
  original_filename: string;
  media_type: string;
  sha256: string;
};

function fail(code: string, message: string, status = 400): never {
  throw new MemberEmailBroadcastError(code, message, status);
}

function broadcastHandleSql(alias: string) {
  return `encode(public.digest('member-email-broadcast:' || ${alias}.organization_id::text || ':' || ${alias}.id::text, 'sha256'), 'hex')`;
}

function count(value: number | string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function prepareProductionMemberEmailDelivery(context: WorkspaceContext, handle: string) {
  const boundary = memberEmailProductionBoundary();
  if (!can(context.role, "sendMemberEmail")) fail("FORBIDDEN", "Member email delivery is not authorized.", 403);
  if (!HANDLE_RE.test(handle)) fail("NOT_FOUND", "Email notice not found.", 404);
  return withLocal801Transaction(async (query) => {
    const [row] = await query<{ id: string; eligible_count: number | string }>(`
      UPDATE local801.member_email_broadcasts broadcast
      SET status='queued', queued_by=$3::uuid, queued_at=now(), workflow_run_id=null,
        sender_address=$4::text, reply_to_address=$5::text, failure_code=null, updated_at=now()
      WHERE broadcast.organization_id=$1::uuid AND ${broadcastHandleSql("broadcast")}=$2::text
        AND broadcast.status IN ('approved','failed')
      RETURNING broadcast.id::text, broadcast.eligible_count
    `, [context.organizationId, handle, context.userId, boundary.from, boundary.replyTo]);
    if (!row) fail("INVALID_STATE", "Only one approved or failed notice can be queued at a time.", 409);
    if (count(row.eligible_count) < 1 || count(row.eligible_count) > 1000) fail("RECIPIENT_LIMIT", "Production notices require 1 to 1,000 eligible recipients.", 409);
    const audit = await prepareAtomicAuditStatement({
      eventType: "broadcast.send_queued", actorId: context.userId, organizationId: context.organizationId,
      subjectType: "member_email_broadcast", subjectId: row.id,
      payload: { deliveryMode: "production_member_notice", provider: "resend", recipientCount: count(row.eligible_count) },
    }, query);
    await query(audit.sql, audit.parameters);
    return {
      organizationId: context.organizationId,
      organizationSlug: context.organizationSlug,
      broadcastHandle: handle,
      actorId: context.userId,
      actorRole: context.role,
    } satisfies ProductionEmailWorkflowInput;
  });
}

export async function claimProductionMemberEmailDelivery(input: ProductionEmailWorkflowInput, workflowRunId: string) {
  const boundary = memberEmailProductionBoundary();
  if (!SAFE_RUN_ID.test(workflowRunId)) throw new FatalError("Invalid workflow run identifier.");
  return withLocal801Transaction(async (query) => {
    const [row] = await query<{ id: string; status: string; scheduled_for: string | Date | null; workflow_run_id: string | null }>(`
      SELECT broadcast.id::text, broadcast.status, broadcast.scheduled_for, broadcast.workflow_run_id
      FROM local801.member_email_broadcasts broadcast
      WHERE broadcast.organization_id=$1::uuid AND ${broadcastHandleSql("broadcast")}=$2::text
      FOR UPDATE
    `, [input.organizationId, input.broadcastHandle]);
    if (!row) throw new FatalError("Email notice not found.");
    if (row.status === "cancelled" || row.status === "sent") return { status: row.status, scheduledFor: null };
    if (!new Set(["queued", "sending", "paused"]).has(row.status)) throw new FatalError("Email notice is not queued for delivery.");
    if (row.workflow_run_id && row.workflow_run_id !== workflowRunId) throw new FatalError("Another workflow owns this email notice.");
    await query(`UPDATE local801.member_email_broadcasts
      SET status=CASE WHEN status='paused' THEN status ELSE 'queued' END,
        workflow_run_id=$3::text, queued_by=coalesce(queued_by,$4::uuid), queued_at=coalesce(queued_at,now()),
        sender_address=$5::text, reply_to_address=$6::text, updated_at=now()
      WHERE organization_id=$1::uuid AND id=$2::uuid`,
    [input.organizationId, row.id, workflowRunId, input.actorId, boundary.from, boundary.replyTo]);
    return { status: row.status === "paused" ? "paused" : "queued", scheduledFor: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null };
  });
}

export async function productionDeliveryDirective(input: ProductionEmailWorkflowInput) {
  const [row] = await queryLocal801<{ status: string; remaining: number | string }>(`
    SELECT broadcast.status,
      (SELECT count(*)::integer FROM local801.member_email_broadcast_recipients recipient
       WHERE recipient.organization_id=broadcast.organization_id AND recipient.broadcast_id=broadcast.id
         AND recipient.recipient_status='eligible' AND recipient.delivery_status='pending') AS remaining
    FROM local801.member_email_broadcasts broadcast
    WHERE broadcast.organization_id=$1::uuid AND ${broadcastHandleSql("broadcast")}=$2::text
  `, [input.organizationId, input.broadcastHandle]);
  if (!row) throw new FatalError("Email notice not found.");
  if (row.status === "cancelled") return "cancelled" as const;
  if (row.status === "paused") return "paused" as const;
  if (count(row.remaining) === 0) return "complete" as const;
  if (!new Set(["queued", "sending"]).has(row.status)) throw new FatalError("Email notice left the delivery state.");
  return "active" as const;
}

function decryptContent(row: BroadcastDeliveryRow, organizationId: string) {
  const keys = getPiiKeyConfiguration();
  const subject = decryptPiiField({
    encryptedPayload: row.subject_encrypted_payload,
    encryptionKeyVersion: row.subject_encryption_key_version,
    encryptionFormatVersion: Number(row.subject_encryption_format_version) as 1,
  }, { organizationId, entity: "member-email-broadcast", recordId: row.id, field: "subject" }, keys);
  const body = decryptPiiField({
    encryptedPayload: row.body_encrypted_payload,
    encryptionKeyVersion: row.body_encryption_key_version,
    encryptionFormatVersion: Number(row.body_encryption_format_version) as 1,
  }, { organizationId, entity: "member-email-broadcast", recordId: row.id, field: "body" }, keys);
  return { subject, body };
}

async function loadAttachments(input: ProductionEmailWorkflowInput, broadcastId: string, rows: AttachmentRow[]) {
  return Promise.all(rows.map(async (row) => {
    if (!row.document_id) throw new FatalError("A frozen attachment is unavailable.");
    const document = await downloadDocument({
      actor: { organizationId: input.organizationId, userId: input.actorId, role: input.actorRole },
      organizationId: input.organizationId,
      documentId: row.document_id,
    });
    if (document.sha256 !== row.sha256) throw new FatalError("A frozen attachment changed after approval.");
    return { content: document.plaintext, filename: row.original_filename, contentType: row.media_type };
  }));
}

export async function sendNextProductionEmailBatch(input: ProductionEmailWorkflowInput) {
  const boundary = memberEmailProductionBoundary();
  const [broadcast] = await queryLocal801<BroadcastDeliveryRow>(`
    SELECT broadcast.id::text, broadcast.status, broadcast.scheduled_for, broadcast.eligible_count,
      content.subject_encrypted_payload, content.subject_encryption_key_version, content.subject_encryption_format_version,
      content.body_encrypted_payload, content.body_encryption_key_version, content.body_encryption_format_version
    FROM local801.member_email_broadcasts broadcast
    JOIN local801.member_email_broadcast_content content ON content.organization_id=broadcast.organization_id AND content.broadcast_id=broadcast.id
    WHERE broadcast.organization_id=$1::uuid AND ${broadcastHandleSql("broadcast")}=$2::text
  `, [input.organizationId, input.broadcastHandle]);
  if (!broadcast || !new Set(["queued", "sending"]).has(broadcast.status)) throw new FatalError("Email notice is not available for delivery.");
  const recipients = await queryLocal801<RecipientRow>(`
    SELECT recipient.id::text, recipient.email_encrypted_payload, recipient.email_encryption_key_version, recipient.email_encryption_format_version
    FROM local801.member_email_broadcast_recipients recipient
    WHERE recipient.organization_id=$1::uuid AND recipient.broadcast_id=$2::uuid
      AND recipient.recipient_status='eligible' AND recipient.delivery_status='pending'
    ORDER BY recipient.id LIMIT ${BATCH_SIZE}
  `, [input.organizationId, broadcast.id]);
  if (recipients.length === 0) return { accepted: 0 };
  const attachmentRows = await queryLocal801<AttachmentRow>(`
    SELECT attachment.document_id::text, attachment.original_filename, attachment.media_type, attachment.sha256
    FROM local801.member_email_broadcast_attachments attachment
    WHERE attachment.organization_id=$1::uuid AND attachment.broadcast_id=$2::uuid ORDER BY attachment.display_order
  `, [input.organizationId, broadcast.id]);
  const attachments = await loadAttachments(input, broadcast.id, attachmentRows);
  const { subject, body } = decryptContent(broadcast, input.organizationId);
  const resend = new Resend(boundary.apiKey);
  const protectedTargets = recipients.map((recipient) => ({
    recipient,
    email: decryptPiiField({
      encryptedPayload: recipient.email_encrypted_payload,
      encryptionKeyVersion: recipient.email_encryption_key_version,
      encryptionFormatVersion: Number(recipient.email_encryption_format_version) as 1,
    }, { organizationId: input.organizationId, entity: "member-email-recipient", recordId: recipient.id, field: "email" }, getPiiKeyConfiguration()),
  }));
  const text = renderMemberEmailText(body);
  const html = renderMemberEmailHtml(body);
  let accepted = 0;
  const persistAccepted = async (recipient: RecipientRow, providerMessageId: string) => {
    await withLocal801Transaction(async (query) => {
      await query(`UPDATE local801.member_email_broadcast_recipients
        SET delivery_status='accepted', provider_message_id=$4::text, attempt_count=attempt_count+1,
          last_attempt_at=now(), accepted_at=now()
        WHERE organization_id=$1::uuid AND broadcast_id=$2::uuid AND id=$3::uuid AND delivery_status='pending'`,
      [input.organizationId, broadcast.id, recipient.id, providerMessageId]);
      await query(`INSERT INTO local801.member_email_delivery_events
        (organization_id,broadcast_id,recipient_id,provider_event_id,event_type,metadata)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text,'provider.accepted',$5::jsonb)
        ON CONFLICT (organization_id,provider_event_id) DO NOTHING`,
      [input.organizationId, broadcast.id, recipient.id, `accepted:${providerMessageId}`, JSON.stringify({ provider: "resend" })]);
    });
  };
  if (attachments.length === 0) {
    const { data, error } = await resend.batch.send(protectedTargets.map(({ email }) => ({
      from: boundary.from, replyTo: boundary.replyTo, to: [email], subject, text, html,
    })), { idempotencyKey: providerIdempotencyKey(input.organizationId, broadcast.id, "batch", recipients[0].id) });
    if (error || !data || data.data.length !== recipients.length) throw new RetryableError("Email provider temporarily rejected a delivery batch.", { retryAfter: "30s" });
    for (let index = 0; index < recipients.length; index += 1) {
      await persistAccepted(recipients[index], data.data[index].id);
      accepted += 1;
    }
  } else {
    for (let index = 0; index < protectedTargets.length; index += 1) {
      const { recipient, email } = protectedTargets[index];
      const { data, error } = await resend.emails.send({
        from: boundary.from, replyTo: boundary.replyTo, to: [email], subject, text, html, attachments,
      }, { idempotencyKey: providerIdempotencyKey(input.organizationId, broadcast.id, recipient.id) });
      if (error || !data?.id) throw new RetryableError("Email provider temporarily rejected a recipient.", { retryAfter: "30s" });
      await persistAccepted(recipient, data.id);
      accepted += 1;
      if (index < protectedTargets.length - 1) await new Promise((resolve) => setTimeout(resolve, 550));
    }
  }
  await queryLocal801(`UPDATE local801.member_email_broadcasts SET status='sending', started_at=coalesce(started_at,now()), updated_at=now()
    WHERE organization_id=$1::uuid AND id=$2::uuid AND status='queued'`, [input.organizationId, broadcast.id]);
  console.log(JSON.stringify({ level: "info", event: "member_email_batch_accepted", broadcastIdHash: createHash("sha256").update(broadcast.id).digest("hex"), accepted }));
  return { accepted };
}

export async function completeProductionMemberEmailDelivery(input: ProductionEmailWorkflowInput) {
  await withLocal801Transaction(async (query) => {
    const [row] = await query<{ id: string; eligible_count: number | string; submitted_count: number | string }>(`
      SELECT broadcast.id::text, broadcast.eligible_count,
        (SELECT count(*)::integer FROM local801.member_email_broadcast_recipients recipient
         WHERE recipient.organization_id=broadcast.organization_id AND recipient.broadcast_id=broadcast.id
           AND recipient.recipient_status='eligible' AND recipient.delivery_status <> 'pending') AS submitted_count
      FROM local801.member_email_broadcasts broadcast
      WHERE broadcast.organization_id=$1::uuid AND ${broadcastHandleSql("broadcast")}=$2::text FOR UPDATE
    `, [input.organizationId, input.broadcastHandle]);
    if (!row || count(row.submitted_count) !== count(row.eligible_count)) throw new RetryableError("The protected delivery count is not complete.", { retryAfter: "30s" });
    await query(`UPDATE local801.member_email_broadcasts SET status='sent', completed_at=now(), updated_at=now(), failure_code=null
      WHERE organization_id=$1::uuid AND id=$2::uuid AND status IN ('queued','sending')`, [input.organizationId, row.id]);
    const audit = await prepareAtomicAuditStatement({
      eventType: "broadcast.send_completed", actorId: input.actorId, organizationId: input.organizationId,
      subjectType: "member_email_broadcast", subjectId: row.id,
      payload: { provider: "resend", recipientCount: count(row.submitted_count), deliveryMode: "production_member_notice" },
    }, query);
    await query(audit.sql, audit.parameters);
  });
}

export async function failProductionMemberEmailDelivery(input: ProductionEmailWorkflowInput) {
  await withLocal801Transaction(async (query) => {
    const [row] = await query<{ id: string }>(`UPDATE local801.member_email_broadcasts SET status='failed', failure_code='WORKFLOW_FAILED', updated_at=now()
      WHERE organization_id=$1::uuid AND ${broadcastHandleSql("member_email_broadcasts")}=$2::text AND status IN ('queued','sending') RETURNING id::text`,
    [input.organizationId, input.broadcastHandle]);
    if (!row) return;
    const audit = await prepareAtomicAuditStatement({
      eventType: "broadcast.send_failed", actorId: input.actorId, organizationId: input.organizationId,
      subjectType: "member_email_broadcast", subjectId: row.id,
      payload: { deliveryMode: "production_member_notice", failureCode: "WORKFLOW_FAILED" },
    }, query);
    await query(audit.sql, audit.parameters);
  });
}

export async function controlProductionMemberEmailDelivery(context: WorkspaceContext, handle: string, action: "pause" | "resume" | "cancel") {
  memberEmailProductionBoundary();
  if (!can(context.role, "sendMemberEmail")) fail("FORBIDDEN", "Member email delivery is not authorized.", 403);
  if (!HANDLE_RE.test(handle)) fail("NOT_FOUND", "Email notice not found.", 404);
  return withLocal801Transaction(async (query) => {
    const [row] = await query<{ id: string; status: string }>(`SELECT id::text,status FROM local801.member_email_broadcasts
      WHERE organization_id=$1::uuid AND ${broadcastHandleSql("member_email_broadcasts")}=$2::text FOR UPDATE`, [context.organizationId, handle]);
    if (!row) fail("NOT_FOUND", "Email notice not found.", 404);
    const allowed = action === "pause" ? new Set(["queued", "sending"]) : action === "resume" ? new Set(["paused"]) : new Set(["draft", "review", "approved", "failed", "queued", "sending", "paused"]);
    if (!allowed.has(row.status)) fail("INVALID_STATE", `This notice cannot be ${action}d.`, 409);
    const next = action === "pause" ? "paused" : action === "resume" ? "queued" : "cancelled";
    await query(`UPDATE local801.member_email_broadcasts SET status=$3::text,
      paused_by=CASE WHEN $4::text='pause' THEN $5::uuid ELSE paused_by END,
      paused_at=CASE WHEN $4::text='pause' THEN now() ELSE paused_at END,
      cancelled_by=CASE WHEN $4::text='cancel' THEN $5::uuid ELSE cancelled_by END,
      cancelled_at=CASE WHEN $4::text='cancel' THEN now() ELSE cancelled_at END, updated_at=now()
      WHERE organization_id=$1::uuid AND id=$2::uuid`, [context.organizationId, row.id, next, action, context.userId]);
    const eventType = action === "pause" ? "broadcast.send_paused" : action === "resume" ? "broadcast.send_resumed" : "broadcast.send_cancelled";
    const audit = await prepareAtomicAuditStatement({
      eventType, actorId: context.userId, organizationId: context.organizationId,
      subjectType: "member_email_broadcast", subjectId: row.id,
      payload: { priorStatus: row.status, nextStatus: next, deliveryMode: "production_member_notice" },
    }, query);
    await query(audit.sql, audit.parameters);
    return { action, status: next };
  });
}

export async function applyResendWebhook(rawBody: string, headers: { id: string; timestamp: string; signature: string }) {
  const boundary = memberEmailProductionBoundary();
  let event: ReturnType<Resend["webhooks"]["verify"]>;
  try {
    event = new Resend(boundary.apiKey).webhooks.verify({ payload: rawBody, headers, webhookSecret: boundary.webhookSecret });
  } catch {
    fail("INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid.", 401);
  }
  if (!event.type.startsWith("email.") || !("email_id" in event.data)) return { accepted: true };
  const providerMessageId = event.data.email_id;
  const mapping: Record<string, { status: string; type: string }> = {
    "email.delivered": { status: "delivered", type: "provider.delivered" },
    "email.bounced": { status: "bounced", type: "provider.bounced" },
    "email.complained": { status: "complained", type: "provider.complained" },
    "email.suppressed": { status: "suppressed", type: "provider.suppressed" },
    "email.failed": { status: "failed", type: "provider.failed" },
  };
  const mapped = mapping[event.type];
  if (!mapped) return { accepted: true };
  await withLocal801Transaction(async (query) => {
    const [recipient] = await query<{ organization_id: string; broadcast_id: string; id: string }>(`
      SELECT organization_id::text,broadcast_id::text,id::text FROM local801.member_email_broadcast_recipients
      WHERE provider_message_id=$1::text`, [providerMessageId]);
    if (!recipient) return;
    await query(`UPDATE local801.member_email_broadcast_recipients SET delivery_status=$4::text,
      delivered_at=CASE WHEN $4::text='delivered' THEN now() ELSE delivered_at END,
      failed_at=CASE WHEN $4::text IN ('bounced','complained','suppressed','failed') THEN now() ELSE failed_at END
      WHERE organization_id=$1::uuid AND broadcast_id=$2::uuid AND id=$3::uuid`,
    [recipient.organization_id, recipient.broadcast_id, recipient.id, mapped.status]);
    await query(`INSERT INTO local801.member_email_delivery_events
      (organization_id,broadcast_id,recipient_id,provider_event_id,event_type,occurred_at,metadata)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,now(),'{}'::jsonb)
      ON CONFLICT (organization_id,provider_event_id) DO NOTHING`,
    [recipient.organization_id, recipient.broadcast_id, recipient.id, headers.id, mapped.type]);
  });
  return { accepted: true };
}
