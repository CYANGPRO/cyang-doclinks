import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import { outreachHandle } from "./outreach.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  openPiiCursor,
  sealPiiCursor,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode, PiiProtectedReadError } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const DATA_QUALITY_PAGE_SIZES = [25, 50] as const;
export type DataQualityIssueCode =
  | "missing_identifier"
  | "missing_work_email"
  | "missing_department"
  | "missing_classification"
  | "missing_work_location"
  | "unknown_membership"
  | "not_in_latest_roster";
export type DataQualityIssueFilter = "all" | DataQualityIssueCode;

export const DATA_QUALITY_ISSUES: ReadonlyArray<{ code: DataQualityIssueCode; label: string; explanation: string }> = [
  { code: "missing_identifier", label: "Missing employee reference", explanation: "The permanent Local 801 employee reference is missing." },
  { code: "missing_work_email", label: "Missing work email", explanation: "No active work-email contact method is recorded." },
  { code: "missing_department", label: "Missing department", explanation: "The current operational record has no department." },
  { code: "missing_classification", label: "Missing classification", explanation: "The current operational record has no classification." },
  { code: "missing_work_location", label: "Missing work location", explanation: "The current operational record has no work location." },
  { code: "unknown_membership", label: "Membership status needs review", explanation: "The current membership status is unknown or outside the recognized member/nonmember states." },
  { code: "not_in_latest_roster", label: "Not in latest approved roster", explanation: "The person is active in Engaging Local 801 but is absent from the latest approved membership snapshot. This does not infer a drop, separation, or archive." },
] as const;

export type DataQualitySummary = {
  flaggedPeople: number;
  missingIdentifier: number;
  missingWorkEmail: number;
  missingDepartment: number;
  missingClassification: number;
  missingWorkLocation: number;
  unknownMembership: number;
  notInLatestRoster: number;
  latestRosterAvailable: boolean;
};

export type DataQualityPerson = {
  handle: string;
  displayName: string;
  membershipStatus: string;
  department: string | null;
  classification: string | null;
  workLocation: string | null;
  updatedAt: string | null;
  issues: DataQualityIssueCode[];
};

export type DataQualityQueuePage = {
  people: DataQualityPerson[];
  summary: DataQualitySummary;
  issue: DataQualityIssueFilter;
  pageSize: 25 | 50;
  nextCursor: string | null;
};

export type DataQualitySearchInput = {
  issue?: unknown;
  pageSize?: unknown;
  cursor?: unknown;
};

type QualityFactsRow = {
  person_id: string;
  membership_status: string | null;
  department: string | null;
  classification: string | null;
  work_location: string | null;
  updated_at: string | Date | null;
  missing_identifier: boolean;
  missing_work_email: boolean;
  missing_department: boolean;
  missing_classification: boolean;
  missing_work_location: boolean;
  unknown_membership: boolean;
  not_in_latest_roster: boolean;
  first_name_encrypted_payload: string;
  first_name_encryption_key_version: string;
  first_name_encryption_format_version: number;
  last_name_encrypted_payload: string;
  last_name_encryption_key_version: string;
  last_name_encryption_format_version: number;
  preferred_name_encrypted_payload: string | null;
  preferred_name_encryption_key_version: string | null;
  preferred_name_encryption_format_version: number | null;
};

type SummaryRow = {
  flagged_people: unknown;
  missing_identifier: unknown;
  missing_work_email: unknown;
  missing_department: unknown;
  missing_classification: unknown;
  missing_work_location: unknown;
  unknown_membership: unknown;
  not_in_latest_roster: unknown;
  latest_roster_available: boolean | null;
};

type Cursor = { id: string };
const CURSOR_PURPOSE = "data-quality-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_CODES = new Set<DataQualityIssueCode>(DATA_QUALITY_ISSUES.map((item) => item.code));

export const DATA_QUALITY_FACTS_CTE = `
  latest_snapshot AS (
    SELECT snapshot.id
    FROM local801.membership_snapshots snapshot
    WHERE snapshot.organization_id = $1::uuid AND snapshot.status = 'approved'
    ORDER BY snapshot.snapshot_date DESC, snapshot.created_at DESC, snapshot.id DESC
    LIMIT 1
  ),
  quality_facts AS (
    SELECT person.id AS person_id, person.membership_status, person.department, person.classification,
      person.work_location, person.updated_at,
      person.employee_reference IS NULL AS missing_identifier,
      NOT EXISTS (
        SELECT 1 FROM local801.person_contact_methods contact
        WHERE contact.organization_id = person.organization_id AND contact.person_id = person.id
          AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
      ) AS missing_work_email,
      NULLIF(btrim(person.department), '') IS NULL AS missing_department,
      NULLIF(btrim(person.classification), '') IS NULL AS missing_classification,
      NULLIF(btrim(person.work_location), '') IS NULL AS missing_work_location,
      (person.membership_status IS NULL OR person.membership_status NOT IN ('member', 'nonmember')) AS unknown_membership,
      (EXISTS (SELECT 1 FROM latest_snapshot) AND NOT EXISTS (
        SELECT 1 FROM latest_snapshot snapshot
        JOIN local801.membership_snapshot_rows snapshot_row
          ON snapshot_row.organization_id = person.organization_id AND snapshot_row.snapshot_id = snapshot.id
        WHERE snapshot_row.person_id = person.id
      )) AS not_in_latest_roster
    FROM local801.people person
    WHERE person.organization_id = $1::uuid AND person.archived_at IS NULL
  )`;

function scalar(value: unknown) {
  if (Array.isArray(value)) return scalar(value[0]);
  return typeof value === "string" ? value : "";
}

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeDataQualitySearch(input: DataQualitySearchInput) {
  const candidate = scalar(input.issue).trim() as DataQualityIssueCode;
  const issue: DataQualityIssueFilter = ISSUE_CODES.has(candidate) ? candidate : "all";
  const requestedSize = Number(scalar(input.pageSize));
  const pageSize: 25 | 50 = requestedSize === 50 ? 50 : 25;
  return { issue, pageSize };
}

function protectedReadFailure(message: string): never {
  throw new PiiProtectedReadError("DATA_QUALITY_PROTECTED_READ", message);
}

function encrypted(row: Record<string, unknown>, payload: string, key: string, format: string) {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[key];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    protectedReadFailure("A protected data-quality record has an invalid encrypted field.");
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 } satisfies Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion">;
}

function decodeCursor(value: unknown, organizationId: string, config: PiiKeyConfiguration): Cursor | null {
  const raw = scalar(value);
  if (!raw || raw.length > 2000) return null;
  try {
    const parsed = openPiiCursor<Cursor>(raw, { organizationId, purpose: CURSOR_PURPOSE }, config);
    return parsed && typeof parsed.id === "string" && UUID_RE.test(parsed.id) ? { id: parsed.id } : null;
  } catch {
    return null;
  }
}

function encodeCursor(id: string, organizationId: string, config: PiiKeyConfiguration) {
  return sealPiiCursor({ id }, { organizationId, purpose: CURSOR_PURPOSE }, config);
}

function issues(row: QualityFactsRow): DataQualityIssueCode[] {
  const result: DataQualityIssueCode[] = [];
  if (row.missing_identifier) result.push("missing_identifier");
  if (row.missing_work_email) result.push("missing_work_email");
  if (row.missing_department) result.push("missing_department");
  if (row.missing_classification) result.push("missing_classification");
  if (row.missing_work_location) result.push("missing_work_location");
  if (row.unknown_membership) result.push("unknown_membership");
  if (row.not_in_latest_roster) result.push("not_in_latest_roster");
  return result;
}

function decryptDisplayName(row: QualityFactsRow, organizationId: string, config: PiiKeyConfiguration) {
  const source = row as unknown as Record<string, unknown>;
  const firstName = decryptPiiField(
    encrypted(source, "first_name_encrypted_payload", "first_name_encryption_key_version", "first_name_encryption_format_version"),
    { organizationId, entity: "person", recordId: row.person_id, field: "first-name" }, config,
  );
  const lastName = decryptPiiField(
    encrypted(source, "last_name_encrypted_payload", "last_name_encryption_key_version", "last_name_encryption_format_version"),
    { organizationId, entity: "person", recordId: row.person_id, field: "last-name" }, config,
  );
  let preferredName: string | null = null;
  if (row.preferred_name_encrypted_payload !== null) {
    preferredName = decryptPiiField(
      encrypted(source, "preferred_name_encrypted_payload", "preferred_name_encryption_key_version", "preferred_name_encryption_format_version"),
      { organizationId, entity: "person", recordId: row.person_id, field: "preferred-name" }, config,
    );
  }
  return preferredName?.trim() || `${firstName} ${lastName}`.trim();
}

export async function getDataQualitySummary(
  context: Pick<WorkspaceContext, "organizationId" | "role">,
  query: DatabaseQuery = queryLocal801,
): Promise<DataQualitySummary> {
  if (!can(context.role, "viewReports") && !can(context.role, "manageImports")) throw new Error("Forbidden.");
  const [row] = await query<SummaryRow>(`
    /* data-quality:summary */
    WITH ${DATA_QUALITY_FACTS_CTE}
    SELECT
      count(*) FILTER (WHERE missing_identifier OR missing_work_email OR missing_department OR missing_classification
        OR missing_work_location OR unknown_membership OR not_in_latest_roster) AS flagged_people,
      count(*) FILTER (WHERE missing_identifier) AS missing_identifier,
      count(*) FILTER (WHERE missing_work_email) AS missing_work_email,
      count(*) FILTER (WHERE missing_department) AS missing_department,
      count(*) FILTER (WHERE missing_classification) AS missing_classification,
      count(*) FILTER (WHERE missing_work_location) AS missing_work_location,
      count(*) FILTER (WHERE unknown_membership) AS unknown_membership,
      count(*) FILTER (WHERE not_in_latest_roster) AS not_in_latest_roster,
      EXISTS (SELECT 1 FROM latest_snapshot) AS latest_roster_available
    FROM quality_facts
  `, [context.organizationId]);
  return {
    flaggedPeople: count(row?.flagged_people),
    missingIdentifier: count(row?.missing_identifier),
    missingWorkEmail: count(row?.missing_work_email),
    missingDepartment: count(row?.missing_department),
    missingClassification: count(row?.missing_classification),
    missingWorkLocation: count(row?.missing_work_location),
    unknownMembership: count(row?.unknown_membership),
    notInLatestRoster: count(row?.not_in_latest_roster),
    latestRosterAvailable: Boolean(row?.latest_roster_available),
  };
}

export async function getDataQualityQueue(
  context: WorkspaceContext,
  input: DataQualitySearchInput,
  query: DatabaseQuery = queryLocal801,
): Promise<DataQualityQueuePage> {
  if (!can(context.role, "manageImports")) throw new Error("Forbidden.");
  const mode = getPiiProtectedReadMode();
  if (mode === "legacy") protectedReadFailure("Operational data quality requires protected PII reads.");
  await assertPiiProtectedReadState(context.organizationId, query, mode);
  const config = getPiiKeyConfiguration();
  const normalized = normalizeDataQualitySearch(input);
  const cursor = decodeCursor(input.cursor, context.organizationId, config);
  const summary = await getDataQualitySummary(context, query);
  const rows = await query<QualityFactsRow>(`
    /* data-quality:action-queue */
    WITH ${DATA_QUALITY_FACTS_CTE}
    SELECT facts.person_id::text, facts.membership_status, facts.department, facts.classification,
      facts.work_location, facts.updated_at, facts.missing_identifier, facts.missing_work_email,
      facts.missing_department, facts.missing_classification, facts.missing_work_location,
      facts.unknown_membership, facts.not_in_latest_roster,
      protected.first_name_encrypted_payload, protected.first_name_encryption_key_version, protected.first_name_encryption_format_version,
      protected.last_name_encrypted_payload, protected.last_name_encryption_key_version, protected.last_name_encryption_format_version,
      protected.preferred_name_encrypted_payload, protected.preferred_name_encryption_key_version, protected.preferred_name_encryption_format_version
    FROM quality_facts facts
    JOIN local801.person_pii protected
      ON protected.organization_id = $1::uuid AND protected.person_id = facts.person_id
    WHERE (facts.missing_identifier OR facts.missing_work_email OR facts.missing_department OR facts.missing_classification
      OR facts.missing_work_location OR facts.unknown_membership OR facts.not_in_latest_roster)
      AND (
        $2::text = 'all'
        OR ($2::text = 'missing_identifier' AND facts.missing_identifier)
        OR ($2::text = 'missing_work_email' AND facts.missing_work_email)
        OR ($2::text = 'missing_department' AND facts.missing_department)
        OR ($2::text = 'missing_classification' AND facts.missing_classification)
        OR ($2::text = 'missing_work_location' AND facts.missing_work_location)
        OR ($2::text = 'unknown_membership' AND facts.unknown_membership)
        OR ($2::text = 'not_in_latest_roster' AND facts.not_in_latest_roster)
      )
      AND ($3::uuid IS NULL OR facts.person_id > $3::uuid)
    ORDER BY facts.person_id
    LIMIT $4::int
  `, [context.organizationId, normalized.issue, cursor?.id ?? null, normalized.pageSize + 1]);

  const hasNext = rows.length > normalized.pageSize;
  const pageRows = rows.slice(0, normalized.pageSize);
  const people = pageRows.map((row) => ({
    handle: outreachHandle(context.organizationId, row.person_id),
    displayName: decryptDisplayName(row, context.organizationId, config),
    membershipStatus: row.membership_status ?? "unknown",
    department: row.department,
    classification: row.classification,
    workLocation: row.work_location,
    updatedAt: timestamp(row.updated_at),
    issues: issues(row),
  }));
  const last = pageRows.at(-1);
  return {
    people,
    summary,
    issue: normalized.issue,
    pageSize: normalized.pageSize,
    nextCursor: hasNext && last ? encodeCursor(last.person_id, context.organizationId, config) : null,
  };
}
