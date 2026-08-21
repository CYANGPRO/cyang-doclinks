import "server-only";

import { randomUUID } from "node:crypto";
import { buildSyntheticPiiBackfillPlan, type PiiBackfillSourceDataset } from "./pii-backfill.ts";
import { getPiiKeyConfiguration, type PiiKeyConfiguration } from "./pii-protection.ts";
import type { DatabaseStatement } from "./db.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requested(env: NodeJS.ProcessEnv) {
  return env.LOCAL801_PII_DUAL_WRITE_ENABLED === "1";
}

function configuration(env: NodeJS.ProcessEnv) {
  if (!requested(env)) return null;
  if (env.VERCEL_ENV === "production") throw new Error("PII dual write is never allowed in Vercel Production during synthetic cutover.");
  if (env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") throw new Error("PII dual write requires production launch to remain disabled.");
  if (env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") throw new Error("PII dual write cannot run after protected-only mode is enabled.");
  return getPiiKeyConfiguration(env);
}

export function piiDualWriteRequested(env: NodeJS.ProcessEnv = process.env) {
  return requested(env);
}

export function validatePiiDualWriteEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return configuration(env) !== null;
}

function baseDataset(): Omit<PiiBackfillSourceDataset, "users" | "importFiles" | "importRows"> {
  return {
    authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], pushSubscriptions: [],
  };
}

function requireUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`${label} must be a UUID for PII dual write.`);
  return value.toLowerCase();
}

function requireText(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required for PII dual write.`);
  return value;
}

function gateStatement(organizationId: string): DatabaseStatement {
  return {
    sql: `
      /* pii-dual-write:gate */
      SELECT 1 / CASE WHEN EXISTS (
        SELECT 1
        FROM local801.organizations organization
        JOIN local801.pii_protection_state state ON state.organization_id = organization.id
        WHERE organization.id = $1::uuid
          AND organization.slug = 'local801-preview'
          AND organization.archived_at IS NULL
          AND state.write_mode = 'dual'
          AND state.protected_read_enabled_at IS NULL
          AND state.protected_write_enabled_at IS NULL
      ) THEN 1 ELSE 0 END AS pii_dual_write_ready
    `,
    parameters: [organizationId],
  };
}

function exactIndexStatement(rows: readonly { organizationId: string; entityType: string; entityId: string; domain: string; keyVersion: string; hash: string }[]): DatabaseStatement | null {
  if (rows.length === 0) return null;

  if (rows.length === 1) {
    const row = rows[0];
    return {
      sql: `
        /* pii-dual-write:exact-indexes */
        INSERT INTO local801.pii_exact_indexes
          (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
        VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6)
        ON CONFLICT (organization_id, entity_type, entity_id, index_domain, index_key_version)
        DO UPDATE SET index_hash = excluded.index_hash
      `,
      parameters: [
        row.organizationId,
        row.entityType,
        row.entityId,
        row.domain,
        row.keyVersion,
        row.hash,
      ],
    };
  }

  return {
    sql: `
      /* pii-dual-write:exact-indexes */
      INSERT INTO local801.pii_exact_indexes
        (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
      SELECT source.organization_id::uuid, source.entity_type, source.entity_id::uuid,
        source.index_domain, source.index_key_version, source.index_hash
      FROM jsonb_to_recordset($1::text::jsonb) AS source(
        organization_id text, entity_type text, entity_id text,
        index_domain text, index_key_version text, index_hash text
      )
      ON CONFLICT (organization_id, entity_type, entity_id, index_domain, index_key_version)
      DO UPDATE SET index_hash = excluded.index_hash
    `,
    parameters: [JSON.stringify(rows.map((row) => ({
      organization_id: row.organizationId,
      entity_type: row.entityType,
      entity_id: row.entityId,
      index_domain: row.domain,
      index_key_version: row.keyVersion,
      index_hash: row.hash,
    })))],
  };
}

function userProtectionStatements(input: {
  organizationId: string;
  userId: string;
  email: string;
  displayName: string;
}, config: PiiKeyConfiguration): DatabaseStatement[] {
  const dataset: PiiBackfillSourceDataset = {
    ...baseDataset(),
    users: [{
      id: input.userId,
      organization_id: input.organizationId,
      email: input.email,
      display_name: input.displayName,
    }],
    importFiles: [],
    importRows: [],
  };
  const plan = buildSyntheticPiiBackfillPlan(dataset, config);
  const row = plan.users[0] as Record<string, unknown>;
  const statements: DatabaseStatement[] = [{
    sql: `
      /* pii-dual-write:user */
      INSERT INTO local801.user_pii (
        organization_id, user_id,
        email_encrypted_payload, email_encryption_key_version, email_encryption_format_version,
        display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version,
        updated_at
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::integer, $6, $7, $8::integer, now())
      ON CONFLICT (organization_id, user_id) DO UPDATE SET
        email_encrypted_payload = excluded.email_encrypted_payload,
        email_encryption_key_version = excluded.email_encryption_key_version,
        email_encryption_format_version = excluded.email_encryption_format_version,
        display_name_encrypted_payload = excluded.display_name_encrypted_payload,
        display_name_encryption_key_version = excluded.display_name_encryption_key_version,
        display_name_encryption_format_version = excluded.display_name_encryption_format_version,
        updated_at = now()
    `,
    parameters: [
      row.organizationId, row.userId,
      row.emailEncryptedPayload, row.emailEncryptionKeyVersion, row.emailEncryptionFormatVersion,
      row.displayNameEncryptedPayload, row.displayNameEncryptionKeyVersion, row.displayNameEncryptionFormatVersion,
    ],
  }];
  const indexes = exactIndexStatement(plan.exactIndexes);
  if (indexes) statements.push(indexes);
  return statements;
}

function importRowProtectionStatements(input: {
  organizationId: string;
  rows: readonly { id: string; normalized_json: Record<string, unknown> }[];
}, config: PiiKeyConfiguration): DatabaseStatement[] {
  const dataset: PiiBackfillSourceDataset = {
    ...baseDataset(),
    users: [],
    importFiles: [],
    importRows: input.rows.map((row) => ({
      id: row.id,
      organization_id: input.organizationId,
      normalized_json: row.normalized_json,
    })),
  };
  const plan = buildSyntheticPiiBackfillPlan(dataset, config);
  const protectedRows = plan.importRows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      organization_id: row.organizationId,
      import_row_id: row.importRowId,
      direct_pii_encrypted_payload: row.encryptedPayload,
      encryption_key_version: row.encryptionKeyVersion,
      encryption_format_version: row.encryptionFormatVersion,
      direct_pii_field_set_version: row.fieldSetVersion,
      direct_pii_presence_mask: row.presenceMask,
      direct_pii_validity_mask: row.validityMask,
      row_integrity_hash: row.integrityHash,
      row_integrity_key_version: row.integrityKeyVersion,
    };
  });
  const statements: DatabaseStatement[] = [];
  if (protectedRows.length) statements.push({
    sql: `
      /* pii-dual-write:import-rows */
      INSERT INTO local801.import_row_pii (
        organization_id, import_row_id, direct_pii_encrypted_payload,
        encryption_key_version, encryption_format_version, direct_pii_field_set_version,
        direct_pii_presence_mask, direct_pii_validity_mask,
        row_integrity_hash, row_integrity_key_version, updated_at
      )
      SELECT source.organization_id::uuid, source.import_row_id::uuid,
        source.direct_pii_encrypted_payload, source.encryption_key_version,
        source.encryption_format_version, source.direct_pii_field_set_version,
        source.direct_pii_presence_mask, source.direct_pii_validity_mask,
        source.row_integrity_hash, source.row_integrity_key_version, now()
      FROM jsonb_to_recordset($1::text::jsonb) AS source(
        organization_id text, import_row_id text, direct_pii_encrypted_payload text,
        encryption_key_version text, encryption_format_version integer,
        direct_pii_field_set_version integer, direct_pii_presence_mask smallint,
        direct_pii_validity_mask smallint, row_integrity_hash text, row_integrity_key_version text
      )
      ON CONFLICT (organization_id, import_row_id) DO UPDATE SET
        direct_pii_encrypted_payload = excluded.direct_pii_encrypted_payload,
        encryption_key_version = excluded.encryption_key_version,
        encryption_format_version = excluded.encryption_format_version,
        direct_pii_field_set_version = excluded.direct_pii_field_set_version,
        direct_pii_presence_mask = excluded.direct_pii_presence_mask,
        direct_pii_validity_mask = excluded.direct_pii_validity_mask,
        row_integrity_hash = excluded.row_integrity_hash,
        row_integrity_key_version = excluded.row_integrity_key_version,
        updated_at = now()
    `,
    parameters: [JSON.stringify(protectedRows)],
  });
  const indexes = exactIndexStatement(plan.exactIndexes);
  if (indexes) statements.push(indexes);
  return statements;
}

function isTeamUserProvision(sql: string) {
  return /insert\s+into\s+local801\.users\s*\(\s*id\s*,\s*organization_id\s*,\s*email\s*,\s*display_name\s*,\s*invited_at\s*,\s*invited_by/i.test(sql);
}

function isImportRowsInsert(sql: string) {
  return /insert\s+into\s+local801\.import_rows\b/i.test(sql) && /normalized_json/i.test(sql);
}

function isImportFileInsert(sql: string) {
  return /insert\s+into\s+local801\.import_files\b/i.test(sql) && /original_filename/i.test(sql);
}

function isLegacyPiiMutation(sql: string) {
  const normalized = sql.replace(/\s+/g, " ").toLowerCase();
  if (/insert into local801\.(users|people|person_identifiers|person_contact_methods|contact_correction_requests|import_files|import_rows|push_subscriptions|auth_identities)\b/.test(normalized)) return true;
  if (/update local801\.users\b/.test(normalized) && /\b(email|display_name)\s*=/.test(normalized)) return true;
  if (/update local801\.people\b/.test(normalized) && /\b(first_name|last_name|preferred_name)\s*=/.test(normalized)) return true;
  if (/update local801\.person_identifiers\b/.test(normalized) && /\bidentifier_value\s*=/.test(normalized)) return true;
  if (/update local801\.person_contact_methods\b/.test(normalized) && /\bcontact_value\s*=/.test(normalized)) return true;
  if (/update local801\.contact_correction_requests\b/.test(normalized) && /\bproposed_value\s*=/.test(normalized)) return true;
  if (/update local801\.import_files\b/.test(normalized) && /\boriginal_filename\s*=/.test(normalized)) return true;
  if (/update local801\.import_rows\b/.test(normalized) && /\bnormalized_json\s*=/.test(normalized)) return true;
  if (/update local801\.push_subscriptions\b/.test(normalized) && /\bsubscription_json\s*=/.test(normalized)) return true;
  if (/update local801\.auth_identities\b/.test(normalized) && /\b(provider_subject|linked_email)\s*=/.test(normalized)) return true;
  return false;
}

function parseImportRows(statement: DatabaseStatement) {
  const organizationId = requireUuid(statement.parameters?.[0], "Import-row organization");
  const raw = statement.parameters?.[2];
  if (typeof raw !== "string") throw new Error("Import-row payload is unavailable for PII dual write.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Import-row payload is invalid for PII dual write."); }
  if (!Array.isArray(parsed)) throw new Error("Import-row payload must be an array for PII dual write.");
  const rows = parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Import-row payload contains an invalid row.");
    const row = value as Record<string, unknown>;
    const id = requireUuid(row.id, "Import-row id");
    const normalized = row.normalized_json;
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw new Error("Import-row normalized data is invalid for PII dual write.");
    return { id, normalized_json: normalized as Record<string, unknown> };
  });
  return { organizationId, rows };
}

export function augmentPiiDualWriteTransactionStatements(
  statements: readonly DatabaseStatement[],
  env: NodeJS.ProcessEnv = process.env,
): readonly DatabaseStatement[] {
  if (!requested(env)) return statements;
  const piiMutations = statements.filter((statement) => isLegacyPiiMutation(statement.sql));
  if (piiMutations.length === 0) return statements;
  const config = configuration(env)!;
  const additions: DatabaseStatement[] = [];
  const organizations = new Set<string>();

  for (const statement of piiMutations) {
    if (isTeamUserProvision(statement.sql)) {
      const organizationId = requireUuid(statement.parameters?.[0], "User organization");
      const userId = requireUuid(statement.parameters?.[3], "User id");
      const email = requireText(statement.parameters?.[4], "User email");
      const displayName = requireText(statement.parameters?.[6], "User display name");
      organizations.add(organizationId);
      additions.push(...userProtectionStatements({ organizationId, userId, email, displayName }, config));
      continue;
    }
    if (isImportRowsInsert(statement.sql)) {
      const parsed = parseImportRows(statement);
      organizations.add(parsed.organizationId);
      additions.push(...importRowProtectionStatements(parsed, config));
      continue;
    }
    throw new Error("PII dual-write mode blocked an unsupported legacy PII transaction. Keep that feature disabled until its protected write path is implemented.");
  }

  return [
    ...[...organizations].map(gateStatement),
    ...statements,
    ...additions,
  ];
}

export type PreparedPiiDirectQuery = Readonly<{ sql: string; parameters: readonly unknown[] }>;

export function preparePiiDualWriteDirectQuery(
  query: string,
  parameters: readonly unknown[],
  env: NodeJS.ProcessEnv = process.env,
  makeId: () => string = randomUUID,
): PreparedPiiDirectQuery | null {
  if (!requested(env)) return null;
  if (!isLegacyPiiMutation(query)) return null;
  const config = configuration(env)!;

  if (!isImportFileInsert(query)) {
    throw new Error("PII dual-write mode blocked an unsupported direct legacy PII mutation. Keep that feature disabled until its protected write path is implemented.");
  }

  if (parameters.length < 8) throw new Error("Import-file write parameters are incomplete for PII dual write.");
  const organizationId = requireUuid(parameters[0], "Import-file organization");
  const importBatchId = requireUuid(parameters[1], "Import batch id");
  const originalFilename = requireText(parameters[2], "Import filename");
  const importFileId = requireUuid(makeId(), "Generated import-file id");
  const dataset: PiiBackfillSourceDataset = {
    ...baseDataset(),
    users: [],
    importFiles: [{ id: importFileId, organization_id: organizationId, original_filename: originalFilename }],
    importRows: [],
  };
  const plan = buildSyntheticPiiBackfillPlan(dataset, config);
  const protectedRow = plan.importFiles[0] as Record<string, unknown>;

  return {
    sql: `
      /* pii-dual-write:import-file */
      WITH gate AS (
        SELECT 1 / CASE WHEN EXISTS (
          SELECT 1
          FROM local801.organizations organization
          JOIN local801.pii_protection_state state ON state.organization_id = organization.id
          WHERE organization.id = $1::uuid
            AND organization.slug = 'local801-preview'
            AND organization.archived_at IS NULL
            AND state.write_mode = 'dual'
            AND state.protected_read_enabled_at IS NULL
            AND state.protected_write_enabled_at IS NULL
        ) THEN 1 ELSE 0 END AS ok
      ), inserted_file AS (
        INSERT INTO local801.import_files (
          id, organization_id, import_batch_id, original_filename, media_type, byte_size,
          storage_key, encryption_key_version, sha256
        )
        SELECT $9::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8
        FROM local801.import_batches batch CROSS JOIN gate
        WHERE batch.id = $2::uuid AND batch.organization_id = $1::uuid AND gate.ok = 1
        RETURNING id
      ), protected_file AS (
        INSERT INTO local801.import_file_pii (
          organization_id, import_file_id, original_filename_encrypted_payload,
          encryption_key_version, encryption_format_version, updated_at
        )
        SELECT $1::uuid, inserted_file.id, $10, $11, $12::integer, now()
        FROM inserted_file
        RETURNING import_file_id
      )
      SELECT inserted_file.id
      FROM inserted_file
      JOIN protected_file ON protected_file.import_file_id = inserted_file.id
    `,
    parameters: [
      organizationId, importBatchId, originalFilename,
      parameters[3], parameters[4], parameters[5], parameters[6], parameters[7],
      importFileId,
      protectedRow.encryptedPayload, protectedRow.encryptionKeyVersion, protectedRow.encryptionFormatVersion,
    ],
  };
}

export const __testing = {
  isLegacyPiiMutation,
  isTeamUserProvision,
  isImportRowsInsert,
  isImportFileInsert,
};
