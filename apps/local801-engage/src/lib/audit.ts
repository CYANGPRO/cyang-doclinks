import "server-only";

import { createHash } from "node:crypto";
import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type AuditEventType =
  | "auth.sign_in"
  | "policy.acknowledged"
  | "session.mobile_device_attested"
  | "session.mobile_push_registered"
  | "import.preview"
  | "import.upload"
  | "import.validation"
  | "import.reject_errors_download"
  | "import.resolution_set"
  | "import.resolution_cleared"
  | "import.approval_plan_update"
  | "import.duplicate_source_ack"
  | "import.review_new_people"
  | "import.review_existing_changes"
  | "import.review_decision_cleared"
  | "import.execute"
  | "record.create"
  | "record.read"
  | "record.update"
  | "role.change"
  | "report.run"
  | "export.generate"
  | "config.change"
  | "record.archive"
  | "record.restore"
  | "broadcast.create"
  | "broadcast.submit"
  | "broadcast.approve"
  | "broadcast.test_simulated"
  | "broadcast.send_simulated";

export type AuditEvent = {
  eventType: AuditEventType;
  actorId: string;
  organizationId: string;
  subjectType?: string;
  subjectId?: string;
  payload?: Record<string, unknown>;
  previousHash?: string | null;
};

type AuditEventDatabaseRow = {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  event_hash: string;
  previous_hash: string | null;
  created_at: string | Date;
};

export type AuditEventRecord = Pick<AuditEventDatabaseRow, "id" | "event_type" | "actor_user_id" | "subject_type" | "subject_id"> & { created_at: string };
type AuditDisplayDatabaseRow = Pick<AuditEventDatabaseRow, "id" | "event_type" | "actor_user_id" | "subject_type" | "subject_id" | "created_at">;

const sensitiveKeys = [/name/i, /email/i, /phone/i, /address/i, /note/i, /raw/i, /contact/i];

export function redactAuditPayload(payload: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (sensitiveKeys.some((pattern) => pattern.test(key))) return [key, "[redacted]"];
      return [key, value];
    }),
  );
}

export function buildAuditEvent(event: AuditEvent) {
  const payload = redactAuditPayload(event.payload);
  const hashInput = JSON.stringify({
    eventType: event.eventType,
    actorId: event.actorId,
    organizationId: event.organizationId,
    subjectType: event.subjectType ?? null,
    subjectId: event.subjectId ?? null,
    payload,
    previousHash: event.previousHash ?? null,
  });

  return {
    ...event,
    payload,
    eventHash: createHash("sha256").update(hashInput).digest("hex"),
    createdAt: new Date().toISOString(),
    previousHash: event.previousHash ?? null,
  };
}

export async function auditPreviewEvent(event: AuditEvent) {
  const built = buildAuditEvent(event);
  if (process.env.NODE_ENV !== "production") {
    console.info("[local801-audit]", JSON.stringify(built));
  }
  return built;
}

export function normalizeAuditTimestamp(value: string | Date) {
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "Timestamp unavailable" : timestamp.toISOString();
}

export async function writeAuditEvent(event: AuditEvent, query: DatabaseQuery = queryLocal801) {
  // The Neon HTTP transaction is intentionally kept to the insert itself; concurrent writers can
  // observe the same predecessor. The database currently stores the chain metadata but does not
  // enforce an immutable/strictly serialized hash-chain constraint.
  const [previous] = await query<{ event_hash: string }>(
    `SELECT event_hash FROM local801.audit_events WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [event.organizationId],
  );
  const built = buildAuditEvent({ ...event, previousHash: previous?.event_hash ?? null });
  const [row] = await query<{ id: string }>(
    `
      INSERT INTO local801.audit_events
        (organization_id, actor_user_id, event_type, subject_type, subject_id, payload, previous_hash, event_hash)
      SELECT $1, actor.id, $3, $4, $5, $6::text::jsonb, $7, $8
      FROM local801.users actor
      WHERE actor.id = $2 AND actor.organization_id = $1 AND actor.deactivated_at IS NULL
      RETURNING id
    `,
    [
      event.organizationId,
      event.actorId,
      event.eventType,
      event.subjectType ?? null,
      event.subjectId ?? null,
      JSON.stringify(built.payload),
      built.previousHash,
      built.eventHash,
    ],
  );
  if (!row?.id) throw new Error("Durable audit event could not be recorded.");
  return { ...built, id: row.id };
}

export async function prepareAtomicAuditStatement(
  event: AuditEvent,
  query: DatabaseQuery = queryLocal801,
): Promise<DatabaseStatement> {
  const [previous] = await query<{ event_hash: string }>(
    `SELECT event_hash FROM local801.audit_events WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [event.organizationId],
  );
  const built = buildAuditEvent({ ...event, previousHash: previous?.event_hash ?? null });
  return {
    sql: `
      WITH inserted_audit AS (
        INSERT INTO local801.audit_events
          (organization_id, actor_user_id, event_type, subject_type, subject_id, payload, previous_hash, event_hash)
        SELECT $1, actor.id, $3, $4, $5, $6::text::jsonb, $7, $8
        FROM local801.users actor
        WHERE actor.id = $2
          AND actor.organization_id = $1
          AND actor.deactivated_at IS NULL
        RETURNING id
      )
      SELECT CASE
        WHEN count(*) = 1 THEN true
        ELSE 1 / count(*)::integer = 1
      END AS audit_written
      FROM inserted_audit
    `,
    parameters: [
      event.organizationId,
      event.actorId,
      event.eventType,
      event.subjectType ?? null,
      event.subjectId ?? null,
      JSON.stringify(built.payload),
      built.previousHash,
      built.eventHash,
    ],
  };
}

type AuditReadContext = Pick<WorkspaceContext, "organizationId" | "role">;

function requireAuditRead(context: AuditReadContext) {
  if (!can(context.role, "manageUsers")) throw new Error("Audit access is not authorized.");
}

export async function listAuditEvents(
  context: AuditReadContext,
  query: DatabaseQuery = queryLocal801,
): Promise<AuditEventRecord[]> {
  requireAuditRead(context);
  const rows = await query<AuditDisplayDatabaseRow>(
    `
      SELECT id, event_type, actor_user_id, subject_type, subject_id, created_at
      FROM local801.audit_events
      WHERE organization_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `,
    [context.organizationId],
  );
  return rows.map((row) => ({ id: row.id, event_type: row.event_type, actor_user_id: row.actor_user_id,
    subject_type: row.subject_type, subject_id: row.subject_id, created_at: normalizeAuditTimestamp(row.created_at) }));
}

export type AuditPage = { events: AuditEventRecord[]; nextCursor: string | null; eventType: string; pageSize: number };
export const MAX_AUDIT_EXPORT_EVENTS = 5_000;

export class AuditExportLimitError extends Error {
  constructor() {
    super(`Audit activity exports are limited to ${MAX_AUDIT_EXPORT_EVENTS.toLocaleString("en-US")} events. Choose an activity filter and try again.`);
    this.name = "AuditExportLimitError";
  }
}

function normalizeAuditEventType(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function auditCursor(value: unknown) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    const createdAt = typeof parsed.createdAt === "string" ? normalizeAuditTimestamp(parsed.createdAt) : "Timestamp unavailable";
    return createdAt === "Timestamp unavailable" || typeof parsed.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
      ? null
      : { createdAt, id: parsed.id };
  } catch { return null; }
}

export async function getAuditPage(
  context: AuditReadContext,
  input: { eventType?: unknown; cursor?: unknown; pageSize?: unknown },
  query: DatabaseQuery = queryLocal801,
): Promise<AuditPage> {
  requireAuditRead(context);
  const eventType = normalizeAuditEventType(input.eventType);
  const requested = Number(input.pageSize);
  const pageSize = [25, 50, 100].includes(requested) ? requested : 25;
  const cursor = auditCursor(input.cursor);
  const rows = await query<AuditDisplayDatabaseRow>(`
    /* audit:keyset-page */
    SELECT id, event_type, actor_user_id, subject_type, subject_id, created_at
    FROM local801.audit_events
    WHERE organization_id = $1
      AND ($2::text IS NULL OR event_type = $2::text)
      AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
    ORDER BY created_at DESC, id DESC
    LIMIT $5
  `, [context.organizationId, eventType || null, cursor?.createdAt ?? null, cursor?.id ?? null, pageSize + 1]);
  const hasNext = rows.length > pageSize;
  const bounded = rows.slice(0, pageSize);
  const last = bounded.at(-1);
  return {
    events: bounded.map((row) => ({ id: row.id, event_type: row.event_type, actor_user_id: row.actor_user_id,
      subject_type: row.subject_type, subject_id: row.subject_id, created_at: normalizeAuditTimestamp(row.created_at) })),
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ createdAt: normalizeAuditTimestamp(last.created_at), id: last.id })).toString("base64url") : null,
    eventType,
    pageSize,
  };
}

export async function getAuditExportEvents(
  context: AuditReadContext,
  input: { eventType?: unknown },
  query: DatabaseQuery = queryLocal801,
) {
  requireAuditRead(context);
  const eventType = normalizeAuditEventType(input.eventType);
  const rows = await query<AuditDisplayDatabaseRow>(`
    /* audit:bounded-export */
    SELECT id, event_type, actor_user_id, subject_type, subject_id, created_at
    FROM local801.audit_events
    WHERE organization_id = $1
      AND ($2::text IS NULL OR event_type = $2::text)
    ORDER BY created_at DESC, id DESC
    LIMIT ${MAX_AUDIT_EXPORT_EVENTS + 1}
  `, [context.organizationId, eventType || null]);
  if (rows.length > MAX_AUDIT_EXPORT_EVENTS) throw new AuditExportLimitError();
  return {
    eventType,
    events: rows.map((row) => ({
      id: row.id,
      event_type: row.event_type,
      actor_user_id: row.actor_user_id,
      subject_type: row.subject_type,
      subject_id: row.subject_id,
      created_at: normalizeAuditTimestamp(row.created_at),
    })),
  };
}
