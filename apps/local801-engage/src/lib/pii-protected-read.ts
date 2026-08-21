import "server-only";

import { createHash } from "node:crypto";
import type { DirectoryPage } from "./directory.ts";
import type { DatabaseQuery } from "./db.ts";
import { queryLocal801 } from "./db.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import type { TeamAccessPage } from "./team-access.ts";

const PREVIEW_ROW_LIMIT = 500;

export class PiiProtectedReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PiiProtectedReadError";
    this.code = code;
  }
}

export type PiiProtectedReadMode = "legacy" | "preview" | "protected";

type ProtectionStateRow = {
  write_mode: string;
  backfill_state: string;
  backfill_completed_at: string | Date | null;
  protected_read_enabled_at: string | Date | null;
  protected_write_enabled_at: string | Date | null;
  verified_at: string | Date | null;
};

type ProtectedUserRow = {
  user_id: string;
  email_encrypted_payload: string;
  email_encryption_key_version: string;
  email_encryption_format_version: number;
  display_name_encrypted_payload: string;
  display_name_encryption_key_version: string;
  display_name_encryption_format_version: number;
};

type ProtectedPersonRow = {
  person_id: string;
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

type ProtectedContactRow = {
  person_id: string;
  contact_method_id: string;
  contact_value_encrypted_payload: string;
  encryption_key_version: string;
  encryption_format_version: number;
};

function blocked(code: string, message: string): never {
  throw new PiiProtectedReadError(code, message);
}

export function getPiiProtectedReadMode(env: NodeJS.ProcessEnv = process.env): PiiProtectedReadMode {
  if (env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") {
    if (env.LOCAL801_PII_DUAL_WRITE_ENABLED === "1") blocked("DUAL_WRITE_ON", "PII dual-write must be disabled in protected-only mode.");
    if (env.LOCAL801_PII_BACKFILL_ENABLED === "1") blocked("BACKFILL_GATE_ON", "The PII backfill maintenance gate must be disabled in protected-only mode.");
    return "protected";
  }

  if (env.LOCAL801_PII_PROTECTED_READ_PREVIEW_ENABLED !== "1") return "legacy";
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "preview") blocked("NOT_PREVIEW", "Protected PII preview reads are allowed only in the Vercel Preview environment.");
  if (env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") blocked("PRODUCTION_LAUNCH_ON", "Production launch must remain disabled during protected-read Preview acceptance.");
  if (env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1") blocked("AUTHORITATIVE_IMPORT_ON", "Authoritative import execution must remain disabled during protected-read Preview acceptance.");
  if (env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1") blocked("DUAL_WRITE_OFF", "PII dual-write must remain enabled during protected-read Preview acceptance.");
  if (env.LOCAL801_PII_BACKFILL_ENABLED === "1") blocked("BACKFILL_GATE_ON", "The backfill maintenance gate must be off during protected-read Preview acceptance.");
  return "preview";
}

export function isPreviewProtectedPiiReadEnabled(env: NodeJS.ProcessEnv = process.env) {
  return getPiiProtectedReadMode(env) === "preview";
}

export function isPiiProtectedReadEnabled(env: NodeJS.ProcessEnv = process.env) {
  return getPiiProtectedReadMode(env) !== "legacy";
}

export async function assertPiiProtectedReadState(
  organizationId: string,
  query: DatabaseQuery,
  mode: PiiProtectedReadMode = getPiiProtectedReadMode(),
) {
  if (mode === "legacy") return;
  const [state] = await query<ProtectionStateRow>(`
    /* pii-protected-read:acceptance-state */
    SELECT write_mode, backfill_state, backfill_completed_at,
      protected_read_enabled_at, protected_write_enabled_at, verified_at
    FROM local801.pii_protection_state
    WHERE organization_id = $1::uuid
    LIMIT 1
  `, [organizationId]);
  if (!state) blocked("STATE_MISSING", "PII protection state is unavailable.");
  if (state.backfill_state !== "complete" || !state.backfill_completed_at) {
    blocked("BACKFILL_INCOMPLETE", "The protected PII backfill must be complete before protected reads are allowed.");
  }
  if (mode === "preview") {
    if (state.write_mode !== "dual") blocked("WRITE_MODE_INVALID", "PII write mode must remain dual during protected-read Preview acceptance.");
    if (state.protected_read_enabled_at || state.protected_write_enabled_at || state.verified_at) {
      blocked("CUTOVER_ALREADY_STARTED", "Database cutover markers must remain unset during protected-read Preview acceptance.");
    }
    return;
  }
  if (state.write_mode !== "protected") blocked("WRITE_MODE_INVALID", "Protected-only reads require the database write mode to be protected.");
  if (!state.protected_read_enabled_at || !state.protected_write_enabled_at || !state.verified_at) {
    blocked("CUTOVER_INCOMPLETE", "Protected-only reads require all verified database cutover markers.");
  }
}

function encrypted(
  row: Record<string, unknown>,
  payload: string,
  key: string,
  format: string,
): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[key];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    blocked("ENVELOPE_INVALID", "A protected PII companion has an invalid envelope.");
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 };
}

function teamHandle(organizationId: string, userId: string) {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

function personHandle(organizationId: string, personId: string) {
  return createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
}

function uniqueMap<T>(rows: readonly T[], key: (row: T) => string, label: string) {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) blocked("DUPLICATE_COMPANION", `Duplicate ${label} protected companion detected.`);
    result.set(id, row);
  }
  return result;
}

export async function hydrateTeamAccessPageFromProtectedPii(
  organizationId: string,
  page: TeamAccessPage,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<TeamAccessPage> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return page;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const rows = await query<ProtectedUserRow>(`
    /* pii-protected-read:team-users */
    SELECT user_id::text,
      email_encrypted_payload, email_encryption_key_version, email_encryption_format_version,
      display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version
    FROM local801.user_pii
    WHERE organization_id = $1::uuid
    ORDER BY user_id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId]);
  if (rows.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected user read exceeded its bounded row limit.");

  const byHandle = uniqueMap(rows, (row) => teamHandle(organizationId, row.user_id), "user");
  const members = page.members.map((member) => {
    const row = byHandle.get(member.handle);
    if (!row) blocked("COMPANION_MISSING", "A workspace user is missing its protected PII companion.");
    const source = row as unknown as Record<string, unknown>;
    const email = decryptPiiField(
      encrypted(source, "email_encrypted_payload", "email_encryption_key_version", "email_encryption_format_version"),
      { organizationId, entity: "user", recordId: row.user_id, field: "email" },
      keyConfig,
    );
    const displayName = decryptPiiField(
      encrypted(source, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"),
      { organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
      keyConfig,
    );
    return { ...member, email, displayName };
  });
  members.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle));
  return { ...page, members };
}

export async function hydrateDirectoryPageFromProtectedPii(
  organizationId: string,
  page: DirectoryPage,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<DirectoryPage> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return page;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const people = await query<ProtectedPersonRow>(`
    /* pii-protected-read:directory-people */
    SELECT person_id::text,
      first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
      last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
      preferred_name_encrypted_payload, preferred_name_encryption_key_version, preferred_name_encryption_format_version
    FROM local801.person_pii
    WHERE organization_id = $1::uuid
    ORDER BY person_id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId]);
  if (people.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected person read exceeded its bounded row limit.");

  const contacts = await query<ProtectedContactRow>(`
    /* pii-protected-read:directory-work-email */
    SELECT DISTINCT ON (contact.person_id)
      contact.person_id::text, contact.id::text AS contact_method_id,
      protected.contact_value_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version
    FROM local801.person_contact_methods contact
    JOIN local801.person_contact_method_pii protected
      ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
    WHERE contact.organization_id = $1::uuid
      AND contact.contact_type = 'work_email'
      AND contact.is_primary = true
      AND contact.archived_at IS NULL
      AND (($2::boolean AND contact.visibility IN ('authorized_directory','assigned_only'))
        OR (NOT $2::boolean AND contact.visibility = 'authorized_directory'))
    ORDER BY contact.person_id, contact.created_at, contact.id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId, page.effectiveScope === "assigned"]);
  if (contacts.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected contact read exceeded its bounded row limit.");

  const peopleByHandle = uniqueMap(people, (row) => personHandle(organizationId, row.person_id), "person");
  const contactByPersonId = uniqueMap(contacts, (row) => row.person_id, "primary work-email");

  return {
    ...page,
    people: page.people.map((person) => {
      const row = peopleByHandle.get(person.handle);
      if (!row) blocked("COMPANION_MISSING", "A directory person is missing its protected PII companion.");
      const source = row as unknown as Record<string, unknown>;
      const firstName = decryptPiiField(
        encrypted(source, "first_name_encrypted_payload", "first_name_encryption_key_version", "first_name_encryption_format_version"),
        { organizationId, entity: "person", recordId: row.person_id, field: "first-name" },
        keyConfig,
      );
      const lastName = decryptPiiField(
        encrypted(source, "last_name_encrypted_payload", "last_name_encryption_key_version", "last_name_encryption_format_version"),
        { organizationId, entity: "person", recordId: row.person_id, field: "last-name" },
        keyConfig,
      );
      let preferredName: string | null = null;
      if (row.preferred_name_encrypted_payload !== null) {
        preferredName = decryptPiiField(
          encrypted(source, "preferred_name_encrypted_payload", "preferred_name_encryption_key_version", "preferred_name_encryption_format_version"),
          { organizationId, entity: "person", recordId: row.person_id, field: "preferred-name" },
          keyConfig,
        );
      }

      const contact = contactByPersonId.get(row.person_id);
      const workEmail = contact ? decryptPiiField(
        encrypted(contact as unknown as Record<string, unknown>, "contact_value_encrypted_payload", "encryption_key_version", "encryption_format_version"),
        { organizationId, entity: "person-contact", recordId: contact.contact_method_id, field: "contact-value" },
        keyConfig,
      ) : null;

      return {
        ...person,
        firstName,
        lastName,
        displayName: preferredName?.trim() || `${firstName} ${lastName}`,
        workEmail,
      };
    }),
  };
}
