import "server-only";

/**
 * Stage 14B protected import classification.
 *
 * Direct PII is never read from import_rows.normalized_json here. Identity matching and direct-field
 * change detection use keyed blind indexes. The only JSON values read are the explicitly retained
 * operational dimensions. Field presence/normalization validity comes from non-PII bit masks stored
 * beside the encrypted import-row bundle. The legacy unkeyed row hash is intentionally not used in
 * protected review-set fingerprints; row_hash below is the keyed protected row-integrity HMAC.
 */
export const PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE = `
  batch_rows AS (
    SELECT row.id AS import_row_id, protected.row_integrity_hash AS row_hash,
      row.source_row_number, row.state AS row_state,
      row.normalized_json, sheet.sheet_name, file.sha256 AS source_file_sha256,
      protected.direct_pii_field_set_version,
      protected.direct_pii_presence_mask,
      protected.direct_pii_validity_mask
    FROM local801.import_batches batch
    JOIN local801.import_files file
      ON file.import_batch_id = batch.id AND file.organization_id = batch.organization_id
    JOIN local801.import_sheets sheet
      ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
    JOIN local801.import_rows row
      ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
    LEFT JOIN local801.import_row_pii protected
      ON protected.organization_id = row.organization_id AND protected.import_row_id = row.id
    WHERE batch.organization_id = $1 AND batch.id = $2
  ),
  batch_errors AS (
    SELECT error.import_row_id
    FROM local801.import_errors error
    WHERE error.organization_id = $1 AND error.import_batch_id = $2 AND error.severity = 'error'
  ),
  row_error_counts AS (
    SELECT error.import_row_id, count(*)::int AS error_count
    FROM batch_errors error
    WHERE error.import_row_id IS NOT NULL
    GROUP BY error.import_row_id
  ),
  batch_error_counts AS (
    SELECT count(*)::int AS blocking_error_count,
      count(*) FILTER (WHERE row.import_row_id IS NULL)::int AS unassociated_blocking_error_count
    FROM batch_errors error
    LEFT JOIN batch_rows row ON row.import_row_id = error.import_row_id
  ),
  import_indexes AS (
    SELECT index.entity_id AS import_row_id, index.index_domain,
      index.index_key_version, index.index_hash
    FROM local801.pii_exact_indexes index
    JOIN batch_rows row ON row.import_row_id = index.entity_id
    WHERE index.organization_id = $1
      AND index.entity_type = 'import_row'
      AND index.index_domain IN (
        'person:first-name','person:last-name','person:preferred-name',
        'contact:work-email','contact:personal-email',
        'identifier:employee-identifier','identifier:member-identifier'
      )
  ),
  prior_approved_snapshot AS MATERIALIZED (
    SELECT snapshot.id, snapshot.organization_id, snapshot.source_import_batch_id
    FROM local801.membership_snapshots snapshot
    WHERE snapshot.organization_id = $1
      AND snapshot.status = 'approved'
      AND snapshot.source_import_batch_id IS NOT NULL
      AND snapshot.source_import_batch_id <> $2::uuid
    ORDER BY snapshot.snapshot_date DESC, snapshot.created_at DESC, snapshot.id DESC
    LIMIT 1
  ),
  prior_snapshot_import_rows AS MATERIALIZED (
    SELECT import_row.id AS import_row_id, snapshot_row.person_id
    FROM prior_approved_snapshot snapshot
    JOIN local801.import_files file
      ON file.organization_id = snapshot.organization_id
      AND file.import_batch_id = snapshot.source_import_batch_id
    JOIN local801.import_sheets sheet
      ON sheet.organization_id = snapshot.organization_id
      AND sheet.import_file_id = file.id
    JOIN local801.import_rows import_row
      ON import_row.organization_id = snapshot.organization_id
      AND import_row.import_sheet_id = sheet.id
    JOIN local801.membership_snapshot_rows snapshot_row
      ON snapshot_row.organization_id = snapshot.organization_id
      AND snapshot_row.snapshot_id = snapshot.id
      AND snapshot_row.row_hash = import_row.row_hash
  ),
  prior_snapshot_evidence AS (
    SELECT current_index.import_row_id, prior_row.person_id,
      CASE current_index.index_domain
        WHEN 'identifier:employee-identifier' THEN 'employee_identifier'
        WHEN 'identifier:member-identifier' THEN 'member_identifier'
        WHEN 'contact:work-email' THEN 'work_email'
        WHEN 'contact:personal-email' THEN 'personal_email'
      END::text AS evidence_type
    FROM import_indexes current_index
    JOIN local801.pii_exact_indexes prior_index
      ON prior_index.organization_id = $1
      AND prior_index.entity_type = 'import_row'
      AND prior_index.index_domain = current_index.index_domain
      AND prior_index.index_key_version = current_index.index_key_version
      AND prior_index.index_hash = current_index.index_hash
    JOIN prior_snapshot_import_rows prior_row
      ON prior_row.import_row_id = prior_index.entity_id
    WHERE current_index.index_domain IN (
      'identifier:employee-identifier','identifier:member-identifier',
      'contact:work-email','contact:personal-email'
    )
  ),
  live_evidence AS (
    SELECT import_index.import_row_id, identifier.person_id,
      identifier.identifier_type::text AS evidence_type
    FROM import_indexes import_index
    JOIN local801.pii_exact_indexes live_index
      ON live_index.organization_id = $1
      AND live_index.entity_type = 'person_identifier'
      AND live_index.index_domain = import_index.index_domain
      AND live_index.index_key_version = import_index.index_key_version
      AND live_index.index_hash = import_index.index_hash
    JOIN local801.person_identifiers identifier
      ON identifier.organization_id = $1 AND identifier.id = live_index.entity_id
    WHERE import_index.index_domain IN ('identifier:employee-identifier','identifier:member-identifier')
      AND ((import_index.index_domain = 'identifier:employee-identifier' AND identifier.identifier_type = 'employee_identifier')
        OR (import_index.index_domain = 'identifier:member-identifier' AND identifier.identifier_type = 'member_identifier'))
    UNION ALL
    SELECT import_row_id, person_id, evidence_type
    FROM prior_snapshot_evidence
    UNION ALL
    SELECT import_index.import_row_id, contact.person_id, 'work_email'
    FROM import_indexes import_index
    JOIN local801.pii_exact_indexes live_index
      ON live_index.organization_id = $1
      AND live_index.entity_type = 'person_contact_method'
      AND live_index.index_domain = 'contact:work-email'
      AND live_index.index_key_version = import_index.index_key_version
      AND live_index.index_hash = import_index.index_hash
    JOIN local801.person_contact_methods contact
      ON contact.organization_id = $1 AND contact.id = live_index.entity_id
    WHERE import_index.index_domain = 'contact:work-email'
      AND contact.contact_type = 'work_email'
      AND contact.archived_at IS NULL
    UNION ALL
    SELECT import_index.import_row_id, contact.person_id, 'personal_email'
    FROM import_indexes import_index
    JOIN local801.pii_exact_indexes live_index
      ON live_index.organization_id = $1
      AND live_index.entity_type = 'person_contact_method'
      AND live_index.index_domain = 'contact:personal-email'
      AND live_index.index_key_version = import_index.index_key_version
      AND live_index.index_hash = import_index.index_hash
    JOIN local801.person_contact_methods contact
      ON contact.organization_id = $1 AND contact.id = live_index.entity_id
    WHERE import_index.index_domain = 'contact:personal-email'
      AND contact.contact_type = 'personal_email'
      AND contact.archived_at IS NULL
  ),
  live_matches AS (
    SELECT import_row_id, count(DISTINCT person_id)::int AS person_count,
      CASE WHEN count(DISTINCT person_id) = 1 THEN min(person_id::text)::uuid END AS person_id,
      bool_or(evidence_type = 'employee_identifier') AS employee_identifier_matches,
      bool_or(evidence_type = 'member_identifier') AS member_identifier_matches,
      bool_or(evidence_type = 'work_email') AS work_email_identity_matches,
      bool_or(evidence_type = 'personal_email') AS personal_email_identity_matches
    FROM live_evidence
    GROUP BY import_row_id
  ),
  direct_person_name_matches AS (
    SELECT imported.import_row_id,
      bool_or(imported.index_domain = 'person:first-name' AND live.entity_id IS NOT NULL) AS first_name_matches,
      bool_or(imported.index_domain = 'person:last-name' AND live.entity_id IS NOT NULL) AS last_name_matches,
      bool_or(imported.index_domain = 'person:preferred-name' AND live.entity_id IS NOT NULL) AS preferred_name_matches
    FROM import_indexes imported
    JOIN live_matches match
      ON match.import_row_id = imported.import_row_id AND match.person_count = 1
    LEFT JOIN local801.pii_exact_indexes live
      ON live.organization_id = $1
      AND live.entity_type = 'person'
      AND live.entity_id = match.person_id
      AND live.index_domain = imported.index_domain
      AND live.index_key_version = imported.index_key_version
      AND live.index_hash = imported.index_hash
    WHERE imported.index_domain IN ('person:first-name','person:last-name','person:preferred-name')
    GROUP BY imported.import_row_id
  ),
  direct_contact_matches AS (
    SELECT imported.import_row_id,
      bool_or(imported.index_domain = 'contact:work-email'
        AND contact.contact_type = 'work_email'
        AND contact.is_primary = true
        AND contact.archived_at IS NULL
        AND live.entity_id IS NOT NULL) AS primary_work_email_matches,
      bool_or(imported.index_domain = 'contact:personal-email'
        AND contact.contact_type = 'personal_email'
        AND contact.archived_at IS NULL
        AND live.entity_id IS NOT NULL) AS personal_email_matches
    FROM import_indexes imported
    JOIN live_matches match
      ON match.import_row_id = imported.import_row_id AND match.person_count = 1
    LEFT JOIN local801.pii_exact_indexes live
      ON live.organization_id = $1
      AND live.entity_type = 'person_contact_method'
      AND live.index_domain = imported.index_domain
      AND live.index_key_version = imported.index_key_version
      AND live.index_hash = imported.index_hash
    LEFT JOIN local801.person_contact_methods contact
      ON contact.organization_id = $1
      AND contact.id = live.entity_id
      AND contact.person_id = match.person_id
    WHERE imported.index_domain IN ('contact:work-email','contact:personal-email')
    GROUP BY imported.import_row_id
  ),
  direct_field_matches AS (
    SELECT row.import_row_id,
      COALESCE(name.first_name_matches, false) AS first_name_matches,
      COALESCE(name.last_name_matches, false) AS last_name_matches,
      COALESCE(name.preferred_name_matches, false) AS preferred_name_matches,
      COALESCE(contact.primary_work_email_matches, false) AS primary_work_email_matches,
      COALESCE(contact.personal_email_matches, false) AS personal_email_matches
    FROM batch_rows row
    LEFT JOIN direct_person_name_matches name ON name.import_row_id = row.import_row_id
    LEFT JOIN direct_contact_matches contact ON contact.import_row_id = row.import_row_id
  ),
  row_facts AS (
    SELECT row.*, COALESCE(match.person_count, 0) AS person_count, match.person_id,
      COALESCE(match.employee_identifier_matches, false) AS employee_identifier_matches,
      COALESCE(match.member_identifier_matches, false) AS member_identifier_matches,
      COALESCE(match.work_email_identity_matches, false) AS work_email_identity_matches,
      COALESCE(match.personal_email_identity_matches, false) AS personal_email_identity_matches,
      COALESCE(direct.first_name_matches, false) AS first_name_matches,
      COALESCE(direct.last_name_matches, false) AS last_name_matches,
      COALESCE(direct.preferred_name_matches, false) AS preferred_name_matches,
      COALESCE(direct.primary_work_email_matches, false) AS primary_work_email_matches,
      COALESCE(direct.personal_email_matches, false) AS personal_email_matches,
      person.department AS existing_department,
      person.section AS existing_section,
      person.classification AS existing_classification,
      person.work_location AS existing_work_location,
      person.membership_status AS existing_membership_status,
      person.hire_date AS existing_hire_date,
      person.job_status AS existing_job_status,
      (person.id IS NOT NULL AND person.archived_at IS NULL) AS existing_person_active,
      COALESCE(error.error_count, 0) AS error_count
    FROM batch_rows row
    LEFT JOIN live_matches match ON match.import_row_id = row.import_row_id
    LEFT JOIN direct_field_matches direct ON direct.import_row_id = row.import_row_id
    LEFT JOIN local801.people person ON person.id = match.person_id AND person.organization_id = $1
    LEFT JOIN row_error_counts error ON error.import_row_id = row.import_row_id
  ),
  categorized AS (
    SELECT facts.*,
      CASE
        WHEN facts.row_state = 'rejected' THEN 'rejected'
        WHEN facts.error_count > 0 OR facts.person_count > 1
          OR (facts.person_count = 1 AND NOT facts.existing_person_active) THEN 'needs_attention'
        WHEN facts.row_hash IS NULL OR facts.direct_pii_field_set_version NOT IN (2, 3, 4)
          OR facts.direct_pii_presence_mask IS NULL
          OR facts.direct_pii_validity_mask IS NULL THEN 'needs_attention'
        WHEN (facts.direct_pii_presence_mask & facts.direct_pii_validity_mask) <> facts.direct_pii_presence_mask THEN 'needs_attention'
        WHEN (facts.direct_pii_presence_mask & 1) = 0
          OR (facts.direct_pii_presence_mask & 2) = 0
          OR ((facts.direct_pii_presence_mask & 16) = 0
            AND (facts.direct_pii_presence_mask & 32) = 0
            AND (facts.direct_pii_presence_mask & 8) = 0
            AND (facts.direct_pii_presence_mask & 64) = 0) THEN 'needs_attention'
        WHEN facts.person_count = 0 THEN 'proposed_new'
        WHEN facts.person_count = 1 AND (
          ((facts.direct_pii_presence_mask & 1) <> 0 AND NOT facts.first_name_matches)
          OR ((facts.direct_pii_presence_mask & 2) <> 0 AND NOT facts.last_name_matches)
          OR ((facts.direct_pii_presence_mask & 4) <> 0 AND NOT facts.preferred_name_matches)
          OR (NULLIF(btrim(facts.normalized_json ->> 'department'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'department') IS DISTINCT FROM btrim(facts.existing_department))
          OR (NULLIF(btrim(facts.normalized_json ->> 'section'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'section') IS DISTINCT FROM btrim(facts.existing_section))
          OR (NULLIF(btrim(facts.normalized_json ->> 'classification'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'classification') IS DISTINCT FROM btrim(facts.existing_classification))
          OR (NULLIF(btrim(facts.normalized_json ->> 'work_location'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'work_location') IS DISTINCT FROM btrim(facts.existing_work_location))
          OR (NULLIF(btrim(facts.normalized_json ->> 'membership_status'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'membership_status') IS DISTINCT FROM btrim(facts.existing_membership_status))
          OR (NULLIF(btrim(facts.normalized_json ->> 'hire_date'), '') IS NOT NULL
            AND (facts.normalized_json ->> 'hire_date')::date IS DISTINCT FROM facts.existing_hire_date)
          OR (NULLIF(btrim(facts.normalized_json ->> 'job_status'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'job_status') IS DISTINCT FROM btrim(facts.existing_job_status))
          OR ((facts.direct_pii_presence_mask & 8) <> 0 AND NOT facts.primary_work_email_matches)
          OR ((facts.direct_pii_presence_mask & 16) <> 0 AND NOT facts.employee_identifier_matches)
          OR ((facts.direct_pii_presence_mask & 32) <> 0 AND NOT facts.member_identifier_matches)
          OR ((facts.direct_pii_presence_mask & 64) <> 0 AND NOT facts.personal_email_matches)
        ) THEN 'existing_with_changes'
        ELSE 'unchanged_existing'
      END::text AS category
    FROM row_facts facts
  )`;
