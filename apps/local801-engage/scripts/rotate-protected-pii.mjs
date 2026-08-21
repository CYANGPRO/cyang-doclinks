import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { buildSyntheticPiiBackfillPlan, MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY } from "../src/lib/pii-backfill.ts";
import {
  serializeBackfillAuthIdentity,
  serializeBackfillExactIndex,
  serializeBackfillImportRow,
  serializeBackfillPerson,
  serializeBackfillSearchToken,
  serializeBackfillSimple,
  serializeBackfillUser,
} from "../src/lib/pii-backfill-serialization.ts";
import { decryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const apply = process.argv.includes("--apply");
const verify = process.argv.includes("--verify");
const retire = process.argv.includes("--retire-old-indexes");
const selectedModes = Number(apply) + Number(verify) + Number(retire);
const databaseUrl = process.env.LOCAL801_DATABASE_URL;
const organizationSlug = process.env.LOCAL801_PII_ROTATION_ORGANIZATION_SLUG;
const actorUserId = process.env.LOCAL801_PII_ROTATION_ACTOR_USER_ID;
const fromEncryptionVersion = process.env.LOCAL801_PII_ROTATION_FROM_ENCRYPTION_KEY_VERSION;
const fromBlindVersion = process.env.LOCAL801_PII_ROTATION_FROM_BLIND_INDEX_KEY_VERSION;
const confirm = process.env.LOCAL801_PII_ROTATION_CONFIRM;

function fail(message) {
  throw new Error(`Protected PII rotation blocked: ${message}`);
}

if (selectedModes > 1) fail("choose only one of --apply, --verify, or --retire-old-indexes.");
if (!databaseUrl) fail("LOCAL801_DATABASE_URL is required.");
if (!organizationSlug || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(organizationSlug)) fail("an explicit organization slug is required.");
if (!fromEncryptionVersion || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(fromEncryptionVersion)) fail("the source encryption key version is required.");
if (!fromBlindVersion || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(fromBlindVersion)) fail("the source blind-index key version is required.");
if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1") fail("protected-only database mode is required.");
if (process.env.LOCAL801_PII_DUAL_WRITE_ENABLED === "1") fail("dual-write must be disabled.");
if (process.env.LOCAL801_PII_BACKFILL_ENABLED === "1") fail("the backfill maintenance gate must be disabled.");
if ((apply || verify || retire) && process.env.LOCAL801_PII_KEY_ROTATION_ENABLED !== "1") fail("LOCAL801_PII_KEY_ROTATION_ENABLED=1 is required.");
if ((apply || retire) && process.env.LOCAL801_PII_ROTATION_WRITES_QUIESCED !== "1") fail("application PII writes must be quiesced for the rotation write step.");
if ((apply || retire) && confirm !== "ROTATE_PROTECTED_PII") fail("the exact rotation confirmation phrase is required.");
if ((apply || retire) && (!actorUserId || !/^[0-9a-f-]{36}$/i.test(actorUserId))) fail("a rotation actor user UUID is required.");

const keyConfig = getPiiKeyConfiguration(process.env);
const targetEncryptionVersion = keyConfig.activeEncryptionKeyVersion;
const targetBlindVersion = keyConfig.activeBlindIndexKeyVersion;
if (!keyConfig.encryptionKeys.has(fromEncryptionVersion)) fail("the source encryption key must remain in the configured keyring.");
if (!keyConfig.blindIndexKeys.has(fromBlindVersion)) fail("the source blind-index key must remain in the configured keyring.");
if (targetEncryptionVersion === fromEncryptionVersion) fail("the active encryption key must be the new target version.");
if (targetBlindVersion === fromBlindVersion) fail("the active blind-index key must be the new target version.");

const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false, onnotice: () => {} });

function bounded(rows, label) {
  if (rows.length > MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY) fail(`${label} exceeds the bounded rotation limit.`);
  return rows;
}

function chunks(values, size = 250) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function encrypted(row, payload, version, format) {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[version];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    fail("a protected companion contains invalid encryption metadata.");
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 };
}

function decrypt(row, payload, version, format, context) {
  return decryptPiiField(encrypted(row, payload, version, format), context, keyConfig);
}

function safeJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${label} decrypted to invalid JSON.`);
  }
}

async function organization() {
  const rows = await sql`select id::text, slug from local801.organizations where slug=${organizationSlug} and archived_at is null`;
  if (rows.length !== 1) fail("exactly one active organization must match the requested slug.");
  return rows[0];
}

async function loadProtectedDataset(organizationId) {
  const limit = MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY + 1;
  const [users, authIdentities, people, identifiers, contacts, corrections, importFiles, importRows, pushSubscriptions] = await Promise.all([
    sql`select app.id::text, protected.* from local801.users app join local801.user_pii protected on protected.organization_id=app.organization_id and protected.user_id=app.id where app.organization_id=${organizationId}::uuid order by app.id limit ${limit}`,
    sql`select identity.id::text, identity.provider_id, protected.* from local801.auth_identities identity join local801.auth_identity_pii protected on protected.organization_id=identity.organization_id and protected.auth_identity_id=identity.id where identity.organization_id=${organizationId}::uuid order by identity.id limit ${limit}`,
    sql`select person.id::text, protected.* from local801.people person join local801.person_pii protected on protected.organization_id=person.organization_id and protected.person_id=person.id where person.organization_id=${organizationId}::uuid order by person.id limit ${limit}`,
    sql`select identifier.id::text, identifier.identifier_type, protected.* from local801.person_identifiers identifier join local801.person_identifier_pii protected on protected.organization_id=identifier.organization_id and protected.person_identifier_id=identifier.id where identifier.organization_id=${organizationId}::uuid order by identifier.id limit ${limit}`,
    sql`select contact.id::text, contact.contact_type, protected.* from local801.person_contact_methods contact join local801.person_contact_method_pii protected on protected.organization_id=contact.organization_id and protected.contact_method_id=contact.id where contact.organization_id=${organizationId}::uuid order by contact.id limit ${limit}`,
    sql`select correction.id::text, protected.* from local801.contact_correction_requests correction join local801.contact_correction_request_pii protected on protected.organization_id=correction.organization_id and protected.correction_request_id=correction.id where correction.organization_id=${organizationId}::uuid order by correction.id limit ${limit}`,
    sql`select file.id::text, protected.* from local801.import_files file join local801.import_file_pii protected on protected.organization_id=file.organization_id and protected.import_file_id=file.id where file.organization_id=${organizationId}::uuid order by file.id limit ${limit}`,
    sql`select import_row.id::text, import_row.normalized_json, protected.* from local801.import_rows import_row join local801.import_row_pii protected on protected.organization_id=import_row.organization_id and protected.import_row_id=import_row.id where import_row.organization_id=${organizationId}::uuid order by import_row.id limit ${limit}`,
    sql`select subscription.id::text, protected.* from local801.push_subscriptions subscription join local801.push_subscription_pii protected on protected.organization_id=subscription.organization_id and protected.push_subscription_id=subscription.id where subscription.organization_id=${organizationId}::uuid order by subscription.id limit ${limit}`,
  ]);

  for (const [label, rows] of Object.entries({ users, authIdentities, people, identifiers, contacts, corrections, importFiles, importRows, pushSubscriptions })) bounded(rows, label);

  return {
    users: users.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      email: decrypt(row, "email_encrypted_payload", "email_encryption_key_version", "email_encryption_format_version", { organizationId, entity: "user", recordId: row.id, field: "email" }),
      display_name: decrypt(row, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version", { organizationId, entity: "user", recordId: row.id, field: "display-name" }),
    })),
    authIdentities: authIdentities.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      provider_id: row.provider_id,
      provider_subject: decrypt(row, "provider_subject_encrypted_payload", "provider_subject_encryption_key_version", "provider_subject_encryption_format_version", { organizationId, entity: "auth-identity", recordId: row.id, field: "provider-subject" }),
      linked_email: decrypt(row, "linked_email_encrypted_payload", "linked_email_encryption_key_version", "linked_email_encryption_format_version", { organizationId, entity: "auth-identity", recordId: row.id, field: "linked-email" }),
    })),
    people: people.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      first_name: decrypt(row, "first_name_encrypted_payload", "first_name_encryption_key_version", "first_name_encryption_format_version", { organizationId, entity: "person", recordId: row.id, field: "first-name" }),
      last_name: decrypt(row, "last_name_encrypted_payload", "last_name_encryption_key_version", "last_name_encryption_format_version", { organizationId, entity: "person", recordId: row.id, field: "last-name" }),
      preferred_name: row.preferred_name_encrypted_payload == null ? null : decrypt(row, "preferred_name_encrypted_payload", "preferred_name_encryption_key_version", "preferred_name_encryption_format_version", { organizationId, entity: "person", recordId: row.id, field: "preferred-name" }),
    })),
    identifiers: identifiers.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      identifier_type: row.identifier_type,
      identifier_value: decrypt(row, "identifier_value_encrypted_payload", "encryption_key_version", "encryption_format_version", { organizationId, entity: "person-identifier", recordId: row.id, field: "identifier-value" }),
    })),
    contacts: contacts.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      contact_type: row.contact_type,
      contact_value: decrypt(row, "contact_value_encrypted_payload", "encryption_key_version", "encryption_format_version", { organizationId, entity: "person-contact", recordId: row.id, field: "contact-value" }),
    })),
    corrections: corrections.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      proposed_value: decrypt(row, "proposed_value_encrypted_payload", "encryption_key_version", "encryption_format_version", { organizationId, entity: "correction-request", recordId: row.id, field: "proposed-value" }),
    })),
    importFiles: importFiles.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      original_filename: decrypt(row, "original_filename_encrypted_payload", "encryption_key_version", "encryption_format_version", { organizationId, entity: "import-file", recordId: row.id, field: "original-filename" }),
    })),
    importRows: importRows.map((row) => {
      const direct = safeJson(decrypt(row, "direct_pii_encrypted_payload", "encryption_key_version", "encryption_format_version", { organizationId, entity: "import-row", recordId: row.id, field: "direct-pii" }), "import-row direct PII");
      if (!direct || typeof direct !== "object" || Array.isArray(direct)) fail("import-row direct PII bundle must be an object.");
      return { id: row.id, organization_id: organizationId, normalized_json: { ...(row.normalized_json ?? {}), ...direct } };
    }),
    pushSubscriptions: pushSubscriptions.map((row) => ({
      id: row.id,
      organization_id: organizationId,
      subscription_json: safeJson(decrypt(row, "subscription_encrypted_payload", "encryption_key_version", "encryption_format_version", { organizationId, entity: "push-subscription", recordId: row.id, field: "subscription" }), "push subscription"),
    })),
  };
}

function plannedCounts(plan) {
  return {
    users: plan.users.length,
    authIdentities: plan.authIdentities.length,
    people: plan.people.length,
    identifiers: plan.identifiers.length,
    contacts: plan.contacts.length,
    corrections: plan.corrections.length,
    importFiles: plan.importFiles.length,
    importRows: plan.importRows.length,
    pushSubscriptions: plan.pushSubscriptions.length,
    exactIndexes: plan.exactIndexes.length,
    searchTokens: plan.searchTokens.length,
  };
}

async function versionCoverage(organizationId, db = sql) {
  const [row] = await db`
    select
      (select count(*)::int from local801.user_pii where organization_id=${organizationId}::uuid) as users,
      (select count(*)::int from local801.user_pii where organization_id=${organizationId}::uuid and email_encryption_key_version=${targetEncryptionVersion} and display_name_encryption_key_version=${targetEncryptionVersion}) as users_target,
      (select count(*)::int from local801.auth_identity_pii where organization_id=${organizationId}::uuid) as auth_identities,
      (select count(*)::int from local801.auth_identity_pii where organization_id=${organizationId}::uuid and provider_subject_encryption_key_version=${targetEncryptionVersion} and linked_email_encryption_key_version=${targetEncryptionVersion}) as auth_identities_target,
      (select count(*)::int from local801.person_pii where organization_id=${organizationId}::uuid) as people,
      (select count(*)::int from local801.person_pii where organization_id=${organizationId}::uuid and first_name_encryption_key_version=${targetEncryptionVersion} and last_name_encryption_key_version=${targetEncryptionVersion} and name_sort_encryption_key_version=${targetEncryptionVersion} and (preferred_name_encrypted_payload is null or preferred_name_encryption_key_version=${targetEncryptionVersion})) as people_target,
      (select count(*)::int from local801.person_identifier_pii where organization_id=${organizationId}::uuid) as identifiers,
      (select count(*)::int from local801.person_identifier_pii where organization_id=${organizationId}::uuid and encryption_key_version=${targetEncryptionVersion}) as identifiers_target,
      (select count(*)::int from local801.person_contact_method_pii where organization_id=${organizationId}::uuid) as contacts,
      (select count(*)::int from local801.person_contact_method_pii where organization_id=${organizationId}::uuid and encryption_key_version=${targetEncryptionVersion}) as contacts_target,
      (select count(*)::int from local801.contact_correction_request_pii where organization_id=${organizationId}::uuid) as corrections,
      (select count(*)::int from local801.contact_correction_request_pii where organization_id=${organizationId}::uuid and encryption_key_version=${targetEncryptionVersion}) as corrections_target,
      (select count(*)::int from local801.import_file_pii where organization_id=${organizationId}::uuid) as import_files,
      (select count(*)::int from local801.import_file_pii where organization_id=${organizationId}::uuid and encryption_key_version=${targetEncryptionVersion}) as import_files_target,
      (select count(*)::int from local801.import_row_pii where organization_id=${organizationId}::uuid) as import_rows,
      (select count(*)::int from local801.import_row_pii where organization_id=${organizationId}::uuid and encryption_key_version=${targetEncryptionVersion} and row_integrity_key_version=${targetBlindVersion}) as import_rows_target,
      (select count(*)::int from local801.push_subscription_pii where organization_id=${organizationId}::uuid) as push_subscriptions,
      (select count(*)::int from local801.push_subscription_pii where organization_id=${organizationId}::uuid and encryption_key_version=${targetEncryptionVersion}) as push_subscriptions_target,
      (select count(*)::int from local801.pii_exact_indexes where organization_id=${organizationId}::uuid and index_key_version=${targetBlindVersion}) as exact_indexes_target,
      (select count(*)::int from local801.person_search_tokens where organization_id=${organizationId}::uuid and token_key_version=${targetBlindVersion}) as search_tokens_target
  `;
  return row;
}

function assertCoverage(coverage, plan) {
  const expected = plannedCounts(plan);
  for (const [key, value] of Object.entries({
    users: expected.users,
    auth_identities: expected.authIdentities,
    people: expected.people,
    identifiers: expected.identifiers,
    contacts: expected.contacts,
    corrections: expected.corrections,
    import_files: expected.importFiles,
    import_rows: expected.importRows,
    push_subscriptions: expected.pushSubscriptions,
  })) {
    if (Number(coverage[key]) !== value || Number(coverage[`${key}_target`]) !== value) fail(`target encryption coverage failed for ${key}.`);
  }
  if (Number(coverage.exact_indexes_target) !== expected.exactIndexes) fail("target blind-index coverage does not reconcile.");
  if (Number(coverage.search_tokens_target) !== expected.searchTokens) fail("target name-search token coverage does not reconcile.");
}

async function upsertPlan(tx, organizationId, plan) {
  for (const group of chunks(plan.users.map((row) => serializeBackfillUser(row)))) {
    await tx.unsafe(`insert into local801.user_pii (organization_id,user_id,email_encrypted_payload,email_encryption_key_version,email_encryption_format_version,display_name_encrypted_payload,display_name_encryption_key_version,display_name_encryption_format_version,updated_at)
      select x.organization_id::uuid,x.user_id::uuid,x.email_encrypted_payload,x.email_encryption_key_version,x.email_encryption_format_version,x.display_name_encrypted_payload,x.display_name_encryption_key_version,x.display_name_encryption_format_version,now()
      from jsonb_to_recordset($1::jsonb) x(organization_id text,user_id text,email_encrypted_payload text,email_encryption_key_version text,email_encryption_format_version int,display_name_encrypted_payload text,display_name_encryption_key_version text,display_name_encryption_format_version int)
      on conflict (organization_id,user_id) do update set email_encrypted_payload=excluded.email_encrypted_payload,email_encryption_key_version=excluded.email_encryption_key_version,email_encryption_format_version=excluded.email_encryption_format_version,display_name_encrypted_payload=excluded.display_name_encrypted_payload,display_name_encryption_key_version=excluded.display_name_encryption_key_version,display_name_encryption_format_version=excluded.display_name_encryption_format_version,updated_at=now()`, [JSON.stringify(group)]);
  }
  for (const group of chunks(plan.authIdentities.map((row) => serializeBackfillAuthIdentity(row)))) {
    await tx.unsafe(`insert into local801.auth_identity_pii (organization_id,auth_identity_id,provider_subject_encrypted_payload,provider_subject_encryption_key_version,provider_subject_encryption_format_version,linked_email_encrypted_payload,linked_email_encryption_key_version,linked_email_encryption_format_version,updated_at)
      select x.organization_id::uuid,x.auth_identity_id::uuid,x.provider_subject_encrypted_payload,x.provider_subject_encryption_key_version,x.provider_subject_encryption_format_version,x.linked_email_encrypted_payload,x.linked_email_encryption_key_version,x.linked_email_encryption_format_version,now()
      from jsonb_to_recordset($1::jsonb) x(organization_id text,auth_identity_id text,provider_subject_encrypted_payload text,provider_subject_encryption_key_version text,provider_subject_encryption_format_version int,linked_email_encrypted_payload text,linked_email_encryption_key_version text,linked_email_encryption_format_version int)
      on conflict (organization_id,auth_identity_id) do update set provider_subject_encrypted_payload=excluded.provider_subject_encrypted_payload,provider_subject_encryption_key_version=excluded.provider_subject_encryption_key_version,provider_subject_encryption_format_version=excluded.provider_subject_encryption_format_version,linked_email_encrypted_payload=excluded.linked_email_encrypted_payload,linked_email_encryption_key_version=excluded.linked_email_encryption_key_version,linked_email_encryption_format_version=excluded.linked_email_encryption_format_version,updated_at=now()`, [JSON.stringify(group)]);
  }
  for (const group of chunks(plan.people.map((row) => serializeBackfillPerson(row)))) {
    await tx.unsafe(`insert into local801.person_pii (organization_id,person_id,first_name_encrypted_payload,first_name_encryption_key_version,first_name_encryption_format_version,last_name_encrypted_payload,last_name_encryption_key_version,last_name_encryption_format_version,preferred_name_encrypted_payload,preferred_name_encryption_key_version,preferred_name_encryption_format_version,name_sort_encrypted_payload,name_sort_encryption_key_version,name_sort_encryption_format_version,updated_at)
      select x.organization_id::uuid,x.person_id::uuid,x.first_name_encrypted_payload,x.first_name_encryption_key_version,x.first_name_encryption_format_version,x.last_name_encrypted_payload,x.last_name_encryption_key_version,x.last_name_encryption_format_version,x.preferred_name_encrypted_payload,x.preferred_name_encryption_key_version,x.preferred_name_encryption_format_version,x.name_sort_encrypted_payload,x.name_sort_encryption_key_version,x.name_sort_encryption_format_version,now()
      from jsonb_to_recordset($1::jsonb) x(organization_id text,person_id text,first_name_encrypted_payload text,first_name_encryption_key_version text,first_name_encryption_format_version int,last_name_encrypted_payload text,last_name_encryption_key_version text,last_name_encryption_format_version int,preferred_name_encrypted_payload text,preferred_name_encryption_key_version text,preferred_name_encryption_format_version int,name_sort_encrypted_payload text,name_sort_encryption_key_version text,name_sort_encryption_format_version int)
      on conflict (organization_id,person_id) do update set first_name_encrypted_payload=excluded.first_name_encrypted_payload,first_name_encryption_key_version=excluded.first_name_encryption_key_version,first_name_encryption_format_version=excluded.first_name_encryption_format_version,last_name_encrypted_payload=excluded.last_name_encrypted_payload,last_name_encryption_key_version=excluded.last_name_encryption_key_version,last_name_encryption_format_version=excluded.last_name_encryption_format_version,preferred_name_encrypted_payload=excluded.preferred_name_encrypted_payload,preferred_name_encryption_key_version=excluded.preferred_name_encryption_key_version,preferred_name_encryption_format_version=excluded.preferred_name_encryption_format_version,name_sort_encrypted_payload=excluded.name_sort_encrypted_payload,name_sort_encryption_key_version=excluded.name_sort_encryption_key_version,name_sort_encryption_format_version=excluded.name_sort_encryption_format_version,updated_at=now()`, [JSON.stringify(group)]);
  }
  const simple = [
    ["person_identifier_pii", "person_identifier_id", "identifier_value_encrypted_payload", "personIdentifierId", plan.identifiers],
    ["person_contact_method_pii", "contact_method_id", "contact_value_encrypted_payload", "contactMethodId", plan.contacts],
    ["contact_correction_request_pii", "correction_request_id", "proposed_value_encrypted_payload", "correctionRequestId", plan.corrections],
    ["import_file_pii", "import_file_id", "original_filename_encrypted_payload", "importFileId", plan.importFiles],
    ["push_subscription_pii", "push_subscription_id", "subscription_encrypted_payload", "pushSubscriptionId", plan.pushSubscriptions],
  ];
  for (const [table, idColumn, encryptedColumn, idKey, rows] of simple) {
    for (const group of chunks(rows.map((row) => serializeBackfillSimple(row, idKey)))) {
      await tx.unsafe(`insert into local801.${table} (organization_id,${idColumn},${encryptedColumn},encryption_key_version,encryption_format_version,updated_at)
        select x.organization_id::uuid,x.entity_id::uuid,x.encrypted_payload,x.encryption_key_version,x.encryption_format_version,now()
        from jsonb_to_recordset($1::jsonb) x(organization_id text,entity_id text,encrypted_payload text,encryption_key_version text,encryption_format_version int)
        on conflict (organization_id,${idColumn}) do update set ${encryptedColumn}=excluded.${encryptedColumn},encryption_key_version=excluded.encryption_key_version,encryption_format_version=excluded.encryption_format_version,updated_at=now()`, [JSON.stringify(group)]);
    }
  }
  for (const group of chunks(plan.importRows.map((row) => serializeBackfillImportRow(row)))) {
    await tx.unsafe(`insert into local801.import_row_pii (organization_id,import_row_id,direct_pii_encrypted_payload,encryption_key_version,encryption_format_version,direct_pii_field_set_version,direct_pii_presence_mask,direct_pii_validity_mask,row_integrity_hash,row_integrity_key_version,updated_at)
      select x.organization_id::uuid,x.import_row_id::uuid,x.encrypted_payload,x.encryption_key_version,x.encryption_format_version,x.field_set_version,x.presence_mask::smallint,x.validity_mask::smallint,x.integrity_hash,x.integrity_key_version,now()
      from jsonb_to_recordset($1::jsonb) x(organization_id text,import_row_id text,encrypted_payload text,encryption_key_version text,encryption_format_version int,field_set_version int,presence_mask int,validity_mask int,integrity_hash text,integrity_key_version text)
      on conflict (organization_id,import_row_id) do update set direct_pii_encrypted_payload=excluded.direct_pii_encrypted_payload,encryption_key_version=excluded.encryption_key_version,encryption_format_version=excluded.encryption_format_version,direct_pii_field_set_version=excluded.direct_pii_field_set_version,direct_pii_presence_mask=excluded.direct_pii_presence_mask,direct_pii_validity_mask=excluded.direct_pii_validity_mask,row_integrity_hash=excluded.row_integrity_hash,row_integrity_key_version=excluded.row_integrity_key_version,updated_at=now()`, [JSON.stringify(group)]);
  }

  await tx`delete from local801.pii_exact_indexes where organization_id=${organizationId}::uuid and index_key_version=${targetBlindVersion}`;
  for (const group of chunks(plan.exactIndexes.map((row) => serializeBackfillExactIndex(row)))) {
    await tx.unsafe(`insert into local801.pii_exact_indexes (organization_id,entity_type,entity_id,index_domain,index_key_version,index_hash)
      select x.organization_id::uuid,x.entity_type,x.entity_id::uuid,x.domain,x.key_version,x.hash
      from jsonb_to_recordset($1::jsonb) x(organization_id text,entity_type text,entity_id text,domain text,key_version text,hash text)`, [JSON.stringify(group)]);
  }
  await tx`delete from local801.person_search_tokens where organization_id=${organizationId}::uuid and token_key_version=${targetBlindVersion}`;
  for (const group of chunks(plan.searchTokens.map((row) => serializeBackfillSearchToken(row)))) {
    await tx.unsafe(`insert into local801.person_search_tokens (organization_id,person_id,token_domain,token_kind,token_key_version,token_hash)
      select x.organization_id::uuid,x.person_id::uuid,x.token_domain,x.token_kind,x.key_version,x.hash
      from jsonb_to_recordset($1::jsonb) x(organization_id text,person_id text,token_domain text,token_kind text,key_version text,hash text)`, [JSON.stringify(group)]);
  }
}

async function latestRun(organizationId, states) {
  const rows = await sql`select * from local801.pii_key_rotation_runs where organization_id=${organizationId}::uuid and from_encryption_key_version=${fromEncryptionVersion} and to_encryption_key_version=${targetEncryptionVersion} and from_blind_index_key_version=${fromBlindVersion} and to_blind_index_key_version=${targetBlindVersion} and state = any(${states}::text[]) order by started_at desc limit 1`;
  return rows[0] ?? null;
}

async function applyRotation(organizationId, plan) {
  const runId = randomUUID();
  await sql`insert into local801.pii_key_rotation_runs (id,organization_id,from_encryption_key_version,to_encryption_key_version,from_blind_index_key_version,to_blind_index_key_version,state,source_counts,started_by) values (${runId}::uuid,${organizationId}::uuid,${fromEncryptionVersion},${targetEncryptionVersion},${fromBlindVersion},${targetBlindVersion},'planned',${JSON.stringify(plan.sourceCounts)}::jsonb,${actorUserId}::uuid)`;
  try {
    await sql.begin(async (tx) => {
      const [state] = await tx`select write_mode,backfill_state,protected_read_enabled_at,protected_write_enabled_at,verified_at from local801.pii_protection_state where organization_id=${organizationId}::uuid for update`;
      if (!state || state.write_mode !== "protected" || state.backfill_state !== "complete" || !state.protected_read_enabled_at || !state.protected_write_enabled_at || !state.verified_at) fail("database protected-only state is incomplete.");
      const [run] = await tx`select state from local801.pii_key_rotation_runs where organization_id=${organizationId}::uuid and id=${runId}::uuid for update`;
      if (!run || run.state !== "planned") fail("rotation run is not in planned state.");
      await upsertPlan(tx, organizationId, plan);
      const coverage = await versionCoverage(organizationId, tx);
      assertCoverage(coverage, plan);
      await tx`update local801.pii_key_rotation_runs set state='applied',applied_at=now(),protected_counts=${JSON.stringify(plannedCounts(plan))}::jsonb,updated_at=now() where organization_id=${organizationId}::uuid and id=${runId}::uuid and state='planned'`;
    });
  } catch (error) {
    await sql`update local801.pii_key_rotation_runs set state='failed',failed_at=now(),failure_code='ROTATION_APPLY_FAILED',updated_at=now() where organization_id=${organizationId}::uuid and id=${runId}::uuid and state='planned'`;
    throw error;
  }
  return runId;
}

async function verifyRotation(organizationId, plan) {
  const run = await latestRun(organizationId, ["applied", "verified"]);
  if (!run) fail("no applied rotation run matches the requested key transition.");
  const coverage = await versionCoverage(organizationId);
  assertCoverage(coverage, plan);
  if (run.state === "applied") await sql`update local801.pii_key_rotation_runs set state='verified',verified_at=now(),protected_counts=${JSON.stringify(plannedCounts(plan))}::jsonb,updated_at=now() where organization_id=${organizationId}::uuid and id=${run.id}::uuid and state='applied'`;
  return run.id;
}

async function retireOldIndexes(organizationId) {
  const run = await latestRun(organizationId, ["verified"]);
  if (!run) fail("a verified rotation run is required before old blind-index retirement.");
  const oldEncryption = await sql`
    select
      (select count(*)::int from local801.user_pii where organization_id=${organizationId}::uuid and (email_encryption_key_version=${fromEncryptionVersion} or display_name_encryption_key_version=${fromEncryptionVersion}))
      + (select count(*)::int from local801.auth_identity_pii where organization_id=${organizationId}::uuid and (provider_subject_encryption_key_version=${fromEncryptionVersion} or linked_email_encryption_key_version=${fromEncryptionVersion}))
      + (select count(*)::int from local801.person_pii where organization_id=${organizationId}::uuid and (first_name_encryption_key_version=${fromEncryptionVersion} or last_name_encryption_key_version=${fromEncryptionVersion} or name_sort_encryption_key_version=${fromEncryptionVersion} or preferred_name_encryption_key_version=${fromEncryptionVersion}))
      + (select count(*)::int from local801.person_identifier_pii where organization_id=${organizationId}::uuid and encryption_key_version=${fromEncryptionVersion})
      + (select count(*)::int from local801.person_contact_method_pii where organization_id=${organizationId}::uuid and encryption_key_version=${fromEncryptionVersion})
      + (select count(*)::int from local801.contact_correction_request_pii where organization_id=${organizationId}::uuid and encryption_key_version=${fromEncryptionVersion})
      + (select count(*)::int from local801.import_file_pii where organization_id=${organizationId}::uuid and encryption_key_version=${fromEncryptionVersion})
      + (select count(*)::int from local801.import_row_pii where organization_id=${organizationId}::uuid and encryption_key_version=${fromEncryptionVersion})
      + (select count(*)::int from local801.push_subscription_pii where organization_id=${organizationId}::uuid and encryption_key_version=${fromEncryptionVersion}) as count
  `;
  if (Number(oldEncryption[0]?.count ?? 0) !== 0) fail("old encryption key is still referenced by protected companions.");
  await sql.begin(async (tx) => {
    await tx`delete from local801.pii_exact_indexes where organization_id=${organizationId}::uuid and index_key_version=${fromBlindVersion}`;
    await tx`delete from local801.person_search_tokens where organization_id=${organizationId}::uuid and token_key_version=${fromBlindVersion}`;
    await tx`update local801.pii_key_rotation_runs set state='retired',retired_at=now(),updated_at=now() where organization_id=${organizationId}::uuid and id=${run.id}::uuid and state='verified'`;
  });
  return run.id;
}

try {
  const org = await organization();
  const dataset = await loadProtectedDataset(org.id);
  const plan = buildSyntheticPiiBackfillPlan(dataset, keyConfig);
  const summary = {
    organization: org.slug,
    mode: apply ? "apply" : verify ? "verify" : retire ? "retire-old-indexes" : "dry-run",
    fromEncryptionVersion,
    targetEncryptionVersion,
    fromBlindVersion,
    targetBlindVersion,
    sourceCounts: plan.sourceCounts,
    plannedCounts: plannedCounts(plan),
    rawPiiLogged: false,
  };
  if (apply) summary.rotationRunId = await applyRotation(org.id, plan);
  else if (verify) summary.rotationRunId = await verifyRotation(org.id, plan);
  else if (retire) summary.rotationRunId = await retireOldIndexes(org.id);
  console.log(JSON.stringify(summary, null, 2));
  if (!selectedModes) console.log("Dry run only: no database rows were changed.");
} finally {
  await sql.end({ timeout: 3 });
}
