import "server-only";

import { can, type Role } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import { outreachHandle } from "./outreach.ts";
import { getPiiProtectedReadMode } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const DEFAULT_DIRECTORY_PAGE_SIZE = 50;
export const MAX_DIRECTORY_PAGE_SIZE = 100;
export const DIRECTORY_PAGE_SIZES = [25, 50, 100] as const;
export const MAX_DIRECTORY_SEARCH_LENGTH = 100;
const MAX_FILTER_LENGTH = 80;

export type DirectoryScope = "assigned" | "authorized";
type CursorDirection = "after" | "before";
type DirectoryCursor = { direction: CursorDirection; lastName: string; firstName: string; id: string };

export type DirectorySearchInput = {
  term?: unknown;
  pageSize?: unknown;
  scope?: unknown;
  cursor?: unknown;
  membershipStatus?: unknown;
  department?: unknown;
  classification?: unknown;
  workLocation?: unknown;
};

export type NormalizedDirectorySearch = {
  term: string;
  pageSize: number;
  requestedScope: DirectoryScope;
  cursor: DirectoryCursor | null;
  membershipStatus: "member" | "nonmember" | "unknown" | "";
  department: string;
  classification: string;
  workLocation: string;
};

export type DirectoryPerson = {
  handle: string;
  displayName: string;
  firstName: string;
  lastName: string;
  membershipStatus: "member" | "nonmember" | "unknown" | null;
  department: string | null;
  section: string | null;
  classification: string | null;
  workLocation: string | null;
  hireDate: string | null;
  jobStatus: string | null;
  workEmail: string | null;
  homeEmail: string | null;
  workPhone: string | null;
  cellPhone: string | null;
  homePhone: string | null;
};

export type DirectoryPage = {
  people: DirectoryPerson[];
  term: string;
  pageSize: number;
  total: number;
  previousCursor: string | null;
  nextCursor: string | null;
  requestedScope: DirectoryScope;
  effectiveScope: DirectoryScope;
  filters: Pick<NormalizedDirectorySearch, "membershipStatus" | "department" | "classification" | "workLocation">;
};

type DirectoryRow = {
  person_id: string | null;
  preferred_name: string | null;
  first_name: string | null;
  last_name: string | null;
  membership_status: string | null;
  department: string | null;
  section: string | null;
  classification: string | null;
  work_location: string | null;
  hire_date: string | Date | null;
  job_status: string | null;
  work_email: string | null;
  home_email: string | null;
  work_phone: string | null;
  cell_phone: string | null;
  home_phone: string | null;
  total_count: number | string;
};

const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "membership_data_manager", "cat_admin"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DirectoryAccessError extends Error {
  constructor() { super("Directory access is forbidden."); this.name = "DirectoryAccessError"; }
}

function scalarString(value: unknown) {
  if (Array.isArray(value)) return scalarString(value[0]);
  return typeof value === "string" ? value : "";
}

function filterString(value: unknown) {
  return scalarString(value).trim().replace(/\s+/g, " ").slice(0, MAX_FILTER_LENGTH);
}

function pageSize(value: unknown) {
  const parsed = Number(scalarString(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_DIRECTORY_PAGE_SIZE) : DEFAULT_DIRECTORY_PAGE_SIZE;
}

function decodeCursor(value: unknown): DirectoryCursor | null {
  const raw = scalarString(value);
  if (!raw || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<DirectoryCursor>;
    if ((parsed.direction !== "after" && parsed.direction !== "before")
      || typeof parsed.lastName !== "string" || parsed.lastName.length > 200
      || typeof parsed.firstName !== "string" || parsed.firstName.length > 200
      || typeof parsed.id !== "string" || !uuidPattern.test(parsed.id)) return null;
    return { direction: parsed.direction, lastName: parsed.lastName, firstName: parsed.firstName, id: parsed.id };
  } catch { return null; }
}

function encodeCursor(direction: CursorDirection, row: DirectoryRow) {
  return Buffer.from(JSON.stringify({ direction, lastName: row.last_name, firstName: row.first_name, id: row.person_id }), "utf8").toString("base64url");
}

export function normalizeDirectorySearch(input: DirectorySearchInput): NormalizedDirectorySearch {
  const rawStatus = scalarString(input.membershipStatus);
  const rawScope = scalarString(input.scope);
  return {
    term: scalarString(input.term).trim().replace(/\s+/g, " ").slice(0, MAX_DIRECTORY_SEARCH_LENGTH),
    pageSize: Math.min(pageSize(input.pageSize), MAX_DIRECTORY_PAGE_SIZE),
    requestedScope: rawScope === "assigned" || (rawScope !== "authorized" && rawScope !== "") ? "assigned" : "authorized",
    cursor: decodeCursor(input.cursor),
    membershipStatus: rawStatus === "member" || rawStatus === "nonmember" || rawStatus === "unknown" ? rawStatus : "",
    department: filterString(input.department),
    classification: filterString(input.classification),
    workLocation: filterString(input.workLocation),
  };
}

export function getEffectiveDirectoryScope(role: Role, requestedScope: DirectoryScope): DirectoryScope {
  if (!can(role, "viewDirectory")) throw new DirectoryAccessError();
  return organizationWideRoles.has(role) ? requestedScope : "assigned";
}

function escapeLikePattern(value: string) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }
function like(value: string) { return value ? `%${escapeLikePattern(value)}%` : null; }
function membershipStatus(value: string | null): DirectoryPerson["membershipStatus"] {
  return value === "member" || value === "nonmember" || value === "unknown" ? value : null;
}

export async function getDirectoryPage(context: WorkspaceContext, input: DirectorySearchInput, query: DatabaseQuery = queryLocal801): Promise<DirectoryPage> {
  if (!can(context.role, "viewDirectory")) throw new DirectoryAccessError();
  if (getPiiProtectedReadMode() !== "legacy") {
    const { getProtectedDirectoryPage } = await import("./pii-protected-directory.ts");
    return getProtectedDirectoryPage(context, input, query);
  }
  const normalized = normalizeDirectorySearch(input);
  const effectiveScope = getEffectiveDirectoryScope(context.role, normalized.requestedScope);
  const organizationWide = effectiveScope === "authorized";
  const assignmentConstraint = `AND ($12::boolean OR EXISTS (
    SELECT 1 FROM local801.engagement_assignments assignment
    WHERE assignment.organization_id = $1::uuid AND assignment.person_id = person.id
      AND assignment.archived_at IS NULL AND assignment.status = 'open'
      AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
  ))`;
  const contactConstraint = effectiveScope === "assigned"
    ? "AND contact.visibility IN ('authorized_directory', 'assigned_only')"
    : "AND contact.visibility = 'authorized_directory'";
  const cursor = normalized.cursor;
  const cursorComparison = `AND ($4::text IS NULL OR
    (person.last_name, person.first_name, person.person_id) ${cursor?.direction === "before" ? "<" : ">"}
      ($4::text, $5::text, $6::uuid))`;
  const ordering = cursor?.direction === "before" ? "DESC" : "ASC";
  const rows = await query<DirectoryRow>(`
    /* directory:keyset-page */
    WITH filtered_people AS (
      SELECT person.id AS person_id, person.preferred_name, person.first_name, person.last_name,
        person.membership_status, person.department, person.section, person.classification,
        person.work_location, person.hire_date, person.job_status,
        primary_work_email.contact_value AS work_email,
        contact_details.home_email, contact_details.work_phone, contact_details.cell_phone, contact_details.home_phone
      FROM local801.people person
      LEFT JOIN LATERAL (
        SELECT contact.contact_value FROM local801.person_contact_methods contact
        WHERE contact.organization_id = $1 AND contact.person_id = person.id
          AND contact.contact_type = 'work_email' AND contact.is_primary = true AND contact.archived_at IS NULL
          ${contactConstraint}
        ORDER BY contact.created_at, contact.id LIMIT 1
      ) primary_work_email ON true
      LEFT JOIN LATERAL (
        SELECT
          max(contact.contact_value) FILTER (WHERE contact.contact_type = 'personal_email' AND contact.contact_label = 'home') AS home_email,
          max(contact.contact_value) FILTER (WHERE contact.contact_type = 'phone' AND contact.contact_label = 'work') AS work_phone,
          max(contact.contact_value) FILTER (WHERE contact.contact_type = 'phone' AND contact.contact_label = 'cell') AS cell_phone,
          max(contact.contact_value) FILTER (WHERE contact.contact_type = 'phone' AND contact.contact_label = 'home') AS home_phone
        FROM local801.person_contact_methods contact
        WHERE contact.organization_id = $1 AND contact.person_id = person.id
          AND contact.archived_at IS NULL ${contactConstraint}
      ) contact_details ON true
      WHERE person.organization_id = $1 AND person.archived_at IS NULL
        ${assignmentConstraint}
        AND ($3::text IS NULL OR person.first_name ILIKE $3 ESCAPE '\\' OR person.last_name ILIKE $3 ESCAPE '\\'
          OR person.preferred_name ILIKE $3 ESCAPE '\\' OR person.department ILIKE $3 ESCAPE '\\'
          OR person.work_location ILIKE $3 ESCAPE '\\' OR person.classification ILIKE $3 ESCAPE '\\'
          OR primary_work_email.contact_value ILIKE $3 ESCAPE '\\')
        AND ($7::text IS NULL OR person.membership_status = $7)
        AND ($8::text IS NULL OR person.department ILIKE $8 ESCAPE '\\')
        AND ($9::text IS NULL OR person.classification ILIKE $9 ESCAPE '\\')
        AND ($10::text IS NULL OR person.work_location ILIKE $10 ESCAPE '\\')
    ), page_rows AS (
      SELECT * FROM filtered_people person
      WHERE true ${cursorComparison}
      ORDER BY last_name ${ordering}, first_name ${ordering}, person_id ${ordering}
      LIMIT $11::integer
    ), total AS (SELECT count(*) AS total_count FROM filtered_people)
    SELECT page_rows.*, total.total_count FROM total LEFT JOIN page_rows ON true
    ORDER BY page_rows.last_name ${ordering}, page_rows.first_name ${ordering}, page_rows.person_id ${ordering}
  `, [context.organizationId, context.userId, like(normalized.term), cursor?.lastName ?? null, cursor?.firstName ?? null,
    cursor?.id ?? null, normalized.membershipStatus || null, like(normalized.department), like(normalized.classification), like(normalized.workLocation), normalized.pageSize + 1,
    organizationWide]);

  const total = Number(rows[0]?.total_count ?? 0);
  let dataRows = rows.filter((row) => row.person_id && row.first_name && row.last_name);
  const hasExtra = dataRows.length > normalized.pageSize;
  dataRows = dataRows.slice(0, normalized.pageSize);
  if (cursor?.direction === "before") dataRows.reverse();
  const mayViewMembershipStatus = can(context.role, "viewPersonLevelReports") || can(context.role, "recordEngagement");
  const people = dataRows.map((row) => ({
    handle: outreachHandle(context.organizationId, row.person_id!),
    displayName: row.preferred_name?.trim() || `${row.first_name} ${row.last_name}`,
    firstName: row.first_name!, lastName: row.last_name!,
    membershipStatus: mayViewMembershipStatus ? membershipStatus(row.membership_status) : null,
    department: row.department, section: row.section, classification: row.classification,
    workLocation: row.work_location,
    hireDate: row.hire_date instanceof Date ? row.hire_date.toISOString().slice(0, 10) : row.hire_date?.slice(0, 10) ?? null,
    jobStatus: row.job_status,
    workEmail: row.work_email, homeEmail: row.home_email,
    workPhone: row.work_phone, cellPhone: row.cell_phone, homePhone: row.home_phone,
  }));
  return {
    people, term: normalized.term, pageSize: normalized.pageSize, total,
    previousCursor: dataRows[0] && (cursor?.direction === "after" || (cursor?.direction === "before" && hasExtra)) ? encodeCursor("before", dataRows[0]) : null,
    nextCursor: dataRows.length && (hasExtra || cursor?.direction === "before") ? encodeCursor("after", dataRows.at(-1)!) : null,
    requestedScope: normalized.requestedScope, effectiveScope,
    filters: { membershipStatus: normalized.membershipStatus, department: normalized.department, classification: normalized.classification, workLocation: normalized.workLocation },
  };
}
