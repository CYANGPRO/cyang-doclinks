import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { DirectoryPage, DirectoryPerson, DirectorySearchInput } from "./directory.ts";
import { getEffectiveDirectoryScope, normalizeDirectorySearch } from "./directory.ts";
import { outreachHandle } from "./outreach.ts";
import {
  createPiiBlindIndex,
  decryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiEmail,
  normalizePiiNameForSearch,
  openPiiCursor,
  PiiProtectionError,
  sealPiiCursor,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode, PiiProtectedReadError } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const CANDIDATE_CAP = 25_000;
const CURSOR_PURPOSE = "directory-v1";

type CandidateRow = {
  person_id: string;
  employee_reference: number | string;
  membership_status: string | null;
  department: string | null;
  section: string | null;
  classification: string | null;
  work_location: string | null;
  hire_date: string | Date | null;
  job_status: string | null;
  first_name_encrypted_payload: string;
  first_name_encryption_key_version: string;
  first_name_encryption_format_version: number;
  last_name_encrypted_payload: string;
  last_name_encryption_key_version: string;
  last_name_encryption_format_version: number;
  preferred_name_encrypted_payload: string | null;
  preferred_name_encryption_key_version: string | null;
  preferred_name_encryption_format_version: number | null;
  name_sort_encrypted_payload: string;
  name_sort_encryption_key_version: string;
  name_sort_encryption_format_version: number;
};

type ContactRow = {
  person_id: string;
  contact_method_id: string;
  contact_type: "work_email" | "personal_email" | "phone";
  contact_label: "work" | "cell" | "home" | null;
  contact_value_encrypted_payload: string;
  encryption_key_version: string;
  encryption_format_version: number;
};

type ProtectedCursor = { direction: "after" | "before"; sort: string; id: string };
type SearchToken = { key_version: string; hash: string };
type EmailIndex = { key_version: string; hash: string } | null;

function blocked(code: string, message: string): never {
  throw new PiiProtectedReadError(code, message);
}

function scalarString(value: unknown) {
  if (Array.isArray(value)) return scalarString(value[0]);
  return typeof value === "string" ? value : "";
}

function encrypted(row: Record<string, unknown>, payload: string, key: string, format: string) {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[key];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    blocked("ENVELOPE_INVALID", "A protected Directory record has an invalid encrypted field.");
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 } satisfies Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion">;
}

function decryptCandidate(row: CandidateRow, organizationId: string, config: PiiKeyConfiguration) {
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
  const sort = decryptPiiField(
    encrypted(source, "name_sort_encrypted_payload", "name_sort_encryption_key_version", "name_sort_encryption_format_version"),
    { organizationId, entity: "person", recordId: row.person_id, field: "name-sort" }, config,
  );
  return { row, firstName, lastName, preferredName, sort };
}

function searchMaterial(term: string, organizationId: string, config: PiiKeyConfiguration) {
  if (!term) return { tokens: [] as SearchToken[], email: null as EmailIndex };
  const normalizedName = normalizePiiNameForSearch(term);
  const words = normalizedName.split(" ").filter((word) => Array.from(word).length >= 3);
  const tokens = words.map((word) => {
    const prefix = Array.from(word).slice(0, 20).join("");
    const index = createPiiBlindIndex(prefix, { organizationId, domain: "search:combined-name:prefix" }, config);
    return { key_version: index.blindIndexKeyVersion, hash: index.blindIndex };
  });
  let email: EmailIndex = null;
  try {
    const normalizedEmail = normalizePiiEmail(term);
    const index = createPiiBlindIndex(normalizedEmail, { organizationId, domain: "contact:work-email" }, config);
    email = { key_version: index.blindIndexKeyVersion, hash: index.blindIndex };
  } catch (error) {
    if (!(error instanceof PiiProtectionError) || error.code !== "NORMALIZATION_FAILED") throw error;
  }
  return { tokens, email };
}

function decodeCursor(raw: unknown, organizationId: string, config: PiiKeyConfiguration): ProtectedCursor | null {
  const value = scalarString(raw);
  if (!value) return null;
  try {
    const parsed = openPiiCursor<ProtectedCursor>(value, { organizationId, purpose: CURSOR_PURPOSE }, config);
    if (!parsed || (parsed.direction !== "after" && parsed.direction !== "before")
      || typeof parsed.sort !== "string" || parsed.sort.length > 1000
      || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return parsed;
  } catch (error) {
    if (error instanceof PiiProtectionError && ["CURSOR_INVALID", "CURSOR_EXPIRED", "KEY_NOT_FOUND"].includes(error.code)) return null;
    throw error;
  }
}

function encodeCursor(direction: "after" | "before", sort: string, id: string, organizationId: string, config: PiiKeyConfiguration) {
  return sealPiiCursor({ direction, sort, id }, { organizationId, purpose: CURSOR_PURPOSE }, config);
}

function membershipStatus(value: string | null): DirectoryPerson["membershipStatus"] {
  return value === "member" || value === "nonmember" || value === "unknown" ? value : null;
}

export async function getProtectedDirectoryPage(
  context: WorkspaceContext,
  input: DirectorySearchInput,
  query: DatabaseQuery = queryLocal801,
): Promise<DirectoryPage> {
  if (!can(context.role, "viewDirectory")) throw new Error("Directory access is forbidden.");
  const mode = getPiiProtectedReadMode();
  if (mode === "legacy") blocked("PROTECTED_READ_OFF", "Protected Directory query called while protected reads are disabled.");
  await assertPiiProtectedReadState(context.organizationId, query, mode);
  const config = getPiiKeyConfiguration();
  const normalized = normalizeDirectorySearch({ ...input, cursor: undefined });
  const effectiveScope = getEffectiveDirectoryScope(context.role, normalized.requestedScope);
  const cursor = decodeCursor(input.cursor, context.organizationId, config);
  const search = searchMaterial(normalized.term, context.organizationId, config);
  const assignmentRequired = effectiveScope === "assigned";
  const operationalPattern = normalized.term ? `%${normalized.term.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : null;
  const candidates = await query<CandidateRow>(`
    /* pii-protected-directory:candidates */
    WITH search_tokens AS (
      SELECT token.key_version, token.hash
      FROM jsonb_to_recordset($11::text::jsonb) AS token(key_version text, hash text)
    )
    SELECT person.id::text AS person_id, person.employee_reference, person.membership_status, person.department, person.section,
      person.classification, person.work_location, person.hire_date, person.job_status,
      protected.first_name_encrypted_payload, protected.first_name_encryption_key_version, protected.first_name_encryption_format_version,
      protected.last_name_encrypted_payload, protected.last_name_encryption_key_version, protected.last_name_encryption_format_version,
      protected.preferred_name_encrypted_payload, protected.preferred_name_encryption_key_version, protected.preferred_name_encryption_format_version,
      protected.name_sort_encrypted_payload, protected.name_sort_encryption_key_version, protected.name_sort_encryption_format_version
    FROM local801.people person
    JOIN local801.person_pii protected
      ON protected.organization_id = person.organization_id AND protected.person_id = person.id
    WHERE person.organization_id = $1::uuid AND person.archived_at IS NULL
      AND (NOT $3::boolean OR EXISTS (
        SELECT 1 FROM local801.engagement_assignments assignment
        WHERE assignment.organization_id = $1::uuid AND assignment.person_id = person.id
          AND assignment.archived_at IS NULL AND assignment.status = 'open'
          AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
      ))
      AND ($4::text IS NULL OR person.membership_status = $4::text)
      AND ($5::text IS NULL OR person.department ILIKE $5::text ESCAPE '\\')
      AND ($6::text IS NULL OR lower(btrim(person.classification)) = lower(btrim($6::text)))
      AND ($7::text IS NULL OR person.work_location ILIKE $7::text ESCAPE '\\')
      AND ($8::text IS NULL
        OR person.department ILIKE $8::text ESCAPE '\\'
        OR person.classification ILIKE $8::text ESCAPE '\\'
        OR person.work_location ILIKE $8::text ESCAPE '\\'
        OR (jsonb_array_length($11::text::jsonb) > 0 AND NOT EXISTS (
          SELECT 1 FROM search_tokens wanted
          WHERE NOT EXISTS (
            SELECT 1 FROM local801.person_search_tokens stored
            WHERE stored.organization_id = $1::uuid AND stored.person_id = person.id
              AND stored.token_domain = 'combined_name' AND stored.token_kind = 'prefix'
              AND stored.token_key_version = wanted.key_version AND stored.token_hash = wanted.hash
          )
        ))
        OR ($9::text IS NOT NULL AND EXISTS (
          SELECT 1
          FROM local801.person_contact_methods contact
          JOIN local801.pii_exact_indexes email_index
            ON email_index.organization_id = contact.organization_id
            AND email_index.entity_type = 'person_contact_method'
            AND email_index.entity_id = contact.id
            AND email_index.index_domain = 'contact:work-email'
            AND email_index.index_key_version = $9::text
            AND email_index.index_hash = $10::text
          WHERE contact.organization_id = $1::uuid AND contact.person_id = person.id
            AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
        )))
    ORDER BY person.id
    LIMIT ${CANDIDATE_CAP + 1}
  `, [
    context.organizationId,
    context.userId,
    assignmentRequired,
    normalized.membershipStatus || null,
    normalized.department ? `%${normalized.department.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : null,
    normalized.classification || null,
    normalized.workLocation ? `%${normalized.workLocation.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : null,
    operationalPattern,
    search.email?.key_version ?? null,
    search.email?.hash ?? null,
    JSON.stringify(search.tokens),
  ]);
  if (candidates.length > CANDIDATE_CAP) {
    blocked("DIRECTORY_CANDIDATE_CAP", "The protected Directory candidate set is too large. Narrow the search or filters.");
  }

  let hydrated = candidates.map((row) => decryptCandidate(row, context.organizationId, config));
  hydrated.sort((left, right) => left.sort.localeCompare(right.sort) || left.row.person_id.localeCompare(right.row.person_id));
  const total = hydrated.length;
  if (cursor) {
    hydrated = hydrated.filter((item) => cursor.direction === "before"
      ? item.sort < cursor.sort || (item.sort === cursor.sort && item.row.person_id < cursor.id)
      : item.sort > cursor.sort || (item.sort === cursor.sort && item.row.person_id > cursor.id));
  }
  if (cursor?.direction === "before") hydrated.reverse();
  const hasExtra = hydrated.length > normalized.pageSize;
  let page = hydrated.slice(0, normalized.pageSize);
  if (cursor?.direction === "before") page = page.reverse();

  const pageIds = page.map((item) => item.row.person_id);
  const contacts = pageIds.length ? await query<ContactRow>(`
    /* pii-protected-directory:page-contact-details */
    WITH requested AS (
      SELECT value.person_id::uuid AS person_id FROM jsonb_to_recordset($3::text::jsonb) AS value(person_id text)
    )
    SELECT DISTINCT ON (contact.person_id, contact.contact_type, contact.contact_label)
      contact.person_id::text, contact.id::text AS contact_method_id, contact.contact_type, contact.contact_label,
      protected.contact_value_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version
    FROM requested
    JOIN local801.person_contact_methods contact
      ON contact.organization_id = $1::uuid AND contact.person_id = requested.person_id
      AND contact.contact_type IN ('work_email','personal_email','phone')
      AND contact.is_primary = true AND contact.archived_at IS NULL
    JOIN local801.person_contact_method_pii protected
      ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
    WHERE (($2::boolean AND contact.visibility IN ('authorized_directory','assigned_only'))
      OR (NOT $2::boolean AND contact.visibility = 'authorized_directory'))
    ORDER BY contact.person_id, contact.contact_type, contact.contact_label, contact.created_at DESC, contact.id DESC
  `, [context.organizationId, assignmentRequired, JSON.stringify(pageIds.map((person_id) => ({ person_id })))]) : [];
  const contactByPerson = new Map<string, Map<string, ContactRow>>();
  for (const row of contacts) {
    const bucket = contactByPerson.get(row.person_id) ?? new Map<string, ContactRow>();
    const key = row.contact_type === "phone" ? `${row.contact_type}:${row.contact_label ?? ""}` : row.contact_type;
    bucket.set(key, row);
    contactByPerson.set(row.person_id, bucket);
  }
  const mayViewMembershipStatus = can(context.role, "viewPersonLevelReports") || can(context.role, "recordEngagement");
  const people: DirectoryPerson[] = page.map((item) => {
    const contact = contactByPerson.get(item.row.person_id);
    const contactValue = (key: string) => {
      const row = contact?.get(key);
      return row ? decryptPiiField(
        encrypted(row as unknown as Record<string, unknown>, "contact_value_encrypted_payload", "encryption_key_version", "encryption_format_version"),
        { organizationId: context.organizationId, entity: "person-contact", recordId: row.contact_method_id, field: "contact-value" }, config,
      ) : null;
    };
    return {
      handle: outreachHandle(context.organizationId, item.row.person_id),
      employeeReference: `L801-${String(item.row.employee_reference).padStart(6, "0")}`,
      displayName: item.preferredName?.trim() || `${item.firstName} ${item.lastName}`,
      firstName: item.firstName,
      lastName: item.lastName,
      membershipStatus: mayViewMembershipStatus ? membershipStatus(item.row.membership_status) : null,
      department: item.row.department,
      section: item.row.section,
      classification: item.row.classification,
      workLocation: item.row.work_location,
      hireDate: item.row.hire_date instanceof Date ? item.row.hire_date.toISOString().slice(0, 10) : item.row.hire_date?.slice(0, 10) ?? null,
      jobStatus: item.row.job_status,
      workEmail: contactValue("work_email"),
      homeEmail: contactValue("personal_email"),
      workPhone: contactValue("phone:work"),
      cellPhone: contactValue("phone:cell"),
      homePhone: contactValue("phone:home"),
    };
  });

  const first = page[0];
  const last = page.at(-1);
  return {
    people,
    term: normalized.term,
    pageSize: normalized.pageSize,
    total,
    previousCursor: first && (cursor?.direction === "after" || (cursor?.direction === "before" && hasExtra))
      ? encodeCursor("before", first.sort, first.row.person_id, context.organizationId, config) : null,
    nextCursor: last && (hasExtra || cursor?.direction === "before")
      ? encodeCursor("after", last.sort, last.row.person_id, context.organizationId, config) : null,
    requestedScope: normalized.requestedScope,
    effectiveScope,
    filters: {
      membershipStatus: normalized.membershipStatus,
      department: normalized.department,
      classification: normalized.classification,
      workLocation: normalized.workLocation,
    },
  };
}
