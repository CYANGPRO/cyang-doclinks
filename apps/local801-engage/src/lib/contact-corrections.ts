import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { buildSyntheticPiiBackfillPlan, type PiiBackfillSourceDataset } from "./pii-backfill.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiContactValue,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode } from "./pii-protected-read.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const CONTACT_CORRECTION_FIELDS = ["work_email", "personal_email", "phone", "mailing_address"] as const;
export type ContactCorrectionField = (typeof CONTACT_CORRECTION_FIELDS)[number];
export type ContactCorrectionDecision = "approved" | "rejected";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const MAX_VALUE_LENGTH = 500;
const REVIEW_LIMIT = 50;

export class ContactCorrectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ContactCorrectionError";
    this.code = code;
    this.status = status;
  }
}

function opaque(kind: string, organizationId: string, id: string) {
  return createHash("sha256").update(`${kind}:${organizationId}:${id}`).digest("hex");
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) throw new ContactCorrectionError("INVALID_HANDLE", `${label} is unavailable.`, 400);
  return value.toLowerCase();
}

function requireField(value: unknown): ContactCorrectionField {
  if (typeof value === "string" && CONTACT_CORRECTION_FIELDS.includes(value as ContactCorrectionField)) return value as ContactCorrectionField;
  throw new ContactCorrectionError("INVALID_FIELD", "Contact field is invalid.", 400);
}

function requireValue(field: ContactCorrectionField, value: unknown) {
  if (typeof value !== "string") throw new ContactCorrectionError("INVALID_VALUE", "Proposed contact information is required.", 400);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH || /\u0000/.test(trimmed)) {
    throw new ContactCorrectionError("INVALID_VALUE", `Proposed contact information must be 1-${MAX_VALUE_LENGTH} characters.`, 400);
  }
  try { normalizePiiContactValue(field, trimmed); }
  catch { throw new ContactCorrectionError("INVALID_VALUE", "Proposed contact information is not valid for the selected field.", 400); }
  return trimmed;
}

function requireProtectedMode(env: NodeJS.ProcessEnv = process.env) {
  if (getPiiProtectedReadMode(env) === "legacy" || env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1") {
    throw new ContactCorrectionError("PROTECTED_PII_REQUIRED", "Contact corrections require protected PII mode.", 503);
  }
}

function databaseErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}

function diagnosticField(error: unknown, key: string, maxLength: number) {
  try {
    if (!error || typeof error !== "object") return null;
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value.slice(0, maxLength) : null;
  } catch {
    return null;
  }
}

export function contactCorrectionFailureDiagnostic(error: unknown) {
  const code = diagnosticField(error, "code", 80);
  const constraint = diagnosticField(error, "constraint_name", 120) ?? diagnosticField(error, "constraint", 120);
  const table = diagnosticField(error, "table_name", 120) ?? diagnosticField(error, "table", 120);
  return {
    name: diagnosticField(error, "name", 80) ?? "UnknownError",
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
    ...(table ? { table } : {}),
  };
}

function mapDecisionDatabaseError(error: unknown): never {
  const code = databaseErrorCode(error);
  if (code === "P1701") {
    throw new ContactCorrectionError("STALE_REQUEST", "This contact update is no longer available for review.", 409);
  }
  if (code === "23505") {
    throw new ContactCorrectionError("CONTACT_CONFLICT", "That contact value is already in use or the official contact changed. Refresh the queue before reviewing again.", 409);
  }
  throw error;
}

function baseDataset(): Omit<PiiBackfillSourceDataset, "users" | "importFiles" | "importRows"> {
  return { authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], pushSubscriptions: [] };
}

function encrypted(row: Record<string, unknown>): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  const payload = row.encrypted_payload ?? row.proposed_value_encrypted_payload ?? row.contact_value_encrypted_payload;
  const key = row.encryption_key_version;
  const format = Number(row.encryption_format_version);
  if (typeof payload !== "string" || typeof key !== "string" || format !== 1) {
    throw new ContactCorrectionError("PROTECTED_PII_INVALID", "Protected contact information is unavailable.", 503);
  }
  return { encryptedPayload: payload, encryptionKeyVersion: key, encryptionFormatVersion: 1 };
}

function decryptPersonName(row: Record<string, unknown>, organizationId: string, personId: string, config: PiiKeyConfiguration) {
  const first = decryptPiiField({
    encryptedPayload: String(row.first_name_encrypted_payload),
    encryptionKeyVersion: String(row.first_name_encryption_key_version),
    encryptionFormatVersion: 1,
  }, { organizationId, entity: "person", recordId: personId, field: "first-name" }, config);
  const last = decryptPiiField({
    encryptedPayload: String(row.last_name_encrypted_payload),
    encryptionKeyVersion: String(row.last_name_encryption_key_version),
    encryptionFormatVersion: 1,
  }, { organizationId, entity: "person", recordId: personId, field: "last-name" }, config);
  if (row.preferred_name_encrypted_payload) {
    return decryptPiiField({
      encryptedPayload: String(row.preferred_name_encrypted_payload),
      encryptionKeyVersion: String(row.preferred_name_encryption_key_version),
      encryptionFormatVersion: 1,
    }, { organizationId, entity: "person", recordId: personId, field: "preferred-name" }, config);
  }
  return `${first} ${last}`.trim();
}

async function resolveAuthorizedPerson(context: WorkspaceContext, handleInput: unknown, query: DatabaseQuery) {
  if (!can(context.role, "recordEngagement")) throw new ContactCorrectionError("FORBIDDEN", "Contact correction access is not authorized.", 403);
  const handle = requireHandle(handleInput, "Employee");
  const [row] = await query<{ id: string }>(`
    /* contact-correction:resolve-person */
    SELECT person.id
    FROM local801.people person
    WHERE person.organization_id = $1::uuid AND person.archived_at IS NULL
      AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
      AND (
        $4::text IN ('system_owner','local_admin','cat_admin')
        OR EXISTS (
          SELECT 1 FROM local801.engagement_assignments assignment
          WHERE assignment.organization_id = $1::uuid AND assignment.person_id = person.id
            AND assignment.archived_at IS NULL AND assignment.status = 'open'
            AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
        )
      )
    LIMIT 1
  `, [context.organizationId, context.userId, handle, context.role]);
  if (!row?.id) throw new ContactCorrectionError("NOT_FOUND", "Employee is not available in your current outreach scope.", 404);
  return row.id;
}

export type VisibleContactActions = {
  cellPhone: string | null;
  homePhone: string | null;
  workPhone: string | null;
  homeEmail: string | null;
  workEmail: string | null;
};

export function preferredVisiblePhone(contacts: VisibleContactActions) {
  return contacts.cellPhone ?? contacts.homePhone ?? contacts.workPhone;
}

export function preferredVisibleEmail(contacts: VisibleContactActions) {
  return contacts.homeEmail ?? contacts.workEmail;
}

export async function getVisibleContactActions(
  context: WorkspaceContext,
  personHandle: unknown,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<VisibleContactActions> {
  const query = dependencies.query ?? queryLocal801;
  const env = dependencies.env ?? process.env;
  requireProtectedMode(env);
  await assertPiiProtectedReadState(context.organizationId, query, getPiiProtectedReadMode(env));
  const config = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const personId = await resolveAuthorizedPerson(context, personHandle, query);
  const rows = await query<Record<string, unknown>>(`
    /* contact-correction:visible-contact-actions */
    SELECT DISTINCT ON (contact.contact_type, contact.contact_label)
      contact.id::text AS contact_method_id, contact.contact_type, contact.contact_label,
      protected.contact_value_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version
    FROM local801.person_contact_methods contact
    JOIN local801.person_contact_method_pii protected
      ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
    WHERE contact.organization_id = $1::uuid AND contact.person_id = $2::uuid
      AND contact.contact_type IN ('work_email','personal_email','phone') AND contact.archived_at IS NULL
      AND (
        contact.visibility = 'authorized_directory'
        OR (contact.visibility = 'assigned_only' AND EXISTS (
          SELECT 1 FROM local801.engagement_assignments assignment
          WHERE assignment.organization_id = $1::uuid AND assignment.person_id = contact.person_id
            AND assignment.archived_at IS NULL AND assignment.status = 'open'
            AND (assignment.primary_user_id = $3::uuid OR assignment.backup_user_id = $3::uuid)
        ))
      )
    ORDER BY contact.contact_type, contact.contact_label, contact.is_primary DESC, contact.created_at DESC, contact.id DESC
  `, [context.organizationId, personId, context.userId]);

  let cellPhone: string | null = null;
  let homePhone: string | null = null;
  let workPhone: string | null = null;
  let homeEmail: string | null = null;
  let workEmail: string | null = null;
  for (const row of rows) {
    const id = String(row.contact_method_id);
    const value = decryptPiiField(encrypted(row), { organizationId: context.organizationId, entity: "person-contact", recordId: id, field: "contact-value" }, config);
    if (row.contact_type === "work_email") workEmail = value;
    if (row.contact_type === "personal_email" && (row.contact_label === "home" || row.contact_label === null)) homeEmail = value;
    if (row.contact_type === "phone" && row.contact_label === "cell") cellPhone = value;
    if (row.contact_type === "phone" && row.contact_label === "home") homePhone = value;
    if (row.contact_type === "phone" && (row.contact_label === "work" || row.contact_label === null)) workPhone = value;
  }
  return { cellPhone, homePhone, workPhone, homeEmail, workEmail };
}

export async function submitContactCorrection(
  context: WorkspaceContext,
  input: { personHandle: unknown; field: unknown; proposedValue: unknown },
  dependencies: { query?: DatabaseQuery; runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const env = dependencies.env ?? process.env;
  requireProtectedMode(env);
  await assertPiiProtectedReadState(context.organizationId, query, getPiiProtectedReadMode(env));
  const personId = await resolveAuthorizedPerson(context, input.personHandle, query);
  const field = requireField(input.field);
  const value = requireValue(field, input.proposedValue);
  const requestId = randomUUID();
  const config = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const plan = buildSyntheticPiiBackfillPlan({
    ...baseDataset(), users: [], importFiles: [], importRows: [],
    corrections: [{ id: requestId, organization_id: context.organizationId, proposed_value: value }],
  }, config);
  const protectedRow = plan.corrections[0] as Record<string, unknown>;
  const audit = await prepareAtomicAuditStatement({
    eventType: "record.create", actorId: context.userId, organizationId: context.organizationId,
    subjectType: "contact_correction_request", subjectId: requestId,
    payload: { field, workflow: "organizer_reported_correction" },
  }, query);
  const statements: DatabaseStatement[] = [{
    sql: `SELECT local801.submit_protected_contact_correction($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8::integer)`,
    parameters: [context.organizationId, requestId, personId, context.userId, field,
      protectedRow.encryptedPayload, protectedRow.encryptionKeyVersion, protectedRow.encryptionFormatVersion],
  }, audit];
  await (dependencies.runTransaction ?? runLocal801Transaction)(statements);
  return { handle: opaque("contact-correction", context.organizationId, requestId) };
}

export type ContactCorrectionReviewItem = {
  handle: string;
  revision: string;
  personHandle: string;
  displayName: string;
  field: ContactCorrectionField;
  currentValue: string | null;
  proposedValue: string;
  submittedAt: string;
};

export type ContactCorrectionReviewPage = {
  items: ContactCorrectionReviewItem[];
  hasMore: boolean;
};

export async function listContactCorrectionsForReview(
  context: WorkspaceContext,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<ContactCorrectionReviewPage> {
  if (!can(context.role, "manageImports")) throw new ContactCorrectionError("FORBIDDEN", "Contact correction review is not authorized.", 403);
  const query = dependencies.query ?? queryLocal801;
  const env = dependencies.env ?? process.env;
  requireProtectedMode(env);
  await assertPiiProtectedReadState(context.organizationId, query, getPiiProtectedReadMode(env));
  const config = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const rows = await query<Record<string, unknown>>(`
    /* contact-correction:review-queue */
    SELECT request.id::text, request.person_id::text, request.field_name, request.created_at,
      correction.proposed_value_encrypted_payload, correction.encryption_key_version, correction.encryption_format_version,
      person.first_name_encrypted_payload, person.first_name_encryption_key_version, person.first_name_encryption_format_version,
      person.last_name_encrypted_payload, person.last_name_encryption_key_version, person.last_name_encryption_format_version,
      person.preferred_name_encrypted_payload, person.preferred_name_encryption_key_version, person.preferred_name_encryption_format_version,
      current_contact.contact_method_id, current_contact.current_contact_value_encrypted_payload,
      current_contact.current_contact_encryption_key_version, current_contact.current_contact_encryption_format_version,
      local801.contact_correction_revision(
        request.organization_id, request.id, current_contact.contact_method_id::uuid, current_contact.current_contact_version
      ) AS revision
    FROM local801.contact_correction_requests request
    JOIN local801.people active_person
      ON active_person.organization_id = request.organization_id
      AND active_person.id = request.person_id
      AND active_person.archived_at IS NULL
    JOIN local801.contact_correction_request_pii correction
      ON correction.organization_id = request.organization_id AND correction.correction_request_id = request.id
    JOIN local801.person_pii person
      ON person.organization_id = request.organization_id AND person.person_id = request.person_id
    LEFT JOIN LATERAL (
      SELECT contact.id::text AS contact_method_id,
        protected.xmin::text AS current_contact_version,
        protected.contact_value_encrypted_payload AS current_contact_value_encrypted_payload,
        protected.encryption_key_version AS current_contact_encryption_key_version,
        protected.encryption_format_version AS current_contact_encryption_format_version
      FROM local801.person_contact_methods contact
      JOIN local801.person_contact_method_pii protected
        ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
      WHERE contact.organization_id = request.organization_id AND contact.person_id = request.person_id
        AND contact.contact_type = request.field_name AND contact.is_primary = true AND contact.archived_at IS NULL
      ORDER BY contact.created_at, contact.id
      LIMIT 1
    ) current_contact ON true
    WHERE request.organization_id = $1::uuid AND request.state = 'submitted'
    ORDER BY request.created_at ASC, request.id ASC
    LIMIT ${REVIEW_LIMIT + 1}
  `, [context.organizationId]);
  const hasMore = rows.length > REVIEW_LIMIT;
  const items = rows.slice(0, REVIEW_LIMIT).map((row) => {
    const requestId = String(row.id);
    const personId = String(row.person_id);
    const proposedValue = decryptPiiField(encrypted(row), { organizationId: context.organizationId, entity: "correction-request", recordId: requestId, field: "proposed-value" }, config);
    let currentValue: string | null = null;
    if (typeof row.contact_method_id === "string" && typeof row.current_contact_value_encrypted_payload === "string") {
      currentValue = decryptPiiField(encrypted({
        contact_value_encrypted_payload: row.current_contact_value_encrypted_payload,
        encryption_key_version: row.current_contact_encryption_key_version,
        encryption_format_version: row.current_contact_encryption_format_version,
      }), { organizationId: context.organizationId, entity: "person-contact", recordId: row.contact_method_id, field: "contact-value" }, config);
    }
    return {
      handle: opaque("contact-correction", context.organizationId, requestId),
      revision: requireHandle(row.revision, "Contact revision"),
      personHandle: createHash("sha256").update(`${context.organizationId}:${personId}`).digest("hex"),
      displayName: decryptPersonName(row, context.organizationId, personId, config),
      field: requireField(row.field_name), currentValue, proposedValue,
      submittedAt: new Date(String(row.created_at)).toISOString(),
    };
  });
  return { items, hasMore };
}

async function resolveCorrection(context: WorkspaceContext, handleInput: unknown, query: DatabaseQuery) {
  if (!can(context.role, "manageImports")) throw new ContactCorrectionError("FORBIDDEN", "Contact correction review is not authorized.", 403);
  const handle = requireHandle(handleInput, "Correction request");
  const [row] = await query<Record<string, unknown>>(`
    /* contact-correction:resolve-review */
    SELECT request.id::text, request.person_id::text, request.field_name,
      correction.proposed_value_encrypted_payload, correction.encryption_key_version, correction.encryption_format_version
    FROM local801.contact_correction_requests request
    JOIN local801.people active_person
      ON active_person.organization_id = request.organization_id
      AND active_person.id = request.person_id
      AND active_person.archived_at IS NULL
    JOIN local801.contact_correction_request_pii correction
      ON correction.organization_id = request.organization_id AND correction.correction_request_id = request.id
    WHERE request.organization_id = $1::uuid AND request.state = 'submitted'
      AND encode(public.digest('contact-correction:' || $1::text || ':' || request.id::text, 'sha256'), 'hex') = $2
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row) throw new ContactCorrectionError("NOT_FOUND", "Contact correction request is no longer available.", 404);
  return row;
}

export async function decideContactCorrection(
  context: WorkspaceContext,
  input: { handle: unknown; decision: unknown; revision?: unknown },
  dependencies: { query?: DatabaseQuery; runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
) {
  const decision: ContactCorrectionDecision = input.decision === "approved" || input.decision === "rejected"
    ? input.decision : (() => { throw new ContactCorrectionError("INVALID_DECISION", "Review decision is invalid.", 400); })();
  const query = dependencies.query ?? queryLocal801;
  const env = dependencies.env ?? process.env;
  requireProtectedMode(env);
  await assertPiiProtectedReadState(context.organizationId, query, getPiiProtectedReadMode(env));
  const row = await resolveCorrection(context, input.handle, query);
  const requestId = String(row.id);
  const personId = String(row.person_id);
  const field = requireField(row.field_name);
  const audit = await prepareAtomicAuditStatement({
    eventType: "record.update", actorId: context.userId, organizationId: context.organizationId,
    subjectType: "contact_correction_request", subjectId: requestId,
    payload: { field, decision },
  }, query);
  const run = dependencies.runTransaction ?? runLocal801Transaction;

  if (decision === "rejected") {
    try {
      await run([{ sql: `SELECT local801.reject_protected_contact_correction($1::uuid,$2::uuid,$3::uuid)`, parameters: [context.organizationId, requestId, context.userId] }, audit]);
    } catch (error) {
      mapDecisionDatabaseError(error);
    }
    return { decision };
  }

  const config = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const expectedRevision = requireHandle(input.revision, "Contact revision");
  const value = decryptPiiField(encrypted(row), { organizationId: context.organizationId, entity: "correction-request", recordId: requestId, field: "proposed-value" }, config);
  const [existing] = await query<{ id: string; visibility: string }>(`
    SELECT id::text, visibility FROM local801.person_contact_methods
    WHERE organization_id = $1::uuid AND person_id = $2::uuid AND contact_type = $3
      AND is_primary = true AND archived_at IS NULL
    ORDER BY created_at, id LIMIT 1
  `, [context.organizationId, personId, field]);
  const contactId = existing?.id ?? randomUUID();
  const visibility = existing?.visibility === "authorized_directory" ? "authorized_directory" : "assigned_only";
  const plan = buildSyntheticPiiBackfillPlan({
    ...baseDataset(), users: [], importFiles: [], importRows: [],
    contacts: [{ id: contactId, organization_id: context.organizationId, contact_type: field, contact_value: value }],
  }, config);
  const protectedRow = plan.contacts[0] as Record<string, unknown>;
  const index = plan.exactIndexes.find((item) => item.entityType === "person_contact_method" && item.entityId === contactId);
  if (!index) throw new ContactCorrectionError("PROTECTED_PII_INVALID", "Protected contact index could not be prepared.", 503);
  try {
    await run([{
      sql: `SELECT local801.approve_protected_contact_correction($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::integer,$10,$11,$12)`,
      parameters: [context.organizationId, requestId, context.userId, contactId, field, visibility,
        protectedRow.encryptedPayload, protectedRow.encryptionKeyVersion, protectedRow.encryptionFormatVersion,
        index.keyVersion, index.hash, expectedRevision],
    }, audit]);
  } catch (error) {
    mapDecisionDatabaseError(error);
  }
  return { decision };
}
