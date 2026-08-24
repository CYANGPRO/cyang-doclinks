import "server-only";

import { createHash } from "node:crypto";
import type { CampaignManagementOptions } from "./campaign-management.ts";
import type { CampaignPopulationCandidate } from "./campaign-population-management.ts";
import type { CampaignPopulationPerson } from "./campaigns.ts";
import type { CampaignPopulationFilters } from "./campaigns.ts";
import type { CampaignOrganizerProgress } from "./campaigns.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
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
const HANDLE_RE = /^[0-9a-f]{64}$/i;

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

type CampaignAssignmentRow = {
  person_id: string;
  user_id: string | null;
};

export type CampaignPopulationPageForProtectedRead = {
  people: CampaignPopulationPerson[];
  total: number;
  hasNext: boolean;
  nextCursor: string | null;
  pageSize: number;
  filters: CampaignPopulationFilters;
};

export type CampaignCandidatesForProtectedRead = {
  term: string;
  candidates: CampaignPopulationCandidate[];
};

export type ProtectedCampaignDetailBundle = {
  population: CampaignPopulationPageForProtectedRead;
  options: CampaignManagementOptions;
  candidates: CampaignCandidatesForProtectedRead | null;
  organizerProgress: CampaignOrganizerProgress[];
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

function decryptPersonNames(row: ProtectedPersonRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
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

function decryptUserDisplayName(row: ProtectedUserRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"),
    { organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
    keyConfig,
  );
}

export async function hydrateCampaignDetailFromProtectedPii(
  organizationId: string,
  campaignHandle: string,
  bundle: ProtectedCampaignDetailBundle,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<ProtectedCampaignDetailBundle> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return bundle;
  if (!HANDLE_RE.test(campaignHandle)) blocked("CAMPAIGN_HANDLE_INVALID", "Campaign protected-read context is invalid.");
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const requestedPersonHandles = [...new Set([
    ...bundle.population.people.map((person) => person.personHandle),
    ...(bundle.candidates?.candidates.map((candidate) => candidate.personHandle) ?? []),
  ])];
  const requestedPopulationHandles = [...new Set(bundle.population.people.map((person) => person.personHandle))];
  const [people, assignments] = await Promise.all([
    query<ProtectedPersonRow>(`
      /* pii-protected-campaign-read:people */
      WITH requested AS (
        SELECT value.handle FROM jsonb_to_recordset($2::text::jsonb) AS value(handle text)
      )
      SELECT person_id::text,
        first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
        last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
        preferred_name_encrypted_payload, preferred_name_encryption_key_version, preferred_name_encryption_format_version
      FROM local801.person_pii protected
      JOIN requested ON requested.handle = encode(public.digest($1::text || ':' || protected.person_id::text, 'sha256'), 'hex')
      WHERE protected.organization_id = $1::uuid
      ORDER BY person_id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId, JSON.stringify(requestedPersonHandles.map((handle) => ({ handle })))]),
    query<CampaignAssignmentRow>(`
      /* pii-protected-campaign-read:latest-assignees */
      WITH requested AS (
        SELECT value.handle FROM jsonb_to_recordset($3::text::jsonb) AS value(handle text)
      ), selected_campaign AS (
        SELECT campaign.id
        FROM local801.outreach_campaigns campaign
        WHERE campaign.organization_id = $1::uuid
          AND campaign.archived_at IS NULL
          AND campaign.status <> 'archived'
          AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
        LIMIT 1
      ), latest AS (
        SELECT DISTINCT ON (assignment.person_id)
          assignment.person_id,
          assignment.primary_user_id
        FROM local801.engagement_assignments assignment
        JOIN selected_campaign campaign ON campaign.id = assignment.campaign_id
        JOIN local801.people person
          ON person.organization_id = $1::uuid AND person.id = assignment.person_id
        JOIN requested
          ON requested.handle = encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex')
        WHERE assignment.organization_id = $1::uuid
          AND assignment.archived_at IS NULL
        ORDER BY assignment.person_id, assignment.created_at DESC, assignment.id DESC
      )
      SELECT latest.person_id::text,
        active_user.id::text AS user_id
      FROM latest
      LEFT JOIN local801.users active_user
        ON active_user.organization_id = $1::uuid
       AND active_user.id = latest.primary_user_id
       AND active_user.deactivated_at IS NULL
      ORDER BY latest.person_id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId, campaignHandle, JSON.stringify(requestedPopulationHandles.map((handle) => ({ handle })))]),
  ]);

  const requestedUserHandles = [...new Set([
    ...bundle.options.assignees.map((option) => option.handle),
    ...bundle.organizerProgress.map((item) => item.assigneeHandle),
    ...assignments.filter((assignment) => assignment.user_id).map((assignment) => userHandle(organizationId, assignment.user_id!)),
  ])];
  const users = await query<ProtectedUserRow>(`
    /* pii-protected-campaign-read:users */
    WITH requested AS (
      SELECT value.handle FROM jsonb_to_recordset($2::text::jsonb) AS value(handle text)
    )
    SELECT protected.user_id::text,
      protected.display_name_encrypted_payload, protected.display_name_encryption_key_version, protected.display_name_encryption_format_version
    FROM local801.user_pii protected
    JOIN requested
      ON requested.handle = encode(public.digest('user:' || $1::text || ':' || protected.user_id::text, 'sha256'), 'hex')
    WHERE protected.organization_id = $1::uuid
    ORDER BY protected.user_id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId, JSON.stringify(requestedUserHandles.map((handle) => ({ handle })))]);

  if (people.length > PREVIEW_ROW_LIMIT || users.length > PREVIEW_ROW_LIMIT || assignments.length > PREVIEW_ROW_LIMIT) {
    blocked("PREVIEW_BOUND_EXCEEDED", "Protected Campaign read exceeded its bounded row limit.");
  }

  const peopleByHandle = uniqueMap(people, (row) => personHandle(organizationId, row.person_id), "person");
  const usersByHandle = uniqueMap(users, (row) => userHandle(organizationId, row.user_id), "user");
  const assignmentsByPersonId = uniqueMap(assignments, (row) => row.person_id, "campaign assignment");

  const population = {
    ...bundle.population,
    people: bundle.population.people.map((person) => {
      const protectedPerson = peopleByHandle.get(person.personHandle);
      if (!protectedPerson) blocked("COMPANION_MISSING", "A campaign participant is missing its protected PII companion.");
      const names = decryptPersonNames(protectedPerson, organizationId, keyConfig);
      const assignment = assignmentsByPersonId.get(protectedPerson.person_id);
      let assigneeName: string | null = null;
      if (person.assignee_name) {
        if (!assignment?.user_id) blocked("COMPANION_MISSING", "A campaign assignee is missing its protected user reference.");
        const protectedUser = usersByHandle.get(userHandle(organizationId, assignment.user_id));
        if (!protectedUser) blocked("COMPANION_MISSING", "A campaign assignee is missing its protected PII companion.");
        assigneeName = decryptUserDisplayName(protectedUser, organizationId, keyConfig);
      }
      return {
        ...person,
        first_name: names.firstName,
        last_name: names.lastName,
        assignee_name: assigneeName,
      };
    }),
  };

  const options: CampaignManagementOptions = {
    ...bundle.options,
    assignees: bundle.options.assignees.map((option) => {
      const protectedUser = usersByHandle.get(option.handle);
      if (!protectedUser) blocked("COMPANION_MISSING", "A campaign assignment option is missing its protected PII companion.");
      return { ...option, label: decryptUserDisplayName(protectedUser, organizationId, keyConfig) };
    }),
  };

  const candidates = bundle.candidates ? {
    ...bundle.candidates,
    candidates: bundle.candidates.candidates.map((candidate) => {
      const protectedPerson = peopleByHandle.get(candidate.personHandle);
      if (!protectedPerson) blocked("COMPANION_MISSING", "A campaign population candidate is missing its protected PII companion.");
      return {
        ...candidate,
        displayName: decryptPersonNames(protectedPerson, organizationId, keyConfig).displayName,
      };
    }),
  } : null;

  const organizerProgress = bundle.organizerProgress.map((item) => {
    const protectedUser = usersByHandle.get(item.assigneeHandle);
    if (!protectedUser) blocked("COMPANION_MISSING", "A campaign progress organizer is missing its protected PII companion.");
    return { ...item, assigneeName: decryptUserDisplayName(protectedUser, organizationId, keyConfig) };
  });

  return { population, options, candidates, organizerProgress };
}
