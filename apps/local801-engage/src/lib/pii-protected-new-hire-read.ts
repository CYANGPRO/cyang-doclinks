import "server-only";

import { createHash } from "node:crypto";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { NewHireQueuePage } from "./new-hires.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import {
  assertPiiProtectedReadState,
  getPiiProtectedReadMode,
  PiiProtectedReadError,
} from "./pii-protected-read.ts";

const PREVIEW_ROW_LIMIT = 500;

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
  contact_type: "work_email" | "personal_email" | "phone";
  contact_label: "work" | "cell" | "home" | null;
  contact_value_encrypted_payload: string;
  encryption_key_version: string;
  encryption_format_version: number;
};

type ProtectedAssignmentOrganizerRow = {
  person_id: string;
  assignment_role: "primary" | "backup";
  user_id: string;
  display_name_encrypted_payload: string | null;
  display_name_encryption_key_version: string | null;
  display_name_encryption_format_version: number | null;
};

function blocked(code: string, message: string): never {
  throw new PiiProtectedReadError(code, message);
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

function decryptPersonDisplayName(row: ProtectedPersonRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
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
  return preferredName?.trim() || `${firstName} ${lastName}`;
}

function decryptContact(row: ProtectedContactRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "contact_value_encrypted_payload", "encryption_key_version", "encryption_format_version"),
    { organizationId, entity: "person-contact", recordId: row.contact_method_id, field: "contact-value" },
    keyConfig,
  );
}

function decryptOrganizer(row: ProtectedAssignmentOrganizerRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  if (row.display_name_encrypted_payload === null) {
    blocked("COMPANION_MISSING", "A new-hire assignment organizer is missing its protected PII companion.");
  }
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"),
    { organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
    keyConfig,
  );
}

function organizerMap(
  rows: readonly ProtectedAssignmentOrganizerRow[],
  organizationId: string,
  keyConfig: PiiKeyConfiguration,
) {
  const byPerson = new Map<string, { primary: Map<string, string>; backup: Map<string, string> }>();
  for (const row of rows) {
    let entry = byPerson.get(row.person_id);
    if (!entry) {
      entry = { primary: new Map(), backup: new Map() };
      byPerson.set(row.person_id, entry);
    }
    entry[row.assignment_role].set(row.user_id, decryptOrganizer(row, organizationId, keyConfig));
  }
  return byPerson;
}

function joinedNames(values: Map<string, string> | undefined) {
  if (!values?.size) return null;
  return [...values.values()].sort((left, right) => left.localeCompare(right)).join(", ");
}

export async function hydrateNewHireQueueFromProtectedPii(
  organizationId: string,
  page: NewHireQueuePage,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<NewHireQueuePage> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return page;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);
  const requestedHandles = JSON.stringify(page.people.map((person) => ({ handle: person.handle })));

  const [people, contacts, organizers] = await Promise.all([
    query<ProtectedPersonRow>(`
      /* pii-protected-new-hire-read:people */
      WITH requested AS (
        SELECT value.handle FROM jsonb_to_recordset($2::text::jsonb) AS value(handle text)
      )
      SELECT protected.person_id::text,
        first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
        last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
        preferred_name_encrypted_payload, preferred_name_encryption_key_version, preferred_name_encryption_format_version
      FROM local801.person_pii protected
      JOIN requested ON requested.handle = encode(public.digest($1::text || ':' || protected.person_id::text, 'sha256'), 'hex')
      WHERE protected.organization_id = $1::uuid
      ORDER BY protected.person_id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId, requestedHandles]),
    query<ProtectedContactRow>(`
      /* pii-protected-new-hire-read:contact-details */
      WITH requested AS (
        SELECT value.handle FROM jsonb_to_recordset($2::text::jsonb) AS value(handle text)
      )
      SELECT DISTINCT ON (contact.person_id, contact.contact_type, contact.contact_label)
        contact.person_id::text, contact.id::text AS contact_method_id, contact.contact_type, contact.contact_label,
        protected.contact_value_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version
      FROM local801.person_contact_methods contact
      JOIN requested ON requested.handle = encode(public.digest($1::text || ':' || contact.person_id::text, 'sha256'), 'hex')
      JOIN local801.person_contact_method_pii protected
        ON protected.organization_id = contact.organization_id
       AND protected.contact_method_id = contact.id
      WHERE contact.organization_id = $1::uuid
        AND contact.contact_type IN ('work_email','personal_email','phone')
        AND contact.is_primary = true
        AND contact.archived_at IS NULL
        AND contact.visibility = 'authorized_directory'
      ORDER BY contact.person_id, contact.contact_type, contact.contact_label, contact.created_at DESC, contact.id DESC
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId, requestedHandles]),
    query<ProtectedAssignmentOrganizerRow>(`
      /* pii-protected-new-hire-read:organizers */
      WITH requested AS (
        SELECT value.handle FROM jsonb_to_recordset($2::text::jsonb) AS value(handle text)
      )
      SELECT assignment.person_id::text,
        'primary'::text AS assignment_role,
        app_user.id::text AS user_id,
        protected.display_name_encrypted_payload,
        protected.display_name_encryption_key_version,
        protected.display_name_encryption_format_version
      FROM local801.engagement_assignments assignment
      JOIN requested ON requested.handle = encode(public.digest($1::text || ':' || assignment.person_id::text, 'sha256'), 'hex')
      JOIN local801.users app_user
        ON app_user.organization_id = $1::uuid
       AND app_user.id = assignment.primary_user_id
       AND app_user.deactivated_at IS NULL
      LEFT JOIN local801.user_pii protected
        ON protected.organization_id = app_user.organization_id
       AND protected.user_id = app_user.id
      WHERE assignment.organization_id = $1::uuid
        AND assignment.archived_at IS NULL
        AND assignment.status = 'open'
      UNION ALL
      SELECT assignment.person_id::text,
        'backup'::text AS assignment_role,
        app_user.id::text AS user_id,
        protected.display_name_encrypted_payload,
        protected.display_name_encryption_key_version,
        protected.display_name_encryption_format_version
      FROM local801.engagement_assignments assignment
      JOIN requested ON requested.handle = encode(public.digest($1::text || ':' || assignment.person_id::text, 'sha256'), 'hex')
      JOIN local801.users app_user
        ON app_user.organization_id = $1::uuid
       AND app_user.id = assignment.backup_user_id
       AND app_user.deactivated_at IS NULL
      LEFT JOIN local801.user_pii protected
        ON protected.organization_id = app_user.organization_id
       AND protected.user_id = app_user.id
      WHERE assignment.organization_id = $1::uuid
        AND assignment.archived_at IS NULL
        AND assignment.status = 'open'
      ORDER BY person_id, assignment_role, user_id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId, requestedHandles]),
  ]);

  if (people.length > PREVIEW_ROW_LIMIT || contacts.length > PREVIEW_ROW_LIMIT || organizers.length > PREVIEW_ROW_LIMIT) {
    blocked("PREVIEW_BOUND_EXCEEDED", "Protected New Hires read exceeded its bounded row limit.");
  }

  const peopleByHandle = uniqueMap(people, (row) => personHandle(organizationId, row.person_id), "person");
  const contactByPersonId = new Map<string, Map<string, ProtectedContactRow>>();
  for (const row of contacts) {
    const bucket = contactByPersonId.get(row.person_id) ?? new Map<string, ProtectedContactRow>();
    const key = row.contact_type === "phone" ? `${row.contact_type}:${row.contact_label ?? ""}` : row.contact_type;
    if (bucket.has(key)) blocked("DUPLICATE_COMPANION", "Duplicate protected contact detail detected.");
    bucket.set(key, row);
    contactByPersonId.set(row.person_id, bucket);
  }
  const organizersByPersonId = organizerMap(organizers, organizationId, keyConfig);

  return {
    ...page,
    people: page.people.map((person) => {
      const protectedPerson = peopleByHandle.get(person.handle);
      if (!protectedPerson) blocked("COMPANION_MISSING", "A new-hire employee is missing its protected PII companion.");
      const protectedContacts = contactByPersonId.get(protectedPerson.person_id);
      const contact = (key: string) => {
        const row = protectedContacts?.get(key);
        return row ? decryptContact(row, organizationId, keyConfig) : null;
      };
      if (person.workEmail && !protectedContacts?.has("work_email")) blocked("COMPANION_MISSING", "A new-hire work email is missing its protected PII companion.");

      const assignmentOrganizers = organizersByPersonId.get(protectedPerson.person_id);
      const primaryOrganizers = joinedNames(assignmentOrganizers?.primary);
      const backupOrganizers = joinedNames(assignmentOrganizers?.backup);
      if (person.primaryOrganizers && !primaryOrganizers) blocked("COMPANION_MISSING", "A primary new-hire organizer is missing its protected PII companion.");
      if (person.backupOrganizers && !backupOrganizers) blocked("COMPANION_MISSING", "A backup new-hire organizer is missing its protected PII companion.");

      return {
        ...person,
        displayName: decryptPersonDisplayName(protectedPerson, organizationId, keyConfig),
        workEmail: contact("work_email"),
        homeEmail: contact("personal_email"),
        workPhone: contact("phone:work"),
        cellPhone: contact("phone:cell"),
        homePhone: contact("phone:home"),
        primaryOrganizers,
        backupOrganizers,
      };
    }),
  };
}
