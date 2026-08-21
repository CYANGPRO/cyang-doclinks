import postgres from "postgres";
import { buildSyntheticPiiBackfillPlan, MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY } from "../src/lib/pii-backfill.ts";
import { getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const apply = process.argv.includes("--apply");
const dryRun = !apply;
const databaseUrl = process.env.LOCAL801_DATABASE_URL;

function fail(message) {
  console.error(`PII backfill blocked: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

if (!databaseUrl) fail("LOCAL801_DATABASE_URL is required.");
if (process.env.VERCEL_ENV === "production") fail("Vercel Production is never allowed.");
if (process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") fail("production launch must remain disabled.");
if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") fail("protected-only production mode must remain disabled during synthetic backfill.");
if (apply && process.env.LOCAL801_PII_BACKFILL_ENABLED !== "1") fail("--apply requires LOCAL801_PII_BACKFILL_ENABLED=1.");
if (apply && process.env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1") fail("--apply requires LOCAL801_PII_DUAL_WRITE_ENABLED=1 first.");

const keyConfig = getPiiKeyConfiguration(process.env);
const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });

function bounded(rows, name) {
  if (rows.length > MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY) fail(`${name} exceeds the bounded synthetic backfill limit.`);
  return rows;
}

function summary(plan, existing) {
  return {
    mode: dryRun ? "dry-run" : "apply",
    organization: "local801-preview",
    sourceCounts: plan.sourceCounts,
    plannedProtectedCounts: {
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
    },
    existingProtectedCounts: existing,
    protectedReadsEnabled: false,
  };
}

async function loadDataset(organizationId) {
  const limit = MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY + 1;
  const [users, authIdentities, people, identifiers, contacts, corrections, importFiles, importRows, pushSubscriptions] = await Promise.all([
    sql`select id::text, organization_id::text, email, display_name from local801.users where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, provider_subject, linked_email from local801.auth_identities where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, first_name, last_name, preferred_name from local801.people where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, identifier_type, identifier_value from local801.person_identifiers where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, contact_type, contact_value from local801.person_contact_methods where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, proposed_value from local801.contact_correction_requests where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, original_filename from local801.import_files where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, normalized_json from local801.import_rows where organization_id=${organizationId}::uuid order by id limit ${limit}`,
    sql`select id::text, organization_id::text, subscription_json from local801.push_subscriptions where organization_id=${organizationId}::uuid order by id limit ${limit}`,
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

async function existingCounts(organizationId) {
  const [row] = await sql`
    select
      (select count(*)::int from local801.user_pii where organization_id=${organizationId}::uuid) as users,
      (select count(*)::int from local801.auth_identity_pii where organization_id=${organizationId}::uuid) as auth_identities,
      (select count(*)::int from local801.person_pii where organization_id=${organizationId}::uuid) as people,
      (select count(*)::int from local801.person_identifier_pii where organization_id=${organizationId}::uuid) as identifiers,
      (select count(*)::int from local801.person_contact_method_pii where organization_id=${organizationId}::uuid) as contacts,
      (select count(*)::int from local801.contact_correction_request_pii where organization_id=${organizationId}::uuid) as corrections,
      (select count(*)::int from local801.import_file_pii where organization_id=${organizationId}::uuid) as import_files,
      (select count(*)::int from local801.import_row_pii where organization_id=${organizationId}::uuid) as import_rows,
      (select count(*)::int from local801.push_subscription_pii where organization_id=${organizationId}::uuid) as push_subscriptions,
      (select count(*)::int from local801.pii_exact_indexes where organization_id=${organizationId}::uuid) as exact_indexes,
      (select count(*)::int from local801.person_search_tokens where organization_id=${organizationId}::uuid) as search_tokens,
      (select count(*)::int from local801.pii_protection_state where organization_id=${organizationId}::uuid) as state_rows
  `;
  return row;
}

function chunks(values, size = 250) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function applyPlan(organizationId, plan) {
  await sql.begin(async (tx) => {
    const [state] = await tx`
      select write_mode, backfill_state, protected_read_enabled_at, protected_write_enabled_at
      from local801.pii_protection_state
      where organization_id=${organizationId}::uuid
      for update
    `;
    if (!state || state.write_mode !== "dual") throw new Error("PII backfill apply requires pii_protection_state.write_mode='dual'.");
    if (state.protected_read_enabled_at || state.protected_write_enabled_at) throw new Error("Protected read/write cutover must remain disabled during backfill.");

    await tx`update local801.pii_protection_state set backfill_state='running', backfill_completed_at=null, verified_at=null, updated_at=now() where organization_id=${organizationId}::uuid`;

    for (const group of chunks(plan.users)) {
      await tx`
        insert into local801.user_pii (
          organization_id,user_id,email_encrypted_payload,email_encryption_key_version,email_encryption_format_version,
          display_name_encrypted_payload,display_name_encryption_key_version,display_name_encryption_format_version,updated_at
        ) select x.organization_id::uuid,x.user_id::uuid,x.email_encrypted_payload,x.email_encryption_key_version,x.email_encryption_format_version,
          x.display_name_encrypted_payload,x.display_name_encryption_key_version,x.display_name_encryption_format_version,now()
        from jsonb_to_recordset(${JSON.stringify(group)}::jsonb) as x(
          organization_id text,user_id text,email_encrypted_payload text,email_encryption_key_version text,email_encryption_format_version int,
          display_name_encrypted_payload text,display_name_encryption_key_version text,display_name_encryption_format_version int)
        on conflict (organization_id,user_id) do update set
          email_encrypted_payload=excluded.email_encrypted_payload,email_encryption_key_version=excluded.email_encryption_key_version,email_encryption_format_version=excluded.email_encryption_format_version,
          display_name_encrypted_payload=excluded.display_name_encrypted_payload,display_name_encryption_key_version=excluded.display_name_encryption_key_version,display_name_encryption_format_version=excluded.display_name_encryption_format_version,updated_at=now()
      `;
    }

    for (const group of chunks(plan.authIdentities)) {
      await tx`
        insert into local801.auth_identity_pii (
          organization_id,auth_identity_id,provider_subject_encrypted_payload,provider_subject_encryption_key_version,provider_subject_encryption_format_version,
          linked_email_encrypted_payload,linked_email_encryption_key_version,linked_email_encryption_format_version,updated_at
        ) select x.organization_id::uuid,x.auth_identity_id::uuid,x.provider_subject_encrypted_payload,x.provider_subject_encryption_key_version,x.provider_subject_encryption_format_version,
          x.linked_email_encrypted_payload,x.linked_email_encryption_key_version,x.linked_email_encryption_format_version,now()
        from jsonb_to_recordset(${JSON.stringify(group)}::jsonb) as x(
          organization_id text,auth_identity_id text,provider_subject_encrypted_payload text,provider_subject_encryption_key_version text,provider_subject_encryption_format_version int,
          linked_email_encrypted_payload text,linked_email_encryption_key_version text,linked_email_encryption_format_version int)
        on conflict (organization_id,auth_identity_id) do update set
          provider_subject_encrypted_payload=excluded.provider_subject_encrypted_payload,provider_subject_encryption_key_version=excluded.provider_subject_encryption_key_version,provider_subject_encryption_format_version=excluded.provider_subject_encryption_format_version,
          linked_email_encrypted_payload=excluded.linked_email_encrypted_payload,linked_email_encryption_key_version=excluded.linked_email_encryption_key_version,linked_email_encryption_format_version=excluded.linked_email_encryption_format_version,updated_at=now()
      `;
    }

    for (const group of chunks(plan.people)) {
      await tx`
        insert into local801.person_pii (
          organization_id,person_id,first_name_encrypted_payload,first_name_encryption_key_version,first_name_encryption_format_version,
          last_name_encrypted_payload,last_name_encryption_key_version,last_name_encryption_format_version,
          preferred_name_encrypted_payload,preferred_name_encryption_key_version,preferred_name_encryption_format_version,
          name_sort_encrypted_payload,name_sort_encryption_key_version,name_sort_encryption_format_version,updated_at
        ) select x.organization_id::uuid,x.person_id::uuid,x.first_name_encrypted_payload,x.first_name_encryption_key_version,x.first_name_encryption_format_version,
          x.last_name_encrypted_payload,x.last_name_encryption_key_version,x.last_name_encryption_format_version,
          x.preferred_name_encrypted_payload,x.preferred_name_encryption_key_version,x.preferred_name_encryption_format_version,
          x.name_sort_encrypted_payload,x.name_sort_encryption_key_version,x.name_sort_encryption_format_version,now()
        from jsonb_to_recordset(${JSON.stringify(group)}::jsonb) as x(
          organization_id text,person_id text,first_name_encrypted_payload text,first_name_encryption_key_version text,first_name_encryption_format_version int,
          last_name_encrypted_payload text,last_name_encryption_key_version text,last_name_encryption_format_version int,
          preferred_name_encrypted_payload text,preferred_name_encryption_key_version text,preferred_name_encryption_format_version int,
          name_sort_encrypted_payload text,name_sort_encryption_key_version text,name_sort_encryption_format_version int)
        on conflict (organization_id,person_id) do update set
          first_name_encrypted_payload=excluded.first_name_encrypted_payload,first_name_encryption_key_version=excluded.first_name_encryption_key_version,first_name_encryption_format_version=excluded.first_name_encryption_format_version,
          last_name_encrypted_payload=excluded.last_name_encrypted_payload,last_name_encryption_key_version=excluded.last_name_encryption_key_version,last_name_encryption_format_version=excluded.last_name_encryption_format_version,
          preferred_name_encrypted_payload=excluded.preferred_name_encrypted_payload,preferred_name_encryption_key_version=excluded.preferred_name_encryption_key_version,preferred_name_encryption_format_version=excluded.preferred_name_encryption_format_version,
          name_sort_encrypted_payload=excluded.name_sort_encrypted_payload,name_sort_encryption_key_version=excluded.name_sort_encryption_key_version,name_sort_encryption_format_version=excluded.name_sort_encryption_format_version,updated_at=now()
      `;
    }

    const simpleCompanions = [
      ["person_identifier_pii", "person_identifier_id", plan.identifiers],
      ["person_contact_method_pii", "contact_method_id", plan.contacts],
      ["contact_correction_request_pii", "correction_request_id", plan.corrections],
      ["import_file_pii", "import_file_id", plan.importFiles],
      ["push_subscription_pii", "push_subscription_id", plan.pushSubscriptions],
    ];
    for (const [table, idColumn, rows] of simpleCompanions) {
      for (const group of chunks(rows)) {
        await tx.unsafe(`
          insert into local801.${table} (organization_id,${idColumn},${table === "person_identifier_pii" ? "identifier_value_encrypted_payload" : table === "person_contact_method_pii" ? "contact_value_encrypted_payload" : table === "contact_correction_request_pii" ? "proposed_value_encrypted_payload" : table === "import_file_pii" ? "original_filename_encrypted_payload" : "subscription_encrypted_payload"},encryption_key_version,encryption_format_version,updated_at)
          select x.organization_id::uuid,x.entity_id::uuid,x.encrypted_payload,x.encryption_key_version,x.encryption_format_version,now()
          from jsonb_to_recordset($1::jsonb) as x(organization_id text,entity_id text,encrypted_payload text,encryption_key_version text,encryption_format_version int)
          on conflict (organization_id,${idColumn}) do update set
            ${table === "person_identifier_pii" ? "identifier_value_encrypted_payload" : table === "person_contact_method_pii" ? "contact_value_encrypted_payload" : table === "contact_correction_request_pii" ? "proposed_value_encrypted_payload" : table === "import_file_pii" ? "original_filename_encrypted_payload" : "subscription_encrypted_payload"}=excluded.${table === "person_identifier_pii" ? "identifier_value_encrypted_payload" : table === "person_contact_method_pii" ? "contact_value_encrypted_payload" : table === "contact_correction_request_pii" ? "proposed_value_encrypted_payload" : table === "import_file_pii" ? "original_filename_encrypted_payload" : "subscription_encrypted_payload"},
            encryption_key_version=excluded.encryption_key_version,encryption_format_version=excluded.encryption_format_version,updated_at=now()
        `, [JSON.stringify(group.map((row) => ({ organization_id: row.organizationId, entity_id: row.personIdentifierId ?? row.contactMethodId ?? row.correctionRequestId ?? row.importFileId ?? row.pushSubscriptionId, encrypted_payload: row.encryptedPayload, encryption_key_version: row.encryptionKeyVersion, encryption_format_version: row.encryptionFormatVersion })))]);
      }
    }

    for (const group of chunks(plan.importRows)) {
      await tx`
        insert into local801.import_row_pii (
          organization_id,import_row_id,direct_pii_encrypted_payload,encryption_key_version,encryption_format_version,direct_pii_field_set_version,row_integrity_hash,row_integrity_key_version,updated_at
        ) select x.organization_id::uuid,x.import_row_id::uuid,x.encrypted_payload,x.encryption_key_version,x.encryption_format_version,x.field_set_version,x.integrity_hash,x.integrity_key_version,now()
        from jsonb_to_recordset(${JSON.stringify(group)}::jsonb) as x(
          organization_id text,import_row_id text,encrypted_payload text,encryption_key_version text,encryption_format_version int,field_set_version int,integrity_hash text,integrity_key_version text)
        on conflict (organization_id,import_row_id) do update set
          direct_pii_encrypted_payload=excluded.direct_pii_encrypted_payload,encryption_key_version=excluded.encryption_key_version,encryption_format_version=excluded.encryption_format_version,
          direct_pii_field_set_version=excluded.direct_pii_field_set_version,row_integrity_hash=excluded.row_integrity_hash,row_integrity_key_version=excluded.row_integrity_key_version,updated_at=now()
      `;
    }

    await tx`delete from local801.pii_exact_indexes where organization_id=${organizationId}::uuid`;
    for (const group of chunks(plan.exactIndexes)) {
      await tx`
        insert into local801.pii_exact_indexes (organization_id,entity_type,entity_id,index_domain,index_key_version,index_hash)
        select x.organization_id::uuid,x.entity_type,x.entity_id::uuid,x.domain,x.key_version,x.hash
        from jsonb_to_recordset(${JSON.stringify(group)}::jsonb) as x(organization_id text,entity_type text,entity_id text,domain text,key_version text,hash text)
      `;
    }

    await tx`delete from local801.person_search_tokens where organization_id=${organizationId}::uuid`;
    for (const group of chunks(plan.searchTokens)) {
      await tx`
        insert into local801.person_search_tokens (organization_id,person_id,token_domain,token_kind,token_key_version,token_hash)
        select x.organization_id::uuid,x.person_id::uuid,x.token_domain,x.token_kind,x.key_version,x.hash
        from jsonb_to_recordset(${JSON.stringify(group)}::jsonb) as x(organization_id text,person_id text,token_domain text,token_kind text,key_version text,hash text)
      `;
    }

    const [counts] = await tx`
      select
        (select count(*)::int from local801.user_pii where organization_id=${organizationId}::uuid) as users,
        (select count(*)::int from local801.auth_identity_pii where organization_id=${organizationId}::uuid) as auth_identities,
        (select count(*)::int from local801.person_pii where organization_id=${organizationId}::uuid) as people,
        (select count(*)::int from local801.person_identifier_pii where organization_id=${organizationId}::uuid) as identifiers,
        (select count(*)::int from local801.person_contact_method_pii where organization_id=${organizationId}::uuid) as contacts,
        (select count(*)::int from local801.contact_correction_request_pii where organization_id=${organizationId}::uuid) as corrections,
        (select count(*)::int from local801.import_file_pii where organization_id=${organizationId}::uuid) as import_files,
        (select count(*)::int from local801.import_row_pii where organization_id=${organizationId}::uuid) as import_rows,
        (select count(*)::int from local801.push_subscription_pii where organization_id=${organizationId}::uuid) as push_subscriptions,
        (select count(*)::int from local801.pii_exact_indexes where organization_id=${organizationId}::uuid) as exact_indexes,
        (select count(*)::int from local801.person_search_tokens where organization_id=${organizationId}::uuid) as search_tokens
    `;
    const expected = {
      users: plan.users.length, auth_identities: plan.authIdentities.length, people: plan.people.length,
      identifiers: plan.identifiers.length, contacts: plan.contacts.length, corrections: plan.corrections.length,
      import_files: plan.importFiles.length, import_rows: plan.importRows.length, push_subscriptions: plan.pushSubscriptions.length,
      exact_indexes: plan.exactIndexes.length, search_tokens: plan.searchTokens.length,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (counts[key] !== value) throw new Error(`Protected-row reconciliation failed for ${key}.`);
    }
    await tx`update local801.pii_protection_state set backfill_state='complete', backfill_completed_at=now(), updated_at=now() where organization_id=${organizationId}::uuid`;
  });
}

try {
  const organizations = await sql`select id::text, slug from local801.organizations order by slug`;
  const preview = organizations.filter((row) => row.slug === "local801-preview");
  if (preview.length !== 1) fail("exactly one local801-preview organization is required.");
  const organizationId = preview[0].id;
  const dataset = await loadDataset(organizationId);
  const plan = buildSyntheticPiiBackfillPlan(dataset, keyConfig);
  const existing = await existingCounts(organizationId);
  if (apply) await applyPlan(organizationId, plan);
  const after = apply ? await existingCounts(organizationId) : existing;
  console.log(JSON.stringify(summary(plan, after), null, 2));
  if (dryRun) console.log("Dry run only: no database rows were changed.");
  else console.log("Synthetic PII backfill completed; protected reads remain disabled.");
} finally {
  await sql.end({ timeout: 3 });
}
