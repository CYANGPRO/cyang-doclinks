import postgres from "postgres";

const CONFIRMATION = "I_HAVE_VERIFIED_PROTECTED_PII";
const DIRECT_IMPORT_KEYS = [
  "first_name", "last_name", "preferred_name", "work_email", "employee_identifier", "member_identifier",
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function guard() {
  if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview") {
    throw new Error("Protected PII cutover is prohibited in production by this Preview-only tool.");
  }
  if (process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") throw new Error("Production launch must remain disabled during Preview protected-PII cutover.");
  if (process.env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1") throw new Error("Authoritative import execution must remain disabled during Preview protected-PII cutover.");
  if (process.env.LOCAL801_PII_CUTOVER_ENABLED !== "1") throw new Error("LOCAL801_PII_CUTOVER_ENABLED=1 is required.");
  if (process.env.LOCAL801_PII_CUTOVER_CONFIRM !== CONFIRMATION) throw new Error(`LOCAL801_PII_CUTOVER_CONFIRM must equal ${CONFIRMATION}.`);
  if (process.env.LOCAL801_PII_DUAL_WRITE_ENABLED === "1") throw new Error("Dual-write must be disabled for the cutover command invocation.");
  if (process.env.LOCAL801_PII_BACKFILL_ENABLED === "1") throw new Error("The backfill maintenance gate must be disabled before cutover.");
  if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") throw new Error("The application protected-only flag is enabled too early. Run DB cutover first, then enable it on the protected deployment.");
}

function count(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main() {
  guard();
  const databaseUrl = required("LOCAL801_DATABASE_URL");
  const organizationSlug = required("LOCAL801_ORGANIZATION_SLUG");
  const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 10, onnotice: () => {} });
  try {
    const result = await sql.begin(async (tx) => {
      const [organization] = await tx`
        SELECT id::text AS id, slug
        FROM local801.organizations
        WHERE slug = ${organizationSlug} AND archived_at IS NULL
        LIMIT 2
      `;
      if (!organization) throw new Error("Cutover organization not found.");
      const organizationId = organization.id;

      const [state] = await tx`
        SELECT write_mode, backfill_state, backfill_completed_at,
          protected_read_enabled_at, protected_write_enabled_at, verified_at
        FROM local801.pii_protection_state
        WHERE organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;
      if (!state || state.write_mode !== "dual" || state.backfill_state !== "complete" || !state.backfill_completed_at) {
        throw new Error("PII protection state is not ready for protected-only cutover.");
      }
      if (state.protected_read_enabled_at || state.protected_write_enabled_at || state.verified_at) {
        throw new Error("Protected-only database cutover markers are already set.");
      }

      const [coverage] = await tx`
        SELECT
          (SELECT count(*) FROM local801.users item WHERE item.organization_id = ${organizationId}::uuid) AS users,
          (SELECT count(*) FROM local801.user_pii item WHERE item.organization_id = ${organizationId}::uuid) AS user_pii,
          (SELECT count(*) FROM local801.people item WHERE item.organization_id = ${organizationId}::uuid) AS people,
          (SELECT count(*) FROM local801.person_pii item WHERE item.organization_id = ${organizationId}::uuid) AS person_pii,
          (SELECT count(*) FROM local801.person_identifiers item WHERE item.organization_id = ${organizationId}::uuid) AS identifiers,
          (SELECT count(*) FROM local801.person_identifier_pii item WHERE item.organization_id = ${organizationId}::uuid) AS identifier_pii,
          (SELECT count(*) FROM local801.person_contact_methods item WHERE item.organization_id = ${organizationId}::uuid) AS contacts,
          (SELECT count(*) FROM local801.person_contact_method_pii item WHERE item.organization_id = ${organizationId}::uuid) AS contact_pii,
          (SELECT count(*) FROM local801.auth_identities item WHERE item.organization_id = ${organizationId}::uuid) AS auth_identities,
          (SELECT count(*) FROM local801.auth_identity_pii item WHERE item.organization_id = ${organizationId}::uuid) AS auth_identity_pii,
          (SELECT count(*) FROM local801.import_files item WHERE item.organization_id = ${organizationId}::uuid) AS import_files,
          (SELECT count(*) FROM local801.import_file_pii item WHERE item.organization_id = ${organizationId}::uuid) AS import_file_pii,
          (SELECT count(*) FROM local801.import_rows item WHERE item.organization_id = ${organizationId}::uuid) AS import_rows,
          (SELECT count(*) FROM local801.import_row_pii item WHERE item.organization_id = ${organizationId}::uuid AND item.direct_pii_field_set_version = 2) AS import_row_pii_v2,
          (SELECT count(*) FROM local801.contact_correction_requests item WHERE item.organization_id = ${organizationId}::uuid) AS corrections,
          (SELECT count(*) FROM local801.contact_correction_request_pii item WHERE item.organization_id = ${organizationId}::uuid) AS correction_pii,
          (SELECT count(*) FROM local801.push_subscriptions item WHERE item.organization_id = ${organizationId}::uuid) AS pushes,
          (SELECT count(*) FROM local801.push_subscription_pii item WHERE item.organization_id = ${organizationId}::uuid) AS push_pii
      `;
      const requiredCoverage = [
        ["users", "user_pii"], ["people", "person_pii"], ["identifiers", "identifier_pii"],
        ["contacts", "contact_pii"], ["auth_identities", "auth_identity_pii"],
        ["import_files", "import_file_pii"], ["import_rows", "import_row_pii_v2"],
        ["corrections", "correction_pii"], ["pushes", "push_pii"],
      ];
      for (const [legacy, protectedName] of requiredCoverage) {
        if (count(coverage[legacy]) !== count(coverage[protectedName])) {
          throw new Error(`Protected PII coverage mismatch for ${legacy}.`);
        }
      }

      const [indexes] = await tx`
        SELECT
          (SELECT count(*) FROM local801.users item WHERE item.organization_id = ${organizationId}::uuid) AS expected_user_email,
          (SELECT count(*) FROM local801.pii_exact_indexes idx WHERE idx.organization_id = ${organizationId}::uuid AND idx.entity_type = 'user' AND idx.index_domain = 'user:email') AS user_email,
          (SELECT count(*) FROM local801.person_identifiers item WHERE item.organization_id = ${organizationId}::uuid) AS expected_identifiers,
          (SELECT count(*) FROM local801.pii_exact_indexes idx WHERE idx.organization_id = ${organizationId}::uuid AND idx.entity_type = 'person_identifier') AS identifier_indexes,
          (SELECT count(*) FROM local801.auth_identities item WHERE item.organization_id = ${organizationId}::uuid) AS expected_auth,
          (SELECT count(*) FROM local801.pii_exact_indexes idx WHERE idx.organization_id = ${organizationId}::uuid AND idx.entity_type = 'auth_identity' AND idx.index_domain like 'auth:provider-subject:%') AS auth_subject_indexes,
          (SELECT count(*) FROM local801.push_subscriptions item WHERE item.organization_id = ${organizationId}::uuid) AS expected_push,
          (SELECT count(*) FROM local801.pii_exact_indexes idx WHERE idx.organization_id = ${organizationId}::uuid AND idx.entity_type = 'push_subscription' AND idx.index_domain = 'push:endpoint') AS push_endpoint_indexes
      `;
      if (count(indexes.expected_user_email) !== count(indexes.user_email)
        || count(indexes.expected_identifiers) !== count(indexes.identifier_indexes)
        || count(indexes.expected_auth) !== count(indexes.auth_subject_indexes)
        || count(indexes.expected_push) !== count(indexes.push_endpoint_indexes)) {
        throw new Error("Protected blind-index coverage is incomplete.");
      }

      await tx`
        UPDATE local801.users
        SET email = 'protected-' || id::text || '@invalid.local',
            display_name = 'Protected user ' || id::text
        WHERE organization_id = ${organizationId}::uuid
      `;
      await tx`
        UPDATE local801.people
        SET first_name = 'Protected',
            last_name = left(id::text, 12),
            preferred_name = NULL
        WHERE organization_id = ${organizationId}::uuid
      `;
      await tx`
        UPDATE local801.person_identifiers
        SET identifier_value = 'protected:' || id::text
        WHERE organization_id = ${organizationId}::uuid
      `;
      await tx`
        UPDATE local801.person_contact_methods
        SET contact_value = CASE
          WHEN contact_type IN ('work_email','personal_email') THEN 'protected-' || id::text || '@invalid.local'
          ELSE 'protected:' || id::text
        END
        WHERE organization_id = ${organizationId}::uuid
      `;
      await tx`
        UPDATE local801.auth_identities
        SET provider_subject = 'protected:' || id::text,
            linked_email = CASE WHEN linked_email IS NULL THEN NULL ELSE 'protected-' || id::text || '@invalid.local' END
        WHERE organization_id = ${organizationId}::uuid
      `;
      await tx`
        UPDATE local801.contact_correction_requests
        SET proposed_value = 'protected:' || id::text
        WHERE organization_id = ${organizationId}::uuid
      `;
      await tx`
        UPDATE local801.import_files
        SET original_filename = 'protected-' || id::text || '.upload'
        WHERE organization_id = ${organizationId}::uuid
      `;
      await tx.unsafe(`
        UPDATE local801.import_rows
        SET normalized_json = normalized_json - ARRAY[${DIRECT_IMPORT_KEYS.map((_, index) => `$${index + 2}`).join(",")}]::text[],
            row_hash = protected.row_integrity_hash
        FROM local801.import_row_pii protected
        WHERE import_rows.organization_id = $1::uuid
          AND protected.organization_id = import_rows.organization_id
          AND protected.import_row_id = import_rows.id
          AND protected.direct_pii_field_set_version = 2
      `, [organizationId, ...DIRECT_IMPORT_KEYS]);
      await tx`
        UPDATE local801.push_subscriptions
        SET subscription_json = jsonb_build_object('protected', true, 'record', id::text),
            endpoint_hash = 'protected:' || id::text
        WHERE organization_id = ${organizationId}::uuid
      `;

      const [rawCheck] = await tx`
        SELECT
          (SELECT count(*) FROM local801.import_rows item
            WHERE item.organization_id = ${organizationId}::uuid
              AND item.normalized_json ?| ${DIRECT_IMPORT_KEYS}::text[]) AS import_rows_with_direct_pii,
          (SELECT count(*) FROM local801.users item
            WHERE item.organization_id = ${organizationId}::uuid
              AND item.email NOT LIKE 'protected-%@invalid.local') AS unsanitized_users,
          (SELECT count(*) FROM local801.person_identifiers item
            WHERE item.organization_id = ${organizationId}::uuid
              AND item.identifier_value NOT LIKE 'protected:%') AS unsanitized_identifiers,
          (SELECT count(*) FROM local801.import_files item
            WHERE item.organization_id = ${organizationId}::uuid
              AND item.original_filename NOT LIKE 'protected-%.upload') AS unsanitized_files
      `;
      if (Object.values(rawCheck).some((value) => count(value) !== 0)) {
        throw new Error("Legacy direct-PII scrub verification failed.");
      }

      await tx`
        UPDATE local801.pii_protection_state
        SET write_mode = 'protected',
            protected_read_enabled_at = now(),
            protected_write_enabled_at = now(),
            verified_at = now(),
            updated_at = now()
        WHERE organization_id = ${organizationId}::uuid
          AND write_mode = 'dual'
          AND backfill_state = 'complete'
      `;

      return {
        organizationId,
        users: count(coverage.users),
        people: count(coverage.people),
        importRows: count(coverage.import_rows),
      };
    });
    console.log(JSON.stringify({ ok: true, mode: "protected", ...result }));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Cutover failed." }));
  process.exitCode = 1;
});
