import "server-only";

import type { DatabaseStatement } from "./db.ts";

const AUTHORITATIVE_PRESENCE_MASK = 8 | 16 | 32 | 64;
const WORK_EMAIL_MASK = 8;

function protectedMode(env: NodeJS.ProcessEnv) {
  return env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1";
}

function isMissingIdentifierValidation(sql: string) {
  return /Rows require an authoritative identifier; names are not used for merging\./i.test(sql)
    && /insert\s+into\s+local801\.import_errors/i.test(sql);
}

function isWorkEmailValidation(sql: string) {
  return /The work email format is invalid\./i.test(sql)
    && /insert\s+into\s+local801\.import_errors/i.test(sql);
}

function isDuplicateIdentifierValidation(sql: string) {
  return /A duplicate authoritative identifier was detected in this source\./i.test(sql)
    && /insert\s+into\s+local801\.import_errors/i.test(sql);
}

function isLegacyIdentityMatch(sql: string) {
  const normalized = sql.replace(/\s+/g, " ");
  return /insert into local801\.import_match_candidates/i.test(normalized)
    && /string_agg\(distinct rule/i.test(normalized)
    && (/identifier_value/i.test(normalized) || /contact_value/i.test(normalized));
}

function missingIdentifierStatement(statement: DatabaseStatement): DatabaseStatement {
  return {
    sql: `
      /* pii-protected-import-worker:validate-authoritative-identity */
      INSERT INTO local801.import_errors
        (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, row.id, 'error', 'identifier',
        'Rows require an authoritative identifier; names are not used for merging.'
      FROM local801.import_rows row
      JOIN local801.import_sheets sheet
        ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
      JOIN local801.import_files file
        ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
      LEFT JOIN local801.import_row_pii protected
        ON protected.organization_id = row.organization_id AND protected.import_row_id = row.id
      WHERE row.organization_id = $1 AND file.import_batch_id = $2
        AND (
          protected.import_row_id IS NULL
          OR protected.direct_pii_field_set_version NOT IN (2, 3, 4, 5)
          OR protected.direct_pii_presence_mask IS NULL
          OR protected.direct_pii_validity_mask IS NULL
          OR (protected.direct_pii_presence_mask & ${AUTHORITATIVE_PRESENCE_MASK}) = 0
        )
    `,
    parameters: statement.parameters,
  };
}

function workEmailStatement(statement: DatabaseStatement): DatabaseStatement {
  return {
    sql: `
      /* pii-protected-import-worker:validate-work-email */
      INSERT INTO local801.import_errors
        (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, row.id, 'error', 'work_email', 'The work email format is invalid.'
      FROM local801.import_rows row
      JOIN local801.import_sheets sheet
        ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
      JOIN local801.import_files file
        ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
      JOIN local801.import_row_pii protected
        ON protected.organization_id = row.organization_id AND protected.import_row_id = row.id
      WHERE row.organization_id = $1 AND file.import_batch_id = $2
        AND (protected.direct_pii_presence_mask & ${WORK_EMAIL_MASK}) <> 0
        AND (protected.direct_pii_validity_mask & ${WORK_EMAIL_MASK}) = 0
    `,
    parameters: statement.parameters,
  };
}

function duplicateIdentifierStatement(statement: DatabaseStatement): DatabaseStatement {
  return {
    sql: `
      /* pii-protected-import-worker:validate-duplicate-identity */
      WITH batch_rows AS (
        SELECT row.id
        FROM local801.import_rows row
        JOIN local801.import_sheets sheet
          ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
        JOIN local801.import_files file
          ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
        WHERE row.organization_id = $1 AND file.import_batch_id = $2
      ), evidence AS (
        SELECT imported.entity_id AS import_row_id,
          imported.index_domain, imported.index_key_version, imported.index_hash
        FROM local801.pii_exact_indexes imported
        JOIN batch_rows row ON row.id = imported.entity_id
        WHERE imported.organization_id = $1
          AND imported.entity_type = 'import_row'
          AND imported.index_domain IN (
            'identifier:employee-identifier',
            'identifier:member-identifier',
            'contact:work-email',
            'contact:personal-email'
          )
      ), duplicated AS (
        SELECT index_domain, index_key_version, index_hash
        FROM evidence
        GROUP BY index_domain, index_key_version, index_hash
        HAVING count(DISTINCT import_row_id) > 1
      )
      INSERT INTO local801.import_errors
        (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT DISTINCT $1, $2, evidence.import_row_id, 'error', 'identifier',
        'A duplicate authoritative identifier was detected in this source.'
      FROM evidence
      JOIN duplicated USING (index_domain, index_key_version, index_hash)
    `,
    parameters: statement.parameters,
  };
}

function protectedIdentityMatchStatement(statement: DatabaseStatement): DatabaseStatement {
  return {
    sql: `
      /* pii-protected-import-worker:match-identities */
      WITH batch_rows AS (
        SELECT row.id
        FROM local801.import_rows row
        JOIN local801.import_sheets sheet
          ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
        JOIN local801.import_files file
          ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
        WHERE row.organization_id = $1 AND file.import_batch_id = $2
      ), import_indexes AS (
        SELECT imported.entity_id AS import_row_id,
          imported.index_domain, imported.index_key_version, imported.index_hash
        FROM local801.pii_exact_indexes imported
        JOIN batch_rows row ON row.id = imported.entity_id
        WHERE imported.organization_id = $1
          AND imported.entity_type = 'import_row'
          AND imported.index_domain IN (
            'identifier:employee-identifier',
            'identifier:member-identifier',
            'contact:work-email',
            'contact:personal-email'
          )
      ), evidence AS (
        SELECT imported.import_row_id, identifier.person_id,
          identifier.identifier_type::text AS rule
        FROM import_indexes imported
        JOIN local801.pii_exact_indexes live
          ON live.organization_id = $1
         AND live.entity_type = 'person_identifier'
         AND live.index_domain = imported.index_domain
         AND live.index_key_version = imported.index_key_version
         AND live.index_hash = imported.index_hash
        JOIN local801.person_identifiers identifier
          ON identifier.organization_id = $1 AND identifier.id = live.entity_id
        JOIN local801.people person
          ON person.organization_id = identifier.organization_id
         AND person.id = identifier.person_id
         AND person.archived_at IS NULL
        WHERE imported.index_domain IN (
          'identifier:employee-identifier',
          'identifier:member-identifier'
        )
          AND (
            (imported.index_domain = 'identifier:employee-identifier'
              AND identifier.identifier_type = 'employee_identifier')
            OR
            (imported.index_domain = 'identifier:member-identifier'
              AND identifier.identifier_type = 'member_identifier')
          )
        UNION ALL
        SELECT imported.import_row_id, contact.person_id, 'work_email'::text AS rule
        FROM import_indexes imported
        JOIN local801.pii_exact_indexes live
          ON live.organization_id = $1
         AND live.entity_type = 'person_contact_method'
         AND live.index_domain = 'contact:work-email'
         AND live.index_key_version = imported.index_key_version
         AND live.index_hash = imported.index_hash
        JOIN local801.person_contact_methods contact
          ON contact.organization_id = $1 AND contact.id = live.entity_id
        JOIN local801.people person
          ON person.organization_id = contact.organization_id
         AND person.id = contact.person_id
         AND person.archived_at IS NULL
        WHERE imported.index_domain = 'contact:work-email'
          AND contact.contact_type = 'work_email'
          AND contact.archived_at IS NULL
        UNION ALL
        SELECT imported.import_row_id, contact.person_id, 'personal_email'::text AS rule
        FROM import_indexes imported
        JOIN local801.pii_exact_indexes live
          ON live.organization_id = $1
         AND live.entity_type = 'person_contact_method'
         AND live.index_domain = 'contact:personal-email'
         AND live.index_key_version = imported.index_key_version
         AND live.index_hash = imported.index_hash
        JOIN local801.person_contact_methods contact
          ON contact.organization_id = $1 AND contact.id = live.entity_id
        JOIN local801.people person
          ON person.organization_id = contact.organization_id
         AND person.id = contact.person_id
         AND person.archived_at IS NULL
        WHERE imported.index_domain = 'contact:personal-email'
          AND contact.contact_type = 'personal_email'
          AND contact.archived_at IS NULL
      ), grouped AS (
        SELECT import_row_id, person_id,
          string_agg(DISTINCT rule, '+' ORDER BY rule) AS match_rule
        FROM evidence
        GROUP BY import_row_id, person_id
      )
      INSERT INTO local801.import_match_candidates
        (id, organization_id, import_row_id, person_id, match_rule, confidence, requires_review)
      SELECT gen_random_uuid(), $1, import_row_id, person_id, match_rule, 1, false
      FROM grouped
    `,
    parameters: statement.parameters,
  };
}

export function rewriteProtectedImportWorkerStatements(
  statements: readonly DatabaseStatement[],
  env: NodeJS.ProcessEnv = process.env,
): readonly DatabaseStatement[] {
  if (!protectedMode(env)) return statements;
  return statements.map((statement) => {
    if (isMissingIdentifierValidation(statement.sql)) return missingIdentifierStatement(statement);
    if (isWorkEmailValidation(statement.sql)) return workEmailStatement(statement);
    if (isDuplicateIdentifierValidation(statement.sql)) return duplicateIdentifierStatement(statement);
    if (isLegacyIdentityMatch(statement.sql)) return protectedIdentityMatchStatement(statement);
    return statement;
  });
}

export const __testing = {
  isDuplicateIdentifierValidation,
  isLegacyIdentityMatch,
  isMissingIdentifierValidation,
  isWorkEmailValidation,
};
