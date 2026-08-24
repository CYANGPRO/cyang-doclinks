import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQuery } from "./db.ts";
import { queryLocal801 } from "./db.ts";
import type { EngagementFormOptions } from "./engagement-recording.ts";
import type { OutreachQueuePage, OutreachWorkspace } from "./outreach.ts";
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
  contact_value_encrypted_payload: string;
  encryption_key_version: string;
  encryption_format_version: number;
};

type ProtectedUserRow = {
  user_id: string;
  display_name_encrypted_payload: string;
  display_name_encryption_key_version: string;
  display_name_encryption_format_version: number;
};

type ProtectedFollowupAssigneeRow = {
  followup_id: string;
  user_id: string | null;
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

function userHandle(organizationId: string, userId: string) {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

function followupHandle(organizationId: string, followupId: string) {
  return createHash("sha256").update(`followup:${organizationId}:${followupId}`).digest("hex");
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

function decryptPerson(row: ProtectedPersonRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
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
  return { firstName, lastName, displayName: preferredName?.trim() || `${firstName} ${lastName}` };
}

function decryptContact(row: ProtectedContactRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "contact_value_encrypted_payload", "encryption_key_version", "encryption_format_version"),
    { organizationId, entity: "person-contact", recordId: row.contact_method_id, field: "contact-value" },
    keyConfig,
  );
}

function decryptUserDisplayName(row: ProtectedUserRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"),
    { organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
    keyConfig,
  );
}

async function loadProtectedPeople(organizationId: string, handles: readonly string[], query: DatabaseQuery) {
  if (handles.length === 0) return [];
  const rows = await query<ProtectedPersonRow>(`
    /* pii-protected-outreach-read:people */
    SELECT person_id::text,
      first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
      last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
      preferred_name_encrypted_payload, preferred_name_encryption_key_version, preferred_name_encryption_format_version
    FROM local801.person_pii
    WHERE organization_id = $1::uuid
      AND encode(public.digest($1::text || ':' || person_id::text, 'sha256'), 'hex') = ANY($2::text[])
    ORDER BY person_id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId, handles]);
  if (rows.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected person read exceeded its bounded row limit.");
  if (rows.length > handles.length) blocked("DUPLICATE_COMPANION", "Protected person lookup returned duplicate companions.");
  return rows;
}

async function loadProtectedWorkEmails(
  organizationId: string,
  userId: string,
  personIds: readonly string[],
  query: DatabaseQuery,
) {
  if (personIds.length === 0) return [];
  const rows = await query<ProtectedContactRow>(`
    /* pii-protected-outreach-read:work-email */
    SELECT DISTINCT ON (contact.person_id)
      contact.person_id::text, contact.id::text AS contact_method_id,
      protected.contact_value_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version
    FROM local801.person_contact_methods contact
    JOIN local801.person_contact_method_pii protected
      ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
    WHERE contact.organization_id = $1::uuid
      AND contact.person_id = ANY($3::uuid[])
      AND contact.contact_type = 'work_email'
      AND contact.is_primary = true
      AND contact.archived_at IS NULL
      AND (
        contact.visibility = 'authorized_directory'
        OR (
          contact.visibility = 'assigned_only'
          AND EXISTS (
            SELECT 1 FROM local801.engagement_assignments assignment
            WHERE assignment.organization_id = $1::uuid
              AND assignment.person_id = contact.person_id
              AND assignment.archived_at IS NULL
              AND assignment.status = 'open'
              AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
          )
        )
      )
    ORDER BY contact.person_id, contact.created_at, contact.id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId, userId, personIds]);
  if (rows.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected contact read exceeded its bounded row limit.");
  if (rows.length > personIds.length) blocked("DUPLICATE_COMPANION", "Protected contact lookup returned duplicate companions.");
  return rows;
}

export async function hydrateOutreachQueueFromProtectedPii(
  organizationId: string,
  userId: string,
  page: OutreachQueuePage,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<OutreachQueuePage> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return page;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const people = await loadProtectedPeople(organizationId, page.people.map((person) => person.handle), query);
  const contacts = await loadProtectedWorkEmails(organizationId, userId, people.map((person) => person.person_id), query);
  const peopleByHandle = uniqueMap(people, (row) => personHandle(organizationId, row.person_id), "person");
  const contactByPersonId = uniqueMap(contacts, (row) => row.person_id, "primary work-email");

  return {
    ...page,
    people: page.people.map((person) => {
      const protectedPerson = peopleByHandle.get(person.handle);
      if (!protectedPerson) blocked("COMPANION_MISSING", "An outreach person is missing its protected PII companion.");
      const names = decryptPerson(protectedPerson, organizationId, keyConfig);
      const protectedContact = contactByPersonId.get(protectedPerson.person_id);
      if (person.workEmail && !protectedContact) blocked("COMPANION_MISSING", "An outreach work email is missing its protected PII companion.");
      return {
        ...person,
        displayName: names.displayName,
        workEmail: protectedContact ? decryptContact(protectedContact, organizationId, keyConfig) : null,
      };
    }),
  };
}

export async function hydrateOutreachWorkspaceFromProtectedPii(
  organizationId: string,
  userId: string,
  workspace: OutreachWorkspace,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<OutreachWorkspace> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return workspace;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const people = await loadProtectedPeople(organizationId, [workspace.handle], query);
  const contacts = await loadProtectedWorkEmails(organizationId, userId, people.map((person) => person.person_id), query);
  const peopleByHandle = uniqueMap(people, (row) => personHandle(organizationId, row.person_id), "person");
  const protectedPerson = peopleByHandle.get(workspace.handle);
  if (!protectedPerson) blocked("COMPANION_MISSING", "The employee workspace is missing its protected PII companion.");
  const names = decryptPerson(protectedPerson, organizationId, keyConfig);
  const contactByPersonId = uniqueMap(contacts, (row) => row.person_id, "primary work-email");
  const protectedContact = contactByPersonId.get(protectedPerson.person_id);
  if (workspace.workEmail && !protectedContact) blocked("COMPANION_MISSING", "The employee work email is missing its protected PII companion.");

  const followupAssignees = await query<ProtectedFollowupAssigneeRow>(`
    /* pii-protected-outreach-read:followup-assignees */
    SELECT followup.id::text AS followup_id,
      assignee.id::text AS user_id,
      protected.display_name_encrypted_payload,
      protected.display_name_encryption_key_version,
      protected.display_name_encryption_format_version
    FROM local801.engagement_followups followup
    LEFT JOIN local801.users assignee
      ON assignee.id = followup.assigned_to
     AND assignee.organization_id = $1::uuid
     AND assignee.deactivated_at IS NULL
    LEFT JOIN local801.user_pii protected
      ON protected.organization_id = assignee.organization_id
     AND protected.user_id = assignee.id
    WHERE followup.organization_id = $1::uuid
      AND followup.person_id = $2::uuid
      AND followup.status = 'open'
      AND followup.completed_at IS NULL
    ORDER BY followup.due_at, followup.id
    LIMIT 26
  `, [organizationId, protectedPerson.person_id]);
  if (followupAssignees.length > 25) blocked("PREVIEW_BOUND_EXCEEDED", "Protected follow-up read exceeded its bounded row limit.");
  const followupByHandle = uniqueMap(followupAssignees, (row) => followupHandle(organizationId, row.followup_id), "follow-up");

  return {
    ...workspace,
    displayName: names.displayName,
    workEmail: protectedContact ? decryptContact(protectedContact, organizationId, keyConfig) : null,
    followups: workspace.followups.map((followup) => {
      const row = followupByHandle.get(followup.handle);
      if (!row) blocked("COMPANION_MISSING", "An open follow-up could not be reconciled during protected reads.");
      let assignee: string | null = null;
      if (row.user_id) {
        if (row.display_name_encrypted_payload === null) blocked("COMPANION_MISSING", "A follow-up assignee is missing its protected PII companion.");
        assignee = decryptUserDisplayName({
          user_id: row.user_id,
          display_name_encrypted_payload: row.display_name_encrypted_payload,
          display_name_encryption_key_version: row.display_name_encryption_key_version ?? "",
          display_name_encryption_format_version: Number(row.display_name_encryption_format_version),
        }, organizationId, keyConfig);
      }
      return { ...followup, assignee };
    }),
  };
}

export async function hydrateEngagementFormOptionsFromProtectedPii(
  organizationId: string,
  options: EngagementFormOptions,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<EngagementFormOptions> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return options;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const rows = await query<ProtectedUserRow>(`
    /* pii-protected-outreach-read:assignee-options */
    SELECT user_id::text,
      display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version
    FROM local801.user_pii
    WHERE organization_id = $1::uuid
    ORDER BY user_id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId]);
  if (rows.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected user read exceeded its bounded row limit.");
  const byHandle = uniqueMap(rows, (row) => userHandle(organizationId, row.user_id), "user");

  return {
    ...options,
    assignees: options.assignees.map((assignee) => {
      const row = byHandle.get(assignee.handle);
      if (!row) blocked("COMPANION_MISSING", "An engagement assignee is missing its protected PII companion.");
      return { ...assignee, label: decryptUserDisplayName(row, organizationId, keyConfig) };
    }),
  };
}

export async function hydrateOutreachAssigneeOptionsFromProtectedPii(
  organizationId: string,
  options: EngagementFormOptions["assignees"],
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
) {
  const hydrated = await hydrateEngagementFormOptionsFromProtectedPii(organizationId, {
    assignments: [],
    assignees: options,
    actionDefinitions: [],
  }, dependencies);
  return hydrated.assignees;
}
