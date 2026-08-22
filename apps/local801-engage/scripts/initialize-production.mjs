import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { buildSyntheticPiiBackfillPlan } from "../src/lib/pii-backfill.ts";
import {
  createPiiBlindIndex,
  decryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiEmail,
} from "../src/lib/pii-protection.ts";
import { assertProductionInitializationRequest } from "./lib/production-initializer-policy.mjs";

const modeArgument = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) ?? "inspect";
const target = assertProductionInitializationRequest(process.env, modeArgument);
const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
let piiConfiguration;
const roleDefinitions = [
  ["system_owner", "System Owner", 43200],
  ["local_admin", "Local Administrator", 43200],
  ["membership_data_manager", "Membership Data Manager", 604800],
  ["cat_admin", "CAT Administrator", 604800],
  ["cat_lead", "CAT Lead", 604800],
  ["cat_member", "CAT Member", 604800],
  ["report_viewer", "Report Viewer", 604800],
];

function targetFingerprint() {
  return createHash("sha256").update(`local801-production-v1:${target.hostname}/${target.databaseName}:${target.organizationSlug}`).digest("hex");
}

async function inspect(transaction) {
  const [identity] = await transaction`select current_database()::text as database_name`;
  if (identity?.database_name !== target.databaseName) throw new Error("Connected database identity does not match the approved target.");
  const requiredTables = [
    "organizations", "users", "workspace_roles", "workspace_user_roles", "audit_events",
    "user_pii", "pii_exact_indexes", "pii_protection_state", "production_initializations",
  ];
  const [{ present_count: presentCount }] = await transaction`
    select count(*)::integer as present_count
    from pg_catalog.pg_tables
    where schemaname = 'local801' and tablename = any(${requiredTables})
  `;
  if (Number(presentCount) !== requiredTables.length) throw new Error("The reviewed CAT migration set is incomplete.");
  const tables = await transaction`select tablename from pg_catalog.pg_tables where schemaname = 'local801' order by tablename`;
  const populated = [];
  for (const row of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(row.tablename)) throw new Error("Unexpected CAT table identifier.");
    const [{ row_count: rowCount }] = await transaction.unsafe(`select count(*)::text as row_count from local801.${row.tablename}`);
    if (Number(rowCount) !== 0) populated.push(row.tablename);
  }
  return { tableCount: tables.length, populatedTableCount: populated.length };
}

async function verifyProtectedOwner(transaction, organizationId, ownerId, configuration) {
  const rows = await transaction`
    select
      app_user.email as placeholder_email,
      app_user.display_name as placeholder_display_name,
      protected.email_encrypted_payload,
      protected.email_encryption_key_version,
      protected.email_encryption_format_version,
      protected.display_name_encrypted_payload,
      protected.display_name_encryption_key_version,
      protected.display_name_encryption_format_version,
      exact_index.index_key_version,
      exact_index.index_hash,
      role.code as role_code
    from local801.users app_user
    join local801.user_pii protected
      on protected.organization_id = app_user.organization_id and protected.user_id = app_user.id
    join local801.pii_exact_indexes exact_index
      on exact_index.organization_id = app_user.organization_id
      and exact_index.entity_type = 'user'
      and exact_index.entity_id = app_user.id
      and exact_index.index_domain = 'user:email'
    join local801.workspace_user_roles assignment on assignment.user_id = app_user.id
    join local801.workspace_roles role
      on role.id = assignment.role_id and role.organization_id = app_user.organization_id
    where app_user.organization_id = ${organizationId} and app_user.id = ${ownerId}
  `;
  if (rows.length !== 1 || rows[0].role_code !== "system_owner") {
    throw new Error("Protected System Owner verification failed.");
  }
  const row = rows[0];
  if (row.placeholder_email !== `protected-${ownerId}@invalid.local`
    || row.placeholder_display_name !== `Protected user ${ownerId}`
    || row.placeholder_email === target.ownerEmail
    || row.placeholder_display_name === target.ownerDisplayName) {
    throw new Error("Protected System Owner plaintext placeholder verification failed.");
  }
  const email = decryptPiiField({
    encryptedPayload: row.email_encrypted_payload,
    encryptionKeyVersion: row.email_encryption_key_version,
    encryptionFormatVersion: row.email_encryption_format_version,
  }, { organizationId, entity: "user", recordId: ownerId, field: "email" }, configuration);
  const displayName = decryptPiiField({
    encryptedPayload: row.display_name_encrypted_payload,
    encryptionKeyVersion: row.display_name_encryption_key_version,
    encryptionFormatVersion: row.display_name_encryption_format_version,
  }, { organizationId, entity: "user", recordId: ownerId, field: "display-name" }, configuration);
  const expectedIndex = createPiiBlindIndex(normalizePiiEmail(target.ownerEmail), {
    organizationId,
    domain: "user:email",
    keyVersion: row.index_key_version,
  }, configuration);
  if (email !== target.ownerEmail || displayName !== target.ownerDisplayName
    || expectedIndex.blindIndexKeyVersion !== row.index_key_version
    || expectedIndex.blindIndex !== row.index_hash) {
    throw new Error("Protected System Owner cryptographic verification failed.");
  }
}

try {
  if (modeArgument === "inspect") {
    const result = await sql.begin(async (transaction) => inspect(transaction));
    console.log(JSON.stringify({ mode: "inspect", schema: "local801", tableCount: result.tableCount, fresh: result.populatedTableCount === 0 }));
    if (result.populatedTableCount !== 0) process.exitCode = 2;
  } else {
    piiConfiguration = getPiiKeyConfiguration(process.env);
    const organizationId = randomUUID();
    const ownerId = randomUUID();
    const ownerPlan = buildSyntheticPiiBackfillPlan({
      users: [{ id: ownerId, organization_id: organizationId, email: target.ownerEmail, display_name: target.ownerDisplayName }],
      authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], importFiles: [], importRows: [], pushSubscriptions: [],
    }, piiConfiguration);
    const protectedOwner = ownerPlan.users[0];
    const emailIndex = ownerPlan.exactIndexes.find((row) => row.entityType === "user" && row.domain === "user:email");
    if (!protectedOwner || !emailIndex) throw new Error("Protected System Owner plan is incomplete.");

    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('local801-production-initialization-v1'))`;
      const state = await inspect(transaction);
      if (state.populatedTableCount !== 0) throw new Error("Production initialization refuses a populated or previously initialized target.");
      await transaction`insert into local801.organizations (id, slug, name) values (${organizationId}, ${target.organizationSlug}, ${target.organizationName})`;
      for (const [code, name, sessionSeconds] of roleDefinitions) {
        await transaction`insert into local801.workspace_roles (organization_id, code, name, session_seconds) values (${organizationId}, ${code}, ${name}, ${sessionSeconds})`;
      }
      await transaction`
        insert into local801.users (id, organization_id, email, display_name, invited_at)
        values (${ownerId}, ${organizationId}, ${`protected-${ownerId}@invalid.local`}, ${`Protected user ${ownerId}`}, now())
      `;
      await transaction`
        insert into local801.user_pii (
          organization_id, user_id,
          email_encrypted_payload, email_encryption_key_version, email_encryption_format_version,
          display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version
        ) values (
          ${organizationId}, ${ownerId},
          ${protectedOwner.emailEncryptedPayload}, ${protectedOwner.emailEncryptionKeyVersion}, ${protectedOwner.emailEncryptionFormatVersion},
          ${protectedOwner.displayNameEncryptedPayload}, ${protectedOwner.displayNameEncryptionKeyVersion}, ${protectedOwner.displayNameEncryptionFormatVersion}
        )
      `;
      await transaction`
        insert into local801.pii_exact_indexes (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
        values (${organizationId}, 'user', ${ownerId}, 'user:email', ${emailIndex.keyVersion}, ${emailIndex.hash})
      `;
      await transaction`
        insert into local801.workspace_user_roles (user_id, role_id, assigned_by)
        select ${ownerId}, role.id, ${ownerId}
        from local801.workspace_roles role
        where role.organization_id = ${organizationId} and role.code = 'system_owner'
      `;
      await verifyProtectedOwner(transaction, organizationId, ownerId, piiConfiguration);
      await transaction`
        insert into local801.pii_protection_state (
          organization_id, schema_version, write_mode, backfill_state, backfill_completed_at,
          protected_read_enabled_at, protected_write_enabled_at, verified_at, updated_at
        ) values (${organizationId}, 1, 'protected', 'complete', now(), now(), now(), now(), now())
      `;
      const [protectedState] = await transaction`
        select local801.pii_protected_mode_enabled(${organizationId}::uuid) as enabled
      `;
      if (protectedState?.enabled !== true) throw new Error("Protected-only PII state verification failed.");
      await transaction`set constraints all immediate`;
      const auditPayload = { operation: "production_initialization", version: 1, protectedPii: true };
      const auditHash = createHash("sha256").update(JSON.stringify({
        eventType: "config.change", actorId: ownerId, organizationId,
        subjectType: "organization", subjectId: organizationId, payload: auditPayload, previousHash: null,
      })).digest("hex");
      const [audit] = await transaction`
        insert into local801.audit_events (
          organization_id, actor_user_id, event_type, subject_type, subject_id, payload, previous_hash, event_hash
        ) values (${organizationId}, ${ownerId}, 'config.change', 'organization', ${organizationId}, ${JSON.stringify(auditPayload)}::jsonb, null, ${auditHash})
        returning id
      `;
      if (!audit?.id) throw new Error("Production initialization audit event was not created.");
      await transaction`
        insert into local801.production_initializations (
          organization_id, initial_system_owner_id, target_fingerprint, audit_event_id
        ) values (${organizationId}, ${ownerId}, ${targetFingerprint()}, ${audit.id})
      `;
    });
    console.log(JSON.stringify({ mode: "initialize", status: "complete", protectedPii: true, launchEnabled: false }));
  }
} catch (error) {
  console.error(JSON.stringify({ mode: modeArgument, status: "refused", reason: error instanceof Error ? error.message : "Initialization failed safely." }));
  process.exitCode = 1;
} finally {
  if (piiConfiguration) {
    for (const key of piiConfiguration.encryptionKeys.values()) key.fill(0);
    for (const key of piiConfiguration.blindIndexKeys.values()) key.fill(0);
  }
  await sql.end({ timeout: 1 });
}
