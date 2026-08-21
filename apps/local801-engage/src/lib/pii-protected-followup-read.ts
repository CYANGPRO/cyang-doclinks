import "server-only";

import { createHash } from "node:crypto";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { FollowupQueuePage } from "./follow-ups.ts";
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

type ProtectedUserRow = {
  user_id: string;
  display_name_encrypted_payload: string;
  display_name_encryption_key_version: string;
  display_name_encryption_format_version: number;
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

function decryptUserDisplayName(row: ProtectedUserRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"),
    { organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
    keyConfig,
  );
}

export async function hydrateFollowupQueueFromProtectedPii(
  organizationId: string,
  page: FollowupQueuePage,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<FollowupQueuePage> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return page;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const [people, users] = await Promise.all([
    query<ProtectedPersonRow>(`
      /* pii-protected-followup-read:people */
      SELECT person_id::text,
        first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
        last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
        preferred_name_encrypted_payload, preferred_name_encryption_key_version, preferred_name_encryption_format_version
      FROM local801.person_pii
      WHERE organization_id = $1::uuid
      ORDER BY person_id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId]),
    query<ProtectedUserRow>(`
      /* pii-protected-followup-read:users */
      SELECT user_id::text,
        display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version
      FROM local801.user_pii
      WHERE organization_id = $1::uuid
      ORDER BY user_id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId]),
  ]);

  if (people.length > PREVIEW_ROW_LIMIT || users.length > PREVIEW_ROW_LIMIT) {
    blocked("PREVIEW_BOUND_EXCEEDED", "Protected Follow-ups read exceeded its bounded row limit.");
  }

  const peopleByHandle = uniqueMap(people, (row) => personHandle(organizationId, row.person_id), "person");
  const usersByHandle = uniqueMap(users, (row) => userHandle(organizationId, row.user_id), "user");

  return {
    ...page,
    items: page.items.map((item) => {
      const person = peopleByHandle.get(item.employeeHandle);
      if (!person) blocked("COMPANION_MISSING", "A follow-up employee is missing its protected PII companion.");

      let assignedTo: string | null = null;
      if (item.assignedToHandle) {
        const user = usersByHandle.get(item.assignedToHandle);
        if (!user) blocked("COMPANION_MISSING", "A follow-up assignee is missing its protected PII companion.");
        assignedTo = decryptUserDisplayName(user, organizationId, keyConfig);
      }

      const assigneeOptions = item.assigneeOptions.map((option) => {
        const user = usersByHandle.get(option.handle);
        if (!user) blocked("COMPANION_MISSING", "A follow-up reassignment option is missing its protected PII companion.");
        return { ...option, label: decryptUserDisplayName(user, organizationId, keyConfig) };
      });

      return {
        ...item,
        displayName: decryptPersonDisplayName(person, organizationId, keyConfig),
        assignedTo,
        assigneeOptions,
      };
    }),
  };
}
