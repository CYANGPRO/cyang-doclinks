import postgres from "postgres";
import {
  buildSyntheticPiiBackfillPlan,
  DIRECT_IMPORT_PII_FIELDS,
  MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY,
} from "../src/lib/pii-backfill.ts";
import {
  createPiiIntegrityHash,
  decryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiNameForSearch,
} from "../src/lib/pii-protection.ts";

const databaseUrl = process.env.LOCAL801_DATABASE_URL;

function fail(message) {
  console.error(`PII reconciliation blocked: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

if (!databaseUrl) fail("LOCAL801_DATABASE_URL is required.");
if (process.env.VERCEL_ENV === "production") fail("Vercel Production is never allowed.");
if (process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") fail("production launch must remain disabled.");
if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") fail("protected-only mode must remain disabled during reconciliation.");
if (process.env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1") fail("authoritative import execution must remain disabled during reconciliation.");
if (process.env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1") fail("LOCAL801_PII_DUAL_WRITE_ENABLED must be 1 in this shell.");
if (process.env.LOCAL801_PII_BACKFILL_ENABLED === "1") fail("the backfill maintenance gate must be off during reconciliation.");

const keyConfig = getPiiKeyConfiguration(process.env);
const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });

function bounded(rows, name) {
  if (rows.length > MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY) fail(`${name} exceeds the bounded synthetic reconciliation limit.`);
  return rows;
}

function stableObjectJson(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function directImportPii(value) {
  const result = {};
  for (const key of DIRECT_IMPORT_PII_FIELDS) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim() !== "") result[key] = raw;
  }
  return result;
}

function encryptedValue(row, payloadColumn, keyColumn, formatColumn) {
  return {
    encryptedPayload: row[payloadColumn],
    encryptionKeyVersion: row[keyColumn],
    encryptionFormatVersion: Number(row[formatColumn]),
  };
}

function decryptSafely(value, context) {
  try {
    return { ok: true, value: decryptPiiField(value, context, keyConfig) };
  } catch {
    return { ok: false, value: null };
  }
}

function checkPlaintext(value, expected) {
  return value.ok && value.value === expected;
}

function compareRecordSets(sourceRows, protectedRows, sourceKey, protectedKey, compare) {
  const protectedById = new Map(protectedRows.map((row) => [row[protectedKey], row]));
  const seen = new Set();
  let mismatches = 0;
  for (const source of sourceRows) {
    const id = source[sourceKey];
    const protectedRow = protectedById.get(id);
    if (!protectedRow) {
      mismatches += 1;
      continue;
    }
    seen.add(id);
    try {
      if (!compare(source, protectedRow)) mismatches += 1;
    } catch {
      mismatches += 1;
    }
  }
  for (const id of protectedById.keys()) {
    if (!seen.has(id)) mismatches += 1;
  }
  return mismatches;
}

function expectedExactIndexSet(plan) {
  return new Set(plan.exactIndexes.map((row) => [
    row.entityType,
    row.entityId,
    row.domain,
    row.keyVersion,
    row.hash,
  ].join("|")));
}

function actualExactIndexSet(rows) {
  return new Set(rows.map((row) => [
    row.entity_type,
    row.entity_id,
    row.index_domain,
    row.index_key_version,
    row.index_hash,
  ].join("|")));
}

function expectedSearchTokenSet(plan) {
  return new Set(plan.searchTokens.map((row) => [
    row.personId,
    row.tokenDomain,
    row.tokenKind,
    row.keyVersion,
    row.hash,
  ].join("|")));
}

function actualSearchTokenSet(rows) {
  return new Set(rows.map((row) => [
    row.person_id,
    row.token_domain,
    row.token_kind,
    row.token_key_version,
    row.token_hash,
  ].join("|")));
}

function symmetricDifferenceCount(a, b) {
  let count = 0;
  for (const value of a) if (!b.has(value)) count += 1;
  for (const value of b) if (!a.has(value)) count += 1;
  return count;
}

async function loadDataset(db, organizationId) {
  const limit = MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY + 1;
  const [users, authIdentities, people, identifiers, contacts, corrections, importFiles, importRows, pushSubscriptions] = await Promise.all([
    db`select id::text, organization_id::text, email, display_name from local801.users where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, provider_subject, linked_email from local801.auth_identities where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, first_name, last_name, preferred_name from local801.people where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, identifier_type, identifier_value from local801.person_identifiers where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, contact_type, contact_value from local801.person_contact_methods where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, proposed_value from local801.contact_correction_requests where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, original_filename from local801.import_files where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, normalized_json from local801.import_rows where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    db`select id::text, organization_id::text, subscription_json from local801.push_subscriptions where organization_id=${organizationId}::uuid order by id limit ${limit}`,
  ]);
  return {
    users: bounded(users, "users"),
    authIdentities: bounded(authIdentities, "auth identities"),
    people: bounded(people, "people"),
    identifiers: bounded(identifiers, "identifiers"),
    contacts: bounded(contacts, "contacts"),
    corrections: bounded(corrections, "corrections"),
    importFiles: bounded(importFiles, "import files"),
    importRows: bounded(importRows, "import rows"),
    pushSubscriptions: bounded(pushSubscriptions, "push subscriptions"),
  };
}

async function loadProtected(db, organizationId) {
  const limit = MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY + 1;
  const [users, authIdentities, people, identifiers, contacts, corrections, importFiles, importRows, pushSubscriptions, exactIndexes, searchTokens] = await Promise.all([
    db`select user_id::text, email_encrypted_payload, email_encryption_key_version, email_encryption_format_version, display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version from local801.user_pii where organization_id=${organizationId}::uuid order by user_id limit ${limit}`,
    db`select auth_identity_id::text, provider_subject_encrypted_payload, provider_subject_encryption_key_version, provider_subject_encryption_format_version, linked_email_encrypted_payload, linked_email_encryption_key_version, linked_email_encryption_format_version from local801.auth_identity_pii where organization_id=${organizationId}::uuid order by auth_identity_id limit ${limit}`,
    db`select person_id::text, first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version, last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version, preferred_name_encrypted_payload, preferred_name_encryption_key_version, preferred_name_encryption_format_version, name_sort_encrypted_payload, name_sort_encryption_key_version, name_sort_encryption_format_version from local801.person_pii where organization_id=${organizationId}::uuid order by person_id limit ${limit}`,
    db`select person_identifier_id::text, identifier_value_encrypted_payload, encryption_key_version, encryption_format_version from local801.person_identifier_pii where organization_id=${organizationId}::uuid order by person_identifier_id limit ${limit}`,
    db`select contact_method_id::text, contact_value_encrypted_payload, encryption_key_version, encryption_format_version from local801.person_contact_method_pii where organization_id=${organizationId}::uuid order by contact_method_id limit ${limit}`,
    db`select correction_request_id::text, proposed_value_encrypted_payload, encryption_key_version, encryption_format_version from local801.contact_correction_request_pii where organization_id=${organizationId}::uuid order by correction_request_id limit ${limit}`,
    db`select import_file_id::text, original_filename_encrypted_payload, encryption_key_version, encryption_format_version from local801.import_file_pii where organization_id=${organizationId}::uuid order by import_file_id limit ${limit}`,
    db`select import_row_id::text, direct_pii_encrypted_payload, encryption_key_version, encryption_format_version, direct_pii_field_set_version, direct_pii_presence_mask, direct_pii_validity_mask, row_integrity_hash, row_integrity_key_version from local801.import_row_pii where organization_id=${organizationId}::uuid order by import_row_id limit ${limit}`,
    db`select push_subscription_id::text, subscription_encrypted_payload, encryption_key_version, encryption_format_version from local801.push_subscription_pii where organization_id=${organizationId}::uuid order by push_subscription_id limit ${limit}`,
    db`select entity_type, entity_id::text, index_domain, index_key_version, index_hash from local801.pii_exact_indexes where organization_id=${organizationId}::uuid order by entity_type, entity_id, index_domain, index_key_version`,
    db`select person_id::text, token_domain, token_kind, token_key_version, token_hash from local801.person_search_tokens where organization_id=${organizationId}::uuid order by person_id, token_domain, token_kind, token_key_version, token_hash`,
  ]);
  return {
    users: bounded(users, "protected users"),
    authIdentities: bounded(authIdentities, "protected auth identities"),
    people: bounded(people, "protected people"),
    identifiers: bounded(identifiers, "protected identifiers"),
    contacts: bounded(contacts, "protected contacts"),
    corrections: bounded(corrections, "protected corrections"),
    importFiles: bounded(importFiles, "protected import files"),
    importRows: bounded(importRows, "protected import rows"),
    pushSubscriptions: bounded(pushSubscriptions, "protected push subscriptions"),
    exactIndexes: bounded(exactIndexes, "exact indexes"),
    searchTokens: bounded(searchTokens, "search tokens"),
  };
}

try {
  const result = await sql.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");

    const organizations = await tx`select id::text, slug from local801.organizations order by slug`;
    const preview = organizations.filter((row) => row.slug === "local801-preview");
    if (preview.length !== 1) fail("exactly one local801-preview organization is required.");
    const organizationId = preview[0].id;

    const [state] = await tx`
      select write_mode, backfill_state, backfill_completed_at,
        protected_read_enabled_at, protected_write_enabled_at, verified_at
      from local801.pii_protection_state
      where organization_id=${organizationId}::uuid
    `;
    if (!state || state.write_mode !== "dual") fail("write_mode must remain dual during reconciliation.");
    if (state.backfill_state !== "complete" || !state.backfill_completed_at) fail("the synthetic PII backfill must be complete before reconciliation.");
    if (state.protected_read_enabled_at || state.protected_write_enabled_at) fail("protected read/write cutover must remain disabled during reconciliation.");
    if (state.verified_at) fail("verified_at must remain unset until the protected-read acceptance stage.");

    const dataset = await loadDataset(tx, organizationId);
    const protectedData = await loadProtected(tx, organizationId);
    const plan = buildSyntheticPiiBackfillPlan(dataset, keyConfig);
    const plannedImportRowsById = new Map(
      plan.importRows.map((row) => [row.importRowId, row]),
    );

    const recordMismatches = {
      users: compareRecordSets(dataset.users, protectedData.users, "id", "user_id", (source, row) => {
        const email = decryptSafely(encryptedValue(row, "email_encrypted_payload", "email_encryption_key_version", "email_encryption_format_version"), { organizationId, entity: "user", recordId: source.id, field: "email" });
        const displayName = decryptSafely(encryptedValue(row, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"), { organizationId, entity: "user", recordId: source.id, field: "display-name" });
        return checkPlaintext(email, source.email) && checkPlaintext(displayName, source.display_name);
      }),
      authIdentities: compareRecordSets(dataset.authIdentities, protectedData.authIdentities, "id", "auth_identity_id", (source, row) => {
        const subject = decryptSafely(encryptedValue(row, "provider_subject_encrypted_payload", "provider_subject_encryption_key_version", "provider_subject_encryption_format_version"), { organizationId, entity: "auth-identity", recordId: source.id, field: "provider-subject" });
        const email = decryptSafely(encryptedValue(row, "linked_email_encrypted_payload", "linked_email_encryption_key_version", "linked_email_encryption_format_version"), { organizationId, entity: "auth-identity", recordId: source.id, field: "linked-email" });
        return checkPlaintext(subject, source.provider_subject) && checkPlaintext(email, source.linked_email);
      }),
      people: compareRecordSets(dataset.people, protectedData.people, "id", "person_id", (source, row) => {
        const first = decryptSafely(encryptedValue(row, "first_name_encrypted_payload", "first_name_encryption_key_version", "first_name_encryption_format_version"), { organizationId, entity: "person", recordId: source.id, field: "first-name" });
        const last = decryptSafely(encryptedValue(row, "last_name_encrypted_payload", "last_name_encryption_key_version", "last_name_encryption_format_version"), { organizationId, entity: "person", recordId: source.id, field: "last-name" });
        const sort = decryptSafely(encryptedValue(row, "name_sort_encrypted_payload", "name_sort_encryption_key_version", "name_sort_encryption_format_version"), { organizationId, entity: "person", recordId: source.id, field: "name-sort" });
        const expectedSort = normalizePiiNameForSearch(`${source.last_name} ${source.first_name}${source.preferred_name ? ` ${source.preferred_name}` : ""}`);
        let preferredMatches = false;
        if (source.preferred_name === null) {
          preferredMatches = row.preferred_name_encrypted_payload === null
            && row.preferred_name_encryption_key_version === null
            && row.preferred_name_encryption_format_version === null;
        } else {
          const preferred = decryptSafely(encryptedValue(row, "preferred_name_encrypted_payload", "preferred_name_encryption_key_version", "preferred_name_encryption_format_version"), { organizationId, entity: "person", recordId: source.id, field: "preferred-name" });
          preferredMatches = checkPlaintext(preferred, source.preferred_name);
        }
        return checkPlaintext(first, source.first_name)
          && checkPlaintext(last, source.last_name)
          && preferredMatches
          && checkPlaintext(sort, expectedSort);
      }),
      identifiers: compareRecordSets(dataset.identifiers, protectedData.identifiers, "id", "person_identifier_id", (source, row) => {
        const value = decryptSafely(encryptedValue(row, "identifier_value_encrypted_payload", "encryption_key_version", "encryption_format_version"), { organizationId, entity: "person-identifier", recordId: source.id, field: "identifier-value" });
        return checkPlaintext(value, source.identifier_value);
      }),
      contacts: compareRecordSets(dataset.contacts, protectedData.contacts, "id", "contact_method_id", (source, row) => {
        const value = decryptSafely(encryptedValue(row, "contact_value_encrypted_payload", "encryption_key_version", "encryption_format_version"), { organizationId, entity: "person-contact", recordId: source.id, field: "contact-value" });
        return checkPlaintext(value, source.contact_value);
      }),
      corrections: compareRecordSets(dataset.corrections, protectedData.corrections, "id", "correction_request_id", (source, row) => {
        const value = decryptSafely(encryptedValue(row, "proposed_value_encrypted_payload", "encryption_key_version", "encryption_format_version"), { organizationId, entity: "correction-request", recordId: source.id, field: "proposed-value" });
        return checkPlaintext(value, source.proposed_value);
      }),
      importFiles: compareRecordSets(dataset.importFiles, protectedData.importFiles, "id", "import_file_id", (source, row) => {
        const value = decryptSafely(encryptedValue(row, "original_filename_encrypted_payload", "encryption_key_version", "encryption_format_version"), { organizationId, entity: "import-file", recordId: source.id, field: "original-filename" });
        return checkPlaintext(value, source.original_filename);
      }),
      importRows: compareRecordSets(dataset.importRows, protectedData.importRows, "id", "import_row_id", (source, row) => {
        const planned = plannedImportRowsById.get(source.id);
        if (!planned) return false;
        const canonical = stableObjectJson(directImportPii(source.normalized_json));
        const value = decryptSafely(encryptedValue(row, "direct_pii_encrypted_payload", "encryption_key_version", "encryption_format_version"), { organizationId, entity: "import-row", recordId: source.id, field: "direct-pii" });
        const integrity = createPiiIntegrityHash(canonical, { organizationId, domain: "import-row", keyVersion: row.row_integrity_key_version }, keyConfig);
        return Number(row.direct_pii_field_set_version) === Number(planned.fieldSetVersion)
          && Number(row.direct_pii_presence_mask) === Number(planned.presenceMask)
          && Number(row.direct_pii_validity_mask) === Number(planned.validityMask)
          && checkPlaintext(value, canonical)
          && integrity.blindIndex === row.row_integrity_hash
          && integrity.blindIndexKeyVersion === row.row_integrity_key_version
          && row.row_integrity_hash === planned.integrityHash
          && row.row_integrity_key_version === planned.integrityKeyVersion;
      }),
      pushSubscriptions: compareRecordSets(dataset.pushSubscriptions, protectedData.pushSubscriptions, "id", "push_subscription_id", (source, row) => {
        const value = decryptSafely(encryptedValue(row, "subscription_encrypted_payload", "encryption_key_version", "encryption_format_version"), { organizationId, entity: "push-subscription", recordId: source.id, field: "subscription" });
        return checkPlaintext(value, JSON.stringify(source.subscription_json));
      }),
    };

    const exactIndexMismatches = symmetricDifferenceCount(expectedExactIndexSet(plan), actualExactIndexSet(protectedData.exactIndexes));
    const searchTokenMismatches = symmetricDifferenceCount(expectedSearchTokenSet(plan), actualSearchTokenSet(protectedData.searchTokens));
    const totalRecordMismatches = Object.values(recordMismatches).reduce((sum, value) => sum + value, 0);
    const totalMismatches = totalRecordMismatches + exactIndexMismatches + searchTokenMismatches;

    return {
      organization: "local801-preview",
      mode: "read-only-reconciliation",
      sourceCounts: plan.sourceCounts,
      protectedCounts: {
        users: protectedData.users.length,
        authIdentities: protectedData.authIdentities.length,
        people: protectedData.people.length,
        identifiers: protectedData.identifiers.length,
        contacts: protectedData.contacts.length,
        corrections: protectedData.corrections.length,
        importFiles: protectedData.importFiles.length,
        importRows: protectedData.importRows.length,
        pushSubscriptions: protectedData.pushSubscriptions.length,
        exactIndexes: protectedData.exactIndexes.length,
        searchTokens: protectedData.searchTokens.length,
      },
      recordMismatches,
      derivativeMismatches: {
        exactIndexes: exactIndexMismatches,
        searchTokens: searchTokenMismatches,
      },
      totalMismatches,
      backfillComplete: true,
      protectedReadsEnabled: false,
      protectedWritesEnabled: false,
      databaseMutations: 0,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.totalMismatches !== 0) fail(`protected PII reconciliation found ${result.totalMismatches} mismatch(es).`);
  console.log("Protected PII reconciliation passed; no database rows were changed.");
} finally {
  await sql.end({ timeout: 3 });
}
