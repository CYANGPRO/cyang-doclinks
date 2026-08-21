import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { runLocal801Transaction, queryLocal801, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { ImportReviewActor } from "./import-review.ts";
import { getProtectedImportReviewSummary } from "./pii-protected-import-review.ts";
import { PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE } from "./pii-protected-import-classification.ts";
import {
  buildSyntheticPiiBackfillPlan,
  DIRECT_IMPORT_PII_FIELDS,
  type PiiBackfillSourceDataset,
} from "./pii-backfill.ts";
import {
  createPiiBlindIndex,
  createPiiIntegrityHash,
  decryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiContactValue,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";

const MAX_PREPARED_ROWS = 25_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const DIRECT_FIELDS: ReadonlySet<string> = new Set(DIRECT_IMPORT_PII_FIELDS);

type EligibleRow = {
  import_row_id: string;
  category: "unchanged_existing" | "existing_with_changes" | "proposed_new";
  person_id: string | null;
  normalized_json: Record<string, unknown>;
  direct_pii_encrypted_payload: string;
  encryption_key_version: string;
  encryption_format_version: number;
  direct_pii_field_set_version: number;
  direct_pii_presence_mask: number;
  direct_pii_validity_mask: number;
  row_integrity_hash: string;
  row_integrity_key_version: string;
};

type SourceHashRow = { sha256: string };

type PreparedMutation = {
  import_row_id: string;
  target_person_id: string;
  mutation_kind: "existing" | "new";
  operational_json: Record<string, unknown>;
  person_protected_json: Record<string, unknown>;
  identifier_protected_json: readonly Record<string, unknown>[];
  contact_protected_json: readonly Record<string, unknown>[];
  exact_indexes_json: readonly Record<string, unknown>[];
  search_tokens_json: readonly Record<string, unknown>[];
  mutation_hash: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function baseDataset(): Omit<PiiBackfillSourceDataset, "users" | "importFiles" | "importRows"> {
  return { authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], pushSubscriptions: [] };
}

function envelope(row: EligibleRow): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  const fieldSetVersion = Number(row.direct_pii_field_set_version);
  if (typeof row.direct_pii_encrypted_payload !== "string" || typeof row.encryption_key_version !== "string"
    || Number(row.encryption_format_version) !== 1 || (fieldSetVersion !== 2 && fieldSetVersion !== 3)) {
    throw new Error("Protected import execution requires a valid direct-PII companion.");
  }
  const presence = Number(row.direct_pii_presence_mask);
  const validity = Number(row.direct_pii_validity_mask);
  const maxMask = fieldSetVersion === 2 ? 63 : 1023;
  if (!Number.isInteger(presence) || !Number.isInteger(validity) || presence < 0 || presence > maxMask
    || validity < 0 || validity > maxMask || (validity & presence) !== validity) {
    throw new Error("Protected import execution requires valid direct-PII field metadata.");
  }
  return { encryptedPayload: row.direct_pii_encrypted_payload, encryptionKeyVersion: row.encryption_key_version, encryptionFormatVersion: 1 };
}

function decryptBundle(row: EligibleRow, organizationId: string, config: PiiKeyConfiguration) {
  const plaintext = decryptPiiField(
    envelope(row),
    { organizationId, entity: "import-row", recordId: row.import_row_id, field: "direct-pii" },
    config,
  );
  let parsed: unknown;
  try { parsed = JSON.parse(plaintext); } catch { throw new Error("Protected import-row PII bundle is invalid."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Protected import-row PII bundle is invalid.");
  const bundle: Record<string, string> = {};
  for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!DIRECT_FIELDS.has(field) || typeof value !== "string" || !value.trim()) throw new Error("Protected import-row PII bundle has an invalid field set.");
    bundle[field] = value;
  }
  const canonicalBundle = JSON.stringify(Object.fromEntries(Object.entries(bundle).sort(([left], [right]) => left.localeCompare(right))));
  if (!HASH_RE.test(row.row_integrity_hash) || typeof row.row_integrity_key_version !== "string") {
    throw new Error("Protected import-row integrity metadata is invalid.");
  }
  const integrity = createPiiIntegrityHash(
    canonicalBundle,
    { organizationId, domain: "import-row", keyVersion: row.row_integrity_key_version },
    config,
  );
  if (integrity.blindIndex !== row.row_integrity_hash) throw new Error("Protected import-row integrity verification failed.");
  return bundle;
}

function operationalOnly(normalized: Record<string, unknown>) {
  const value = { ...normalized };
  for (const field of DIRECT_FIELDS) delete value[field];
  for (const field of DIRECT_FIELDS) {
    if (Object.hasOwn(value, field)) throw new Error("Direct PII remained in protected operational import data.");
  }
  return value;
}

function prepareTargetMutation(
  row: EligibleRow,
  organizationId: string,
  config: PiiKeyConfiguration,
): PreparedMutation {
  const bundle = decryptBundle(row, organizationId, config);
  const targetPersonId = row.category === "proposed_new" ? randomUUID() : row.person_id;
  if (!targetPersonId || !UUID_RE.test(targetPersonId)) throw new Error("Protected import execution could not resolve a target person.");
  const identifierSources: Array<PiiBackfillSourceDataset["identifiers"][number]> = [];
  const identifierLinks: Array<{ id: string; identifier_type: string }> = [];
  if (bundle.employee_identifier) {
    const id = randomUUID();
    identifierSources.push({ id, organization_id: organizationId, identifier_type: "employee_identifier", identifier_value: bundle.employee_identifier });
    identifierLinks.push({ id, identifier_type: "employee_identifier" });
  }
  if (bundle.member_identifier) {
    const id = randomUUID();
    identifierSources.push({ id, organization_id: organizationId, identifier_type: "member_identifier", identifier_value: bundle.member_identifier });
    identifierLinks.push({ id, identifier_type: "member_identifier" });
  }
  const contactSources: Array<PiiBackfillSourceDataset["contacts"][number]> = [];
  const contactLinks: Array<{ id: string; contact_type: string; contact_label: string | null; value: string; specific_domain: string | null }> = [];
  if (bundle.work_email) {
    const id = randomUUID();
    contactSources.push({ id, organization_id: organizationId, contact_type: "work_email", contact_value: bundle.work_email });
    contactLinks.push({ id, contact_type: "work_email", contact_label: "work", value: bundle.work_email, specific_domain: null });
  }
  if (bundle.home_email) {
    const id = randomUUID();
    contactSources.push({ id, organization_id: organizationId, contact_type: "personal_email", contact_value: bundle.home_email });
    contactLinks.push({ id, contact_type: "personal_email", contact_label: "home", value: bundle.home_email, specific_domain: null });
  }
  for (const [field, label] of [["work_phone", "work"], ["cell_phone", "cell"], ["home_phone", "home"]] as const) {
    const value = bundle[field];
    if (!value) continue;
    const id = randomUUID();
    contactSources.push({ id, organization_id: organizationId, contact_type: "phone", contact_value: value });
    contactLinks.push({ id, contact_type: "phone", contact_label: label, value, specific_domain: `contact:${label}-phone` });
  }
  const dataset: PiiBackfillSourceDataset = {
    ...baseDataset(), users: [], importFiles: [], importRows: [],
    people: [{
      id: targetPersonId,
      organization_id: organizationId,
      first_name: bundle.first_name,
      last_name: bundle.last_name,
      preferred_name: bundle.preferred_name ?? null,
    }],
    identifiers: identifierSources,
    contacts: contactSources,
  };
  const plan = buildSyntheticPiiBackfillPlan(dataset, config);
  const person = plan.people[0] as unknown as Record<string, unknown>;
  const identifiers = plan.identifiers.map((item, index) => ({
    ...item as unknown as Record<string, unknown>,
    personId: targetPersonId,
    identifierType: identifierLinks[index].identifier_type,
  }));
  const contacts = plan.contacts.map((item, index) => ({
    ...item as unknown as Record<string, unknown>,
    personId: targetPersonId,
    contactType: contactLinks[index].contact_type,
    contactLabel: contactLinks[index].contact_label,
    isPrimary: true,
    visibility: "authorized_directory",
  }));
  const supplementalContactIndexes = contactLinks.flatMap((contact) => {
    if (!contact.specific_domain) return [];
    const index = createPiiBlindIndex(
      normalizePiiContactValue("phone", contact.value),
      { organizationId, domain: contact.specific_domain },
      config,
    );
    return [{
      organizationId,
      entityType: "person_contact_method" as const,
      entityId: contact.id,
      domain: contact.specific_domain,
      keyVersion: index.blindIndexKeyVersion,
      hash: index.blindIndex,
    }];
  });
  const mutationWithoutHash = {
    import_row_id: row.import_row_id,
    target_person_id: targetPersonId,
    mutation_kind: row.category === "proposed_new" ? "new" as const : "existing" as const,
    operational_json: operationalOnly(row.normalized_json),
    person_protected_json: person,
    identifier_protected_json: identifiers,
    contact_protected_json: contacts,
    exact_indexes_json: [...plan.exactIndexes, ...supplementalContactIndexes],
    search_tokens_json: plan.searchTokens,
  };
  return { ...mutationWithoutHash, mutation_hash: sha256(canonical(mutationWithoutHash)) };
}

function reviewFingerprint(summary: Awaited<ReturnType<typeof getProtectedImportReviewSummary>>) {
  return sha256(canonical({
    proposedNew: summary.hashes.proposedNew,
    existingChanges: summary.hashes.existingChanges,
    counts: summary.counts,
    decisions: {
      proposedNew: summary.decisions.proposedNew,
      existingChanges: summary.decisions.existingChanges,
    },
  }));
}

export type ProtectedImportPreparationResult = {
  executionSetId: string;
  mutationFingerprint: string;
  mutationCount: number;
  sourceFingerprint: string;
  reviewFingerprint: string;
};

export async function prepareProtectedImportExecution(
  actor: ImportReviewActor,
  batchId: string,
  dependencies: {
    query?: DatabaseQuery;
    transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProtectedImportPreparationResult> {
  if (!can(actor.role, "approveImports")) throw new Error("Forbidden.");
  if (!UUID_RE.test(batchId)) throw new Error("Import not found.");
  const env = dependencies.env ?? process.env;
  if (env.LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED !== "1") throw new Error("Protected import preparation is disabled.");
  if (env.VERCEL_ENV === "production" && env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1") {
    throw new Error("Production protected import preparation requires protected-only database mode.");
  }
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const config = getPiiKeyConfiguration(env);
  const summary = await getProtectedImportReviewSummary(actor, batchId, query);
  if (summary.blockers > 0 || !summary.counts.metadataComplete || summary.decisions.migrationPending
    || !summary.decisions.proposedNew || !summary.decisions.existingChanges) {
    throw new Error("Protected import execution preparation requires a complete, current, unblocked review.");
  }

  const [sourceHashes, rows] = await Promise.all([
    query<SourceHashRow>(`
      SELECT sha256 FROM local801.import_files
      WHERE organization_id = $1::uuid AND import_batch_id = $2::uuid
      ORDER BY sha256
    `, [actor.organizationId, batchId]),
    query<EligibleRow>(`WITH ${PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE}
      SELECT categorized.import_row_id::text, categorized.category, categorized.person_id::text,
        categorized.normalized_json,
        protected.direct_pii_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version,
        protected.direct_pii_field_set_version, protected.direct_pii_presence_mask, protected.direct_pii_validity_mask,
        protected.row_integrity_hash, protected.row_integrity_key_version
      FROM categorized
      JOIN local801.import_row_pii protected
        ON protected.organization_id = $1::uuid AND protected.import_row_id = categorized.import_row_id
      WHERE categorized.category IN ('unchanged_existing','existing_with_changes','proposed_new')
      ORDER BY categorized.import_row_id
      LIMIT ${MAX_PREPARED_ROWS + 1}
    `, [actor.organizationId, batchId]),
  ]);
  if (!sourceHashes.length || sourceHashes.some((row) => !HASH_RE.test(row.sha256))) throw new Error("Protected import execution requires immutable source hashes.");
  if (rows.length > MAX_PREPARED_ROWS) throw new Error("Protected import execution preparation exceeded the reviewed row bound.");
  if (rows.length !== summary.counts.unchangedExisting + summary.counts.existingWithChanges + summary.counts.proposedNew) {
    throw new Error("Protected import execution preparation did not reconcile to the reviewed row set.");
  }

  const mutations = rows.map((row) => prepareTargetMutation(row, actor.organizationId, config));
  const sourceFingerprint = sha256(sourceHashes.map((row) => row.sha256).join(":"));
  const currentReviewFingerprint = reviewFingerprint(summary);
  const mutationFingerprint = sha256(canonical({
    sourceFingerprint,
    reviewFingerprint: currentReviewFingerprint,
    mutationHashes: mutations.map((row) => row.mutation_hash).sort(),
  }));
  const executionSetId = randomUUID();
  const serializedMutations = mutations.map((row) => ({
    organization_id: actor.organizationId,
    execution_set_id: executionSetId,
    ...row,
  }));

  const statements: DatabaseStatement[] = [{
    sql: `
      UPDATE local801.protected_import_execution_sets
      SET state = 'invalidated', invalidated_at = now(), updated_at = now()
      WHERE organization_id = $1::uuid AND import_batch_id = $2::uuid AND state = 'prepared'
    `,
    parameters: [actor.organizationId, batchId],
  }, {
    sql: `
      INSERT INTO local801.protected_import_execution_sets
        (id, organization_id, import_batch_id, source_fingerprint, review_fingerprint,
         mutation_fingerprint, mutation_count, state, prepared_by)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::integer, 'prepared', $8::uuid)
    `,
    parameters: [executionSetId, actor.organizationId, batchId, sourceFingerprint, currentReviewFingerprint,
      mutationFingerprint, mutations.length, actor.userId],
  }];
  for (let start = 0; start < serializedMutations.length; start += 250) {
    const chunk = serializedMutations.slice(start, start + 250);
    statements.push({
      sql: `
        INSERT INTO local801.protected_import_execution_mutations (
          organization_id, execution_set_id, import_row_id, target_person_id, mutation_kind,
          operational_json, person_protected_json, identifier_protected_json,
          contact_protected_json, exact_indexes_json, search_tokens_json, mutation_hash
        )
        SELECT source.organization_id::uuid, source.execution_set_id::uuid, source.import_row_id::uuid,
          source.target_person_id::uuid, source.mutation_kind, source.operational_json,
          source.person_protected_json, source.identifier_protected_json,
          source.contact_protected_json, source.exact_indexes_json, source.search_tokens_json, source.mutation_hash
        FROM jsonb_to_recordset($1::text::jsonb) AS source(
          organization_id text, execution_set_id text, import_row_id text, target_person_id text, mutation_kind text,
          operational_json jsonb, person_protected_json jsonb, identifier_protected_json jsonb,
          contact_protected_json jsonb, exact_indexes_json jsonb, search_tokens_json jsonb, mutation_hash text
        )
      `,
      parameters: [JSON.stringify(chunk)],
    });
  }
  await transaction(statements);
  return { executionSetId, mutationFingerprint, mutationCount: mutations.length, sourceFingerprint, reviewFingerprint: currentReviewFingerprint };
}

export const __testing = { canonical, operationalOnly, prepareTargetMutation, reviewFingerprint };
