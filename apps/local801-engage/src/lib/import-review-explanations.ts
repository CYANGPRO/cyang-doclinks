import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { ImportReviewActor, ImportReviewCategory } from "./import-review.ts";
import { PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE } from "./pii-protected-import-classification.ts";
import { isPiiProtectedReadEnabled } from "./pii-protected-read.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ImportReviewCoordinate = {
  sheetName: string;
  sourceRowNumber: number;
};

export type ImportReviewExplanation = {
  sheetName: string;
  sourceRowNumber: number;
  category: ImportReviewCategory;
  changeFields: string[];
  reasons: string[];
};

type ExplanationRow = {
  sheet_name: string;
  source_row_number: number;
  category: ImportReviewCategory;
  change_fields: string[] | null;
  reasons: string[] | null;
};

function validate(actor: ImportReviewActor, batchId: string, coordinates: readonly ImportReviewCoordinate[]) {
  if (!can(actor.role, "approveImports")) throw new Error("Forbidden.");
  if (!UUID_RE.test(batchId)) throw new Error("Import not found.");
  if (coordinates.length > 100) throw new Error("Too many review rows.");
  for (const coordinate of coordinates) {
    if (!coordinate.sheetName || coordinate.sheetName.length > 255
      || !Number.isInteger(coordinate.sourceRowNumber) || coordinate.sourceRowNumber < 1) {
      throw new Error("Invalid review row.");
    }
  }
}

const PROTECTED_EXPLANATION_SELECT = `
  SELECT categorized.sheet_name, categorized.source_row_number, categorized.category,
    array_remove(ARRAY[
      CASE WHEN (categorized.direct_pii_presence_mask & 1) <> 0 AND NOT categorized.first_name_matches THEN 'First name' END,
      CASE WHEN (categorized.direct_pii_presence_mask & 2) <> 0 AND NOT categorized.last_name_matches THEN 'Last name' END,
      CASE WHEN (categorized.direct_pii_presence_mask & 4) <> 0 AND NOT categorized.preferred_name_matches THEN 'Preferred name' END,
      CASE WHEN NULLIF(btrim(categorized.normalized_json ->> 'department'), '') IS NOT NULL
        AND btrim(categorized.normalized_json ->> 'department') IS DISTINCT FROM btrim(categorized.existing_department) THEN 'Department' END,
      CASE WHEN NULLIF(btrim(categorized.normalized_json ->> 'section'), '') IS NOT NULL
        AND btrim(categorized.normalized_json ->> 'section') IS DISTINCT FROM btrim(categorized.existing_section) THEN 'Section' END,
      CASE WHEN NULLIF(btrim(categorized.normalized_json ->> 'classification'), '') IS NOT NULL
        AND btrim(categorized.normalized_json ->> 'classification') IS DISTINCT FROM btrim(categorized.existing_classification) THEN 'Classification' END,
      CASE WHEN NULLIF(btrim(categorized.normalized_json ->> 'work_location'), '') IS NOT NULL
        AND btrim(categorized.normalized_json ->> 'work_location') IS DISTINCT FROM btrim(categorized.existing_work_location) THEN 'Work location' END,
      CASE WHEN NULLIF(btrim(categorized.normalized_json ->> 'membership_status'), '') IS NOT NULL
        AND btrim(categorized.normalized_json ->> 'membership_status') IS DISTINCT FROM btrim(categorized.existing_membership_status) THEN 'Membership status' END,
      CASE WHEN (categorized.direct_pii_presence_mask & 8) <> 0 AND NOT categorized.primary_work_email_matches THEN 'Work email' END,
      CASE WHEN (categorized.direct_pii_presence_mask & 16) <> 0 AND NOT categorized.employee_identifier_matches THEN 'Employee identifier' END,
      CASE WHEN (categorized.direct_pii_presence_mask & 32) <> 0 AND NOT categorized.member_identifier_matches THEN 'Member identifier' END,
      CASE WHEN (categorized.direct_pii_presence_mask & 64) <> 0 AND NOT categorized.personal_email_matches THEN 'Personal email' END
    ], NULL)::text[] AS change_fields,
    array_remove(ARRAY[
      CASE WHEN categorized.row_state = 'rejected' THEN 'Source row was rejected during validation.' END,
      CASE WHEN categorized.error_count > 0 THEN 'One or more blocking validation errors are attached to this row.' END,
      CASE WHEN categorized.person_count > 1 THEN 'More than one existing person matches the authoritative identity evidence.' END,
      CASE WHEN categorized.person_count = 1 AND NOT categorized.existing_person_active THEN 'The exact identity match points to an inactive person record.' END,
      CASE WHEN categorized.row_hash IS NULL OR categorized.direct_pii_field_set_version NOT IN (2, 3, 4)
        OR categorized.direct_pii_presence_mask IS NULL OR categorized.direct_pii_validity_mask IS NULL
        THEN 'Protected identity metadata is incomplete for this row.' END,
      CASE WHEN categorized.direct_pii_presence_mask IS NOT NULL AND categorized.direct_pii_validity_mask IS NOT NULL
        AND (categorized.direct_pii_presence_mask & categorized.direct_pii_validity_mask) <> categorized.direct_pii_presence_mask
        THEN 'One or more supplied direct identity fields failed validation.' END,
      CASE WHEN categorized.direct_pii_presence_mask IS NOT NULL
        AND ((categorized.direct_pii_presence_mask & 1) = 0 OR (categorized.direct_pii_presence_mask & 2) = 0)
        THEN 'A required first or last name is missing.' END,
      CASE WHEN categorized.direct_pii_presence_mask IS NOT NULL
        AND (categorized.direct_pii_presence_mask & 16) = 0
        AND (categorized.direct_pii_presence_mask & 32) = 0
        AND (categorized.direct_pii_presence_mask & 8) = 0
        THEN 'No employee identifier, member identifier, or work email is available for exact identity matching.' END,
      CASE WHEN categorized.person_count = 0 AND categorized.category = 'proposed_new' THEN 'No exact authoritative identity match was found.' END
    ], NULL)::text[] AS reasons
  FROM categorized
  JOIN requested requested_row
    ON requested_row.sheet_name = categorized.sheet_name
   AND requested_row.source_row_number = categorized.source_row_number
  ORDER BY categorized.sheet_name, categorized.source_row_number`;

export async function getImportReviewExplanations(
  actor: ImportReviewActor,
  batchId: string,
  coordinates: readonly ImportReviewCoordinate[],
  query: DatabaseQuery = queryLocal801,
): Promise<ImportReviewExplanation[]> {
  validate(actor, batchId, coordinates);
  if (coordinates.length === 0 || !isPiiProtectedReadEnabled()) return [];
  const requested = JSON.stringify(coordinates.map((item) => ({
    sheet_name: item.sheetName,
    source_row_number: item.sourceRowNumber,
  })));
  const rows = await query<ExplanationRow>(`WITH requested AS (
      SELECT item.sheet_name, item.source_row_number
      FROM jsonb_to_recordset($3::text::jsonb) AS item(sheet_name text, source_row_number integer)
    ), ${PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE}
    ${PROTECTED_EXPLANATION_SELECT}`, [actor.organizationId, batchId, requested]);
  return rows.map((row) => ({
    sheetName: row.sheet_name,
    sourceRowNumber: Number(row.source_row_number),
    category: row.category,
    changeFields: Array.isArray(row.change_fields) ? row.change_fields.filter(Boolean) : [],
    reasons: Array.isArray(row.reasons) ? row.reasons.filter(Boolean) : [],
  }));
}

export function explanationKey(sheetName: string, sourceRowNumber: number) {
  return `${sheetName}\u001f${sourceRowNumber}`;
}
