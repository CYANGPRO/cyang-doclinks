import "server-only";

import { randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { buildSyntheticPiiBackfillPlan, type PiiBackfillSourceDataset } from "./pii-backfill.ts";
import {
  getPiiKeyConfiguration,
  normalizePiiEmail,
  normalizePiiIdentifier,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const MAX_WORK_TEXT = 200;

export type DirectDataQualityField =
  | "identifier"
  | "workEmail"
  | "department"
  | "classification"
  | "workLocation"
  | "membershipStatus";

export type DataQualityCorrectionInput = {
  personHandle: unknown;
  identifierType?: unknown;
  identifierValue?: unknown;
  workEmail?: unknown;
  department?: unknown;
  classification?: unknown;
  workLocation?: unknown;
  membershipStatus?: unknown;
};

export class DataQualityCorrectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DataQualityCorrectionError";
    this.code = code;
    this.status = status;
  }
}

type PersonFacts = {
  id: string;
  membership_status: string | null;
  department: string | null;
  classification: string | null;
  work_location: string | null;
  missing_identifier: boolean;
  missing_work_email: boolean;
};

type NormalizedCorrection = {
  personHandle: string;
  identifierType: "employee_identifier" | "member_identifier" | null;
  identifierValue: string | null;
  workEmail: string | null;
  department: string | null;
  classification: string | null;
  workLocation: string | null;
  membershipStatus: "member" | "nonmember" | null;
  fields: DirectDataQualityField[];
};

function baseDataset(): Omit<PiiBackfillSourceDataset, "users" | "importFiles" | "importRows"> {
  return { authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], pushSubscriptions: [] };
}

function requireProtectedMode(env: NodeJS.ProcessEnv) {
  if (getPiiProtectedReadMode(env) === "legacy" || env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1") {
    throw new DataQualityCorrectionError("PROTECTED_PII_REQUIRED", "Data-quality corrections require protected PII mode.", 503);
  }
}

function optionalText(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new DataQualityCorrectionError("INVALID_VALUE", `${label} is invalid.`, 400);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > MAX_WORK_TEXT || /\u0000/.test(normalized)) {
    throw new DataQualityCorrectionError("INVALID_VALUE", `${label} must be between 1 and ${MAX_WORK_TEXT} characters.`, 400);
  }
  return normalized;
}

export function normalizeDataQualityCorrectionInput(input: DataQualityCorrectionInput): NormalizedCorrection {
  if (typeof input.personHandle !== "string" || !HANDLE_RE.test(input.personHandle)) {
    throw new DataQualityCorrectionError("INVALID_HANDLE", "Member record is unavailable.", 400);
  }

  const identifierType = input.identifierType === undefined || input.identifierType === null || input.identifierType === ""
    ? null
    : input.identifierType === "employee_identifier" || input.identifierType === "member_identifier"
      ? input.identifierType
      : (() => { throw new DataQualityCorrectionError("INVALID_IDENTIFIER_TYPE", "Identifier type is invalid.", 400); })();
  let identifierValue: string | null = null;
  if (input.identifierValue !== undefined && input.identifierValue !== null && input.identifierValue !== "") {
    if (typeof input.identifierValue !== "string") throw new DataQualityCorrectionError("INVALID_IDENTIFIER", "Identifier is invalid.", 400);
    try { identifierValue = normalizePiiIdentifier(input.identifierValue); }
    catch { throw new DataQualityCorrectionError("INVALID_IDENTIFIER", "Identifier is invalid.", 400); }
  }
  if ((identifierType === null) !== (identifierValue === null)) {
    throw new DataQualityCorrectionError("IDENTIFIER_INCOMPLETE", "Choose an identifier type and enter the identifier value.", 400);
  }

  let workEmail: string | null = null;
  if (input.workEmail !== undefined && input.workEmail !== null && input.workEmail !== "") {
    if (typeof input.workEmail !== "string") throw new DataQualityCorrectionError("INVALID_WORK_EMAIL", "Work email is invalid.", 400);
    try { workEmail = normalizePiiEmail(input.workEmail); }
    catch { throw new DataQualityCorrectionError("INVALID_WORK_EMAIL", "Work email is invalid.", 400); }
  }

  const department = optionalText(input.department, "Department");
  const classification = optionalText(input.classification, "Classification");
  const workLocation = optionalText(input.workLocation, "Work location");
  const membershipStatus = input.membershipStatus === undefined || input.membershipStatus === null || input.membershipStatus === ""
    ? null
    : input.membershipStatus === "member" || input.membershipStatus === "nonmember"
      ? input.membershipStatus
      : (() => { throw new DataQualityCorrectionError("INVALID_MEMBERSHIP", "Membership status must be Member or Nonmember.", 400); })();

  const fields: DirectDataQualityField[] = [];
  if (identifierType && identifierValue) fields.push("identifier");
  if (workEmail) fields.push("workEmail");
  if (department) fields.push("department");
  if (classification) fields.push("classification");
  if (workLocation) fields.push("workLocation");
  if (membershipStatus) fields.push("membershipStatus");
  if (fields.length === 0) throw new DataQualityCorrectionError("NO_CHANGES", "Enter at least one correction before saving.", 400);

  return {
    personHandle: input.personHandle.toLowerCase(), identifierType, identifierValue, workEmail,
    department, classification, workLocation, membershipStatus, fields,
  };
}

async function resolvePersonFacts(context: WorkspaceContext, handle: string, query: DatabaseQuery) {
  const [person] = await query<PersonFacts>(`
    /* data-quality-correction:resolve-person */
    SELECT person.id::text, person.membership_status, person.department, person.classification, person.work_location,
      NOT EXISTS (
        SELECT 1 FROM local801.person_identifiers identifier
        WHERE identifier.organization_id = person.organization_id AND identifier.person_id = person.id
          AND identifier.identifier_type IN ('employee_identifier','member_identifier')
      ) AS missing_identifier,
      NOT EXISTS (
        SELECT 1 FROM local801.person_contact_methods contact
        WHERE contact.organization_id = person.organization_id AND contact.person_id = person.id
          AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
      ) AS missing_work_email
    FROM local801.people person
    WHERE person.organization_id = $1::uuid AND person.archived_at IS NULL
      AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $2
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!person) throw new DataQualityCorrectionError("NOT_FOUND", "Member record is no longer available.", 404);
  return person;
}

function isBlank(value: string | null) {
  return value === null || value.trim() === "";
}

function assertIssuesStillOpen(facts: PersonFacts, correction: NormalizedCorrection) {
  if (correction.identifierValue && !facts.missing_identifier) throw new DataQualityCorrectionError("ISSUE_RESOLVED", "An employee or member ID is already on file. Refresh the page before making another change.", 409);
  if (correction.workEmail && !facts.missing_work_email) throw new DataQualityCorrectionError("ISSUE_RESOLVED", "A work email is already on file. Refresh the page before making another change.", 409);
  if (correction.department && !isBlank(facts.department)) throw new DataQualityCorrectionError("ISSUE_RESOLVED", "Department is already on file. Refresh the page before making another change.", 409);
  if (correction.classification && !isBlank(facts.classification)) throw new DataQualityCorrectionError("ISSUE_RESOLVED", "Classification is already on file. Refresh the page before making another change.", 409);
  if (correction.workLocation && !isBlank(facts.work_location)) throw new DataQualityCorrectionError("ISSUE_RESOLVED", "Work location is already on file. Refresh the page before making another change.", 409);
  if (correction.membershipStatus && facts.membership_status === "member" || correction.membershipStatus && facts.membership_status === "nonmember") {
    throw new DataQualityCorrectionError("ISSUE_RESOLVED", "Membership status is already resolved. Refresh the page before making another change.", 409);
  }
}

async function assertNoProtectedConflict(
  context: WorkspaceContext,
  personId: string,
  entityType: "person_identifier" | "person_contact_method",
  domain: string,
  keyVersion: string,
  hash: string,
  query: DatabaseQuery,
) {
  const sourceTable = entityType === "person_identifier" ? "person_identifiers" : "person_contact_methods";
  const personColumn = entityType === "person_identifier" ? "identifier.person_id" : "contact.person_id";
  const alias = entityType === "person_identifier" ? "identifier" : "contact";
  const activeClause = entityType === "person_contact_method" ? "AND contact.archived_at IS NULL" : "";
  const rows = await query<{ conflict: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM local801.pii_exact_indexes idx
      JOIN local801.${sourceTable} ${alias}
        ON ${alias}.organization_id = idx.organization_id AND ${alias}.id = idx.entity_id
      WHERE idx.organization_id = $1::uuid AND idx.entity_type = $2
        AND idx.index_domain = $3 AND idx.index_key_version = $4 AND idx.index_hash = $5
        AND ${personColumn} <> $6::uuid ${activeClause}
    ) AS conflict
  `, [context.organizationId, entityType, domain, keyVersion, hash, personId]);
  if (rows[0]?.conflict) {
    throw new DataQualityCorrectionError(
      entityType === "person_identifier" ? "IDENTIFIER_CONFLICT" : "WORK_EMAIL_CONFLICT",
      entityType === "person_identifier" ? "That identifier is already assigned to another member record." : "That work email is already assigned to another active member record.",
      409,
    );
  }
}

function protectedWriteGate(organizationId: string): DatabaseStatement {
  return {
    sql: `
      /* data-quality-correction:protected-write-gate */
      SELECT 1 / CASE WHEN EXISTS (
        SELECT 1 FROM local801.pii_protection_state state
        WHERE state.organization_id = $1::uuid AND state.write_mode = 'protected'
          AND state.backfill_state = 'complete' AND state.backfill_completed_at IS NOT NULL
          AND state.protected_read_enabled_at IS NOT NULL AND state.protected_write_enabled_at IS NOT NULL
          AND state.verified_at IS NOT NULL
      ) THEN 1 ELSE 0 END AS protected_write_ready
    `,
    parameters: [organizationId],
  };
}

function correctionEligibilityGuard(
  organizationId: string,
  personId: string,
  correction: NormalizedCorrection,
): DatabaseStatement {
  return {
    sql: `
      /* data-quality-correction:lock-and-revalidate */
      SELECT local801.lock_data_quality_correction_target(
        $1::uuid,$2::uuid,$3::boolean,$4::boolean,$5::boolean,$6::boolean,$7::boolean,$8::boolean
      )
    `,
    parameters: [
      organizationId,
      personId,
      correction.identifierValue !== null,
      correction.workEmail !== null,
      correction.department !== null,
      correction.classification !== null,
      correction.workLocation !== null,
      correction.membershipStatus !== null,
    ],
  };
}

function databaseErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}

function conflictGuard(input: {
  organizationId: string;
  personId: string;
  entityType: "person_identifier" | "person_contact_method";
  domain: string;
  keyVersion: string;
  hash: string;
}) {
  const sourceTable = input.entityType === "person_identifier" ? "person_identifiers" : "person_contact_methods";
  const alias = input.entityType === "person_identifier" ? "identifier" : "contact";
  const activeClause = input.entityType === "person_contact_method" ? "AND contact.archived_at IS NULL" : "";
  return [
    {
      sql: `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      parameters: [`${input.entityType}:${input.domain}:${input.keyVersion}:${input.hash}`],
    },
    {
      sql: `
        SELECT 1 / CASE WHEN EXISTS (
          SELECT 1 FROM local801.pii_exact_indexes idx
          JOIN local801.${sourceTable} ${alias}
            ON ${alias}.organization_id = idx.organization_id AND ${alias}.id = idx.entity_id
          WHERE idx.organization_id = $1::uuid AND idx.entity_type = $2
            AND idx.index_domain = $3 AND idx.index_key_version = $4 AND idx.index_hash = $5
            AND ${alias}.person_id <> $6::uuid ${activeClause}
        ) THEN 0 ELSE 1 END AS unique_value_guard
      `,
      parameters: [input.organizationId, input.entityType, input.domain, input.keyVersion, input.hash, input.personId],
    },
  ] satisfies DatabaseStatement[];
}

export async function applyDataQualityCorrections(
  context: WorkspaceContext,
  input: DataQualityCorrectionInput,
  dependencies: {
    query?: DatabaseQuery;
    runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
    env?: NodeJS.ProcessEnv;
    keyConfig?: PiiKeyConfiguration;
  } = {},
) {
  if (!can(context.role, "manageImports")) throw new DataQualityCorrectionError("FORBIDDEN", "Data-quality correction access is not authorized.", 403);
  const query = dependencies.query ?? queryLocal801;
  const env = dependencies.env ?? process.env;
  requireProtectedMode(env);
  await assertPiiProtectedReadState(context.organizationId, query, getPiiProtectedReadMode(env));
  const correction = normalizeDataQualityCorrectionInput(input);
  const facts = await resolvePersonFacts(context, correction.personHandle, query);
  assertIssuesStillOpen(facts, correction);

  const statements: DatabaseStatement[] = [
    protectedWriteGate(context.organizationId),
    correctionEligibilityGuard(context.organizationId, facts.id, correction),
  ];
  const config = dependencies.keyConfig ?? getPiiKeyConfiguration(env);

  if (correction.identifierType && correction.identifierValue) {
    const identifierId = randomUUID();
    const plan = buildSyntheticPiiBackfillPlan({
      ...baseDataset(), users: [], importFiles: [], importRows: [],
      identifiers: [{
        id: identifierId, organization_id: context.organizationId,
        identifier_type: correction.identifierType, identifier_value: correction.identifierValue,
      }],
    }, config);
    const protectedRow = plan.identifiers[0] as Record<string, unknown>;
    const index = plan.exactIndexes.find((item) => item.entityType === "person_identifier" && item.entityId === identifierId);
    if (!index) throw new DataQualityCorrectionError("PROTECTED_PII_INVALID", "Protected identifier could not be prepared.", 503);
    await assertNoProtectedConflict(context, facts.id, "person_identifier", index.domain, index.keyVersion, index.hash, query);
    statements.push(...conflictGuard({ organizationId: context.organizationId, personId: facts.id, entityType: "person_identifier", domain: index.domain, keyVersion: index.keyVersion, hash: index.hash }));
    statements.push({
      sql: `
        /* pii-protected-execution:legacy-placeholder */
        INSERT INTO local801.person_identifiers
          (id, organization_id, person_id, identifier_type, identifier_value, source_import_file_id)
        SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM local801.person_identifiers existing
          WHERE existing.organization_id = $2::uuid AND existing.person_id = $3::uuid
            AND existing.identifier_type IN ('employee_identifier','member_identifier')
        )
      `,
      parameters: [identifierId, context.organizationId, facts.id, correction.identifierType, `protected:${identifierId}`],
    }, {
      sql: `
        INSERT INTO local801.person_identifier_pii
          (organization_id, person_identifier_id, identifier_value_encrypted_payload, encryption_key_version, encryption_format_version, updated_at)
        VALUES ($1::uuid,$2::uuid,$3,$4,$5::integer,now())
      `,
      parameters: [context.organizationId, identifierId, protectedRow.encryptedPayload, protectedRow.encryptionKeyVersion, protectedRow.encryptionFormatVersion],
    }, {
      sql: `
        INSERT INTO local801.pii_exact_indexes
          (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
        VALUES ($1::uuid,'person_identifier',$2::uuid,$3,$4,$5)
      `,
      parameters: [context.organizationId, identifierId, index.domain, index.keyVersion, index.hash],
    });
  }

  if (correction.workEmail) {
    const contactId = randomUUID();
    const plan = buildSyntheticPiiBackfillPlan({
      ...baseDataset(), users: [], importFiles: [], importRows: [],
      contacts: [{ id: contactId, organization_id: context.organizationId, contact_type: "work_email", contact_value: correction.workEmail }],
    }, config);
    const protectedRow = plan.contacts[0] as Record<string, unknown>;
    const index = plan.exactIndexes.find((item) => item.entityType === "person_contact_method" && item.entityId === contactId);
    if (!index) throw new DataQualityCorrectionError("PROTECTED_PII_INVALID", "Protected work email could not be prepared.", 503);
    await assertNoProtectedConflict(context, facts.id, "person_contact_method", index.domain, index.keyVersion, index.hash, query);
    statements.push(...conflictGuard({ organizationId: context.organizationId, personId: facts.id, entityType: "person_contact_method", domain: index.domain, keyVersion: index.keyVersion, hash: index.hash }));
    statements.push({
      sql: `
        /* pii-protected-execution:legacy-placeholder */
        INSERT INTO local801.person_contact_methods
          (id, organization_id, person_id, contact_type, contact_value, is_primary, visibility, verified_at, archived_at)
        SELECT $1::uuid,$2::uuid,$3::uuid,'work_email',$4,true,'authorized_directory',now(),NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM local801.person_contact_methods existing
          WHERE existing.organization_id = $2::uuid AND existing.person_id = $3::uuid
            AND existing.contact_type = 'work_email' AND existing.archived_at IS NULL
        )
      `,
      parameters: [contactId, context.organizationId, facts.id, `protected-${contactId}@invalid.local`],
    }, {
      sql: `
        INSERT INTO local801.person_contact_method_pii
          (organization_id, contact_method_id, contact_value_encrypted_payload, encryption_key_version, encryption_format_version, updated_at)
        VALUES ($1::uuid,$2::uuid,$3,$4,$5::integer,now())
      `,
      parameters: [context.organizationId, contactId, protectedRow.encryptedPayload, protectedRow.encryptionKeyVersion, protectedRow.encryptionFormatVersion],
    }, {
      sql: `
        INSERT INTO local801.pii_exact_indexes
          (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
        VALUES ($1::uuid,'person_contact_method',$2::uuid,$3,$4,$5)
      `,
      parameters: [context.organizationId, contactId, index.domain, index.keyVersion, index.hash],
    });
  }

  if (correction.department || correction.classification || correction.workLocation) {
    statements.push({
      sql: `
        UPDATE local801.people
        SET department = CASE WHEN $3::text IS NOT NULL AND NULLIF(btrim(department),'') IS NULL THEN $3 ELSE department END,
            classification = CASE WHEN $4::text IS NOT NULL AND NULLIF(btrim(classification),'') IS NULL THEN $4 ELSE classification END,
            work_location = CASE WHEN $5::text IS NOT NULL AND NULLIF(btrim(work_location),'') IS NULL THEN $5 ELSE work_location END,
            updated_at = now()
        WHERE organization_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL
          AND (($3::text IS NOT NULL AND NULLIF(btrim(department),'') IS NULL)
            OR ($4::text IS NOT NULL AND NULLIF(btrim(classification),'') IS NULL)
            OR ($5::text IS NOT NULL AND NULLIF(btrim(work_location),'') IS NULL))
      `,
      parameters: [context.organizationId, facts.id, correction.department, correction.classification, correction.workLocation],
    });
  }

  if (correction.membershipStatus) {
    const eventId = randomUUID();
    statements.push({
      sql: `
        WITH changed AS (
          UPDATE local801.people
          SET membership_status = $3, updated_at = now()
          WHERE organization_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL
            AND (membership_status IS NULL OR membership_status NOT IN ('member','nonmember'))
          RETURNING id
        )
        INSERT INTO local801.membership_events
          (id, organization_id, person_id, event_type, effective_date, source_import_file_id, created_by)
        SELECT $4::uuid,$1::uuid,changed.id,'correction',current_date,NULL,$5::uuid FROM changed
      `,
      parameters: [context.organizationId, facts.id, correction.membershipStatus, eventId, context.userId],
    });
  }

  const audit = await prepareAtomicAuditStatement({
    eventType: "record.update",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "data_quality_correction",
    subjectId: facts.id,
    payload: {
      workflow: "direct_data_quality_correction",
      fields: correction.fields,
      ...(correction.identifierType ? { identifierType: correction.identifierType } : {}),
    },
  }, query);
  statements.push(audit);

  try {
    await (dependencies.runTransaction ?? runLocal801Transaction)(statements);
  } catch (error) {
    if (error instanceof DataQualityCorrectionError) throw error;
    if (databaseErrorCode(error) === "P1702") {
      throw new DataQualityCorrectionError("ISSUE_RESOLVED", "This record changed before the correction was saved. Refresh the page and review the remaining issues.", 409);
    }
    if (databaseErrorCode(error) === "23505") {
      throw new DataQualityCorrectionError("VALUE_CONFLICT", "An identifier or work email is already assigned to another active member record.", 409);
    }
    throw new DataQualityCorrectionError("SAVE_FAILED", "The correction could not be saved safely. Refresh the page and try again.", 503);
  }
  return { updated: correction.fields };
}
