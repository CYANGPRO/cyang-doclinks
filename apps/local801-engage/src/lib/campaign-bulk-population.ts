import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { can } from "./access.ts";
import { writeAuditEvent } from "./audit.ts";
import { CampaignMutationError } from "./campaign-management.ts";
import { queryLocal801, withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import {
  createPiiBlindIndex,
  getPiiKeyConfiguration,
  normalizePiiEmail,
  normalizePiiNameForSearch,
  PiiProtectionError,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/;
const MAX_FILTER_LENGTH = 80;
const MAX_SEARCH_LENGTH = 100;
const MAX_EXCEPTIONS = 50;
const CONFIRMATION_SECONDS = 10 * 60;
const MEMBERSHIP_STATUSES = new Set(["member", "nonmember", "unknown"]);

type SearchToken = { key_version: string; hash: string };
export type CampaignPopulationSearchMaterial = { protectedMode: boolean; tokens: SearchToken[]; email: SearchToken | null };

export type CampaignPopulationOperation = "add" | "remove";

export type CampaignPopulationCriteria = {
  membershipStatus: "member" | "nonmember" | "unknown" | null;
  department: string;
  classification: string;
  workLocation: string;
  search: string;
  includeHandles: string[];
  excludeHandles: string[];
};

export type CampaignPopulationPreview = {
  operation: CampaignPopulationOperation;
  matched: number;
  alreadyPresent: number;
  wouldChange: number;
  excluded: number;
  unavailable: number;
  protectedActivity: number;
  confirmationToken: string;
  expiresAt: string;
};

type PreviewRow = {
  campaign_id: string;
  revision: string;
  matched_count: number | string;
  present_count: number | string;
  change_count: number | string;
  excluded_count: number | string;
  unavailable_count: number | string;
  protected_count: number | string;
};

type Confirmation = {
  version: 1;
  organizationId: string;
  actorId: string;
  campaignHandle: string;
  operation: CampaignPopulationOperation;
  criteriaHash: string;
  revision: string;
  wouldChange: number;
  expiresAt: number;
};

type TransactionRunner = <T>(callback: (query: DatabaseQuery) => Promise<T>) => Promise<T>;

export type CampaignBulkPopulationDependencies = {
  query?: DatabaseQuery;
  transaction?: TransactionRunner;
  audit?: typeof writeAuditEvent;
  tokenSecret?: string;
  now?: () => number;
  searchMaterial?: (criteria: CampaignPopulationCriteria, organizationId: string, query: DatabaseQuery) => Promise<CampaignPopulationSearchMaterial>;
};

function fail(code: string, message: string, status = 400): never {
  throw new CampaignMutationError(code, message, status);
}

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCampaigns")) fail("FORBIDDEN", "Campaign population management is not authorized.", 403);
}

function handle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) fail("INVALID_HANDLE", `${label} is not available.`);
  return value;
}

function scalar(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function handles(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EXCEPTIONS) {
    fail("INVALID_EXCEPTIONS", `Explicit exceptions are limited to ${MAX_EXCEPTIONS} people.`);
  }
  const result = [...new Set(value.map((item) => handle(item, "Employee")))].sort();
  if (result.length > MAX_EXCEPTIONS) fail("INVALID_EXCEPTIONS", "Too many explicit exceptions were supplied.");
  return result;
}

export function normalizeCampaignPopulationCriteria(value: unknown): CampaignPopulationCriteria {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CRITERIA", "Population criteria are required.");
  const input = value as Record<string, unknown>;
  const membership = scalar(input.membershipStatus, 20);
  if (membership && !MEMBERSHIP_STATUSES.has(membership)) fail("INVALID_CRITERIA", "Membership status is invalid.");
  const includeHandles = handles(input.includeHandles);
  const excluded = new Set(handles(input.excludeHandles));
  const criteria = {
    membershipStatus: membership ? membership as CampaignPopulationCriteria["membershipStatus"] : null,
    department: scalar(input.department, MAX_FILTER_LENGTH),
    classification: scalar(input.classification, MAX_FILTER_LENGTH),
    workLocation: scalar(input.workLocation, MAX_FILTER_LENGTH),
    search: scalar(input.search, MAX_SEARCH_LENGTH),
    includeHandles: includeHandles.filter((item) => !excluded.has(item)),
    excludeHandles: [...excluded].sort(),
  };
  if (!criteria.membershipStatus && !criteria.department && !criteria.classification && !criteria.workLocation
    && !criteria.search && criteria.includeHandles.length === 0) {
    fail("EMPTY_CRITERIA", "Choose at least one population criterion or explicit inclusion.");
  }
  return criteria;
}

function operation(value: unknown): CampaignPopulationOperation {
  if (value !== "add" && value !== "remove") fail("INVALID_OPERATION", "Population operation is invalid.");
  return value;
}

function escapeLike(value: string) {
  return value ? `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : null;
}

function count(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function canonicalHash(criteria: CampaignPopulationCriteria) {
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

function confirmationSecret(dependencies: CampaignBulkPopulationDependencies) {
  const secret = dependencies.tokenSecret ?? process.env.NEXTAUTH_SECRET ?? "";
  if (secret.length < 32) fail("CONFIRMATION_UNAVAILABLE", "Population confirmation is unavailable.", 503);
  return secret;
}

function signConfirmation(payload: Confirmation, secret: string) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readConfirmation(value: unknown, secret: string): Confirmation {
  if (typeof value !== "string" || value.length > 2_000) fail("INVALID_CONFIRMATION", "Population confirmation is invalid.", 409);
  const [encoded, supplied, extra] = value.split(".");
  if (!encoded || !supplied || extra) fail("INVALID_CONFIRMATION", "Population confirmation is invalid.", 409);
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual: Buffer;
  try { actual = Buffer.from(supplied, "base64url"); } catch { fail("INVALID_CONFIRMATION", "Population confirmation is invalid.", 409); }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    fail("INVALID_CONFIRMATION", "Population confirmation is invalid.", 409);
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Confirmation;
    if (parsed.version !== 1 || !HANDLE_RE.test(parsed.campaignHandle) || !HANDLE_RE.test(parsed.criteriaHash)
      || !HANDLE_RE.test(parsed.revision) || !Number.isSafeInteger(parsed.wouldChange)
      || !Number.isSafeInteger(parsed.expiresAt)) throw new Error("invalid");
    return parsed;
  } catch {
    fail("INVALID_CONFIRMATION", "Population confirmation is invalid.", 409);
  }
}

export async function prepareCampaignPopulationSearchTerm(
  searchTerm: string,
  organizationId: string,
  query: DatabaseQuery,
): Promise<CampaignPopulationSearchMaterial> {
  const mode = getPiiProtectedReadMode();
  if (mode === "legacy" || !searchTerm) return { protectedMode: mode !== "legacy", tokens: [], email: null };
  await assertPiiProtectedReadState(organizationId, query, mode);
  const config = getPiiKeyConfiguration();
  const normalizedName = normalizePiiNameForSearch(searchTerm);
  const words = normalizedName.split(" ").filter((word) => Array.from(word).length >= 3);
  const tokens = words.map((word) => {
    const prefix = Array.from(word).slice(0, 20).join("");
    const index = createPiiBlindIndex(prefix, { organizationId, domain: "search:combined-name:prefix" }, config);
    return { key_version: index.blindIndexKeyVersion, hash: index.blindIndex };
  });
  let email: SearchToken | null = null;
  try {
    const normalizedEmail = normalizePiiEmail(searchTerm);
    const index = createPiiBlindIndex(normalizedEmail, { organizationId, domain: "contact:work-email" }, config);
    email = { key_version: index.blindIndexKeyVersion, hash: index.blindIndex };
  } catch (error) {
    if (!(error instanceof PiiProtectionError) || error.code !== "NORMALIZATION_FAILED") throw error;
  }
  return { protectedMode: true, tokens, email };
}

async function defaultSearchMaterial(
  criteria: CampaignPopulationCriteria,
  organizationId: string,
  query: DatabaseQuery,
): Promise<CampaignPopulationSearchMaterial> {
  return prepareCampaignPopulationSearchTerm(criteria.search, organizationId, query);
}

function selectionCtes() {
  return `
    actor_context AS (
      SELECT $8::text AS operation, $9::uuid AS actor_id
    ), selected_campaign AS (
      SELECT campaign.id
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status = 'draft'
        AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    ), include_handles AS (
      SELECT value.handle FROM jsonb_to_recordset($10::text::jsonb) AS value(handle text)
    ), exclude_handles AS (
      SELECT value.handle FROM jsonb_to_recordset($11::text::jsonb) AS value(handle text)
    ), search_tokens AS (
      SELECT value.key_version, value.hash
      FROM jsonb_to_recordset($13::text::jsonb) AS value(key_version text, hash text)
    ), eligible AS (
      SELECT person.id AS person_id,
        encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') AS person_handle
      FROM local801.people person
      WHERE person.organization_id = $1::uuid
        AND person.archived_at IS NULL
        AND person.local_number = '0801'
        AND (
          EXISTS (SELECT 1 FROM include_handles included
            WHERE included.handle = encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex'))
          OR (
            ($3::text IS NULL OR person.membership_status = $3::text)
            AND ($4::text IS NULL OR person.department ILIKE $4::text ESCAPE '\\')
            AND ($5::text IS NULL OR lower(btrim(person.classification)) = lower(btrim($5::text)))
            AND ($6::text IS NULL OR COALESCE(NULLIF(btrim(person.section), ''), person.work_location) ILIKE $6::text ESCAPE '\\')
            AND ($7::text IS NULL
              OR person.department ILIKE $7::text ESCAPE '\\'
              OR person.classification ILIKE $7::text ESCAPE '\\'
              OR person.section ILIKE $7::text ESCAPE '\\'
              OR person.work_location ILIKE $7::text ESCAPE '\\'
              OR (NOT $12::boolean AND (
                person.first_name ILIKE $7::text ESCAPE '\\'
                OR person.last_name ILIKE $7::text ESCAPE '\\'
                OR person.preferred_name ILIKE $7::text ESCAPE '\\'))
              OR ($12::boolean AND jsonb_array_length($13::text::jsonb) > 0 AND NOT EXISTS (
                SELECT 1 FROM search_tokens wanted
                WHERE NOT EXISTS (
                  SELECT 1 FROM local801.person_search_tokens stored
                  WHERE stored.organization_id = $1::uuid AND stored.person_id = person.id
                    AND stored.token_domain = 'combined_name' AND stored.token_kind = 'prefix'
                    AND stored.token_key_version = wanted.key_version AND stored.token_hash = wanted.hash
                )
              ))
              OR ($12::boolean AND $14::text IS NOT NULL AND EXISTS (
                SELECT 1
                FROM local801.person_contact_methods contact
                JOIN local801.pii_exact_indexes email_index
                  ON email_index.organization_id = contact.organization_id
                 AND email_index.entity_type = 'person_contact_method'
                 AND email_index.entity_id = contact.id
                 AND email_index.index_domain = 'contact:work-email'
                 AND email_index.index_key_version = $14::text
                 AND email_index.index_hash = $15::text
                WHERE contact.organization_id = $1::uuid AND contact.person_id = person.id
                  AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
              )))
          )
        )
    ), selected AS (
      SELECT eligible.person_id, eligible.person_handle
      FROM eligible
      WHERE NOT EXISTS (SELECT 1 FROM exclude_handles excluded WHERE excluded.handle = eligible.person_handle)
    ), selected_state AS (
      SELECT selected.person_id, selected.person_handle,
        population.id AS population_id,
        EXISTS (
          SELECT 1 FROM local801.engagement_events event, selected_campaign campaign
          WHERE event.organization_id = $1::uuid AND event.campaign_id = campaign.id
            AND event.person_id = selected.person_id AND event.voided_at IS NULL
        ) OR EXISTS (
          SELECT 1 FROM local801.engagement_assignments assignment, selected_campaign campaign
          WHERE assignment.organization_id = $1::uuid AND assignment.campaign_id = campaign.id
            AND assignment.person_id = selected.person_id AND assignment.archived_at IS NULL
            AND assignment.status = 'completed'
        ) AS protected_activity
      FROM selected
      CROSS JOIN selected_campaign campaign
      LEFT JOIN local801.outreach_campaign_population population
        ON population.organization_id = $1::uuid AND population.campaign_id = campaign.id
       AND population.person_id = selected.person_id
    )
  `;
}

function selectionParameters(
  context: WorkspaceContext,
  campaignHandle: string,
  criteria: CampaignPopulationCriteria,
  operationValue: CampaignPopulationOperation,
  search: CampaignPopulationSearchMaterial,
) {
  return [
    context.organizationId,
    campaignHandle,
    criteria.membershipStatus,
    escapeLike(criteria.department),
    criteria.classification || null,
    escapeLike(criteria.workLocation),
    escapeLike(criteria.search),
    operationValue,
    context.userId,
    JSON.stringify(criteria.includeHandles.map((item) => ({ handle: item }))),
    JSON.stringify(criteria.excludeHandles.map((item) => ({ handle: item }))),
    search.protectedMode,
    JSON.stringify(search.tokens),
    search.email?.key_version ?? null,
    search.email?.hash ?? null,
  ];
}

async function livePreview(
  context: WorkspaceContext,
  campaignHandle: string,
  criteria: CampaignPopulationCriteria,
  operationValue: CampaignPopulationOperation,
  search: CampaignPopulationSearchMaterial,
  query: DatabaseQuery,
) {
  const [row] = await query<PreviewRow>(`
    /* campaign-bulk-population:preview */
    WITH ${selectionCtes()}
    SELECT campaign.id::text AS campaign_id,
      encode(public.digest(
        COALESCE(string_agg(state.person_id::text || ':' || COALESCE(state.population_id::text, '-') || ':' || state.protected_activity::text,
          ',' ORDER BY state.person_id), '') || ':' || $8::text,
        'sha256'), 'hex') AS revision,
      count(state.person_id)::int AS matched_count,
      count(state.population_id)::int AS present_count,
      count(*) FILTER (WHERE state.person_id IS NOT NULL AND (($8::text = 'add' AND state.population_id IS NULL)
        OR ($8::text = 'remove' AND state.population_id IS NOT NULL AND NOT state.protected_activity)))::int AS change_count,
      (SELECT count(*)::int FROM exclude_handles)::int AS excluded_count,
      (SELECT count(*)::int FROM include_handles included WHERE NOT EXISTS (
        SELECT 1 FROM local801.people person
        WHERE person.organization_id = $1::uuid AND person.archived_at IS NULL AND person.local_number = '0801'
          AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = included.handle
      ))::int AS unavailable_count,
      count(*) FILTER (WHERE state.population_id IS NOT NULL AND state.protected_activity)::int AS protected_count
    FROM selected_campaign campaign
    LEFT JOIN selected_state state ON true
    GROUP BY campaign.id
  `, selectionParameters(context, campaignHandle, criteria, operationValue, search));
  if (!row?.campaign_id || !HANDLE_RE.test(row.revision)) {
    fail("CAMPAIGN_NOT_AVAILABLE", "The draft campaign is no longer available.", 409);
  }
  return {
    campaignId: row.campaign_id,
    revision: row.revision,
    matched: count(row.matched_count),
    alreadyPresent: count(row.present_count),
    wouldChange: count(row.change_count),
    excluded: count(row.excluded_count),
    unavailable: count(row.unavailable_count),
    protectedActivity: count(row.protected_count),
  };
}

export async function previewCampaignPopulationChange(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  input: { operation?: unknown; criteria?: unknown },
  dependencies: CampaignBulkPopulationDependencies = {},
): Promise<CampaignPopulationPreview> {
  requireAccess(context);
  const campaignHandle = handle(campaignHandleInput, "Campaign");
  const operationValue = operation(input.operation);
  const criteria = normalizeCampaignPopulationCriteria(input.criteria);
  const query = dependencies.query ?? queryLocal801;
  const search = await (dependencies.searchMaterial ?? defaultSearchMaterial)(criteria, context.organizationId, query);
  const live = await livePreview(context, campaignHandle, criteria, operationValue, search, query);
  const now = (dependencies.now ?? Date.now)();
  const expiresAt = now + CONFIRMATION_SECONDS * 1_000;
  const confirmationToken = signConfirmation({
    version: 1,
    organizationId: context.organizationId,
    actorId: context.userId,
    campaignHandle,
    operation: operationValue,
    criteriaHash: canonicalHash(criteria),
    revision: live.revision,
    wouldChange: live.wouldChange,
    expiresAt,
  }, confirmationSecret(dependencies));
  return {
    operation: operationValue,
    matched: live.matched,
    alreadyPresent: live.alreadyPresent,
    wouldChange: live.wouldChange,
    excluded: live.excluded,
    unavailable: live.unavailable,
    protectedActivity: live.protectedActivity,
    confirmationToken,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function applyCampaignPopulationChange(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  input: { operation?: unknown; criteria?: unknown; confirmationToken?: unknown },
  dependencies: CampaignBulkPopulationDependencies = {},
) {
  requireAccess(context);
  const campaignHandle = handle(campaignHandleInput, "Campaign");
  const operationValue = operation(input.operation);
  const criteria = normalizeCampaignPopulationCriteria(input.criteria);
  const secret = confirmationSecret(dependencies);
  const confirmation = readConfirmation(input.confirmationToken, secret);
  const now = (dependencies.now ?? Date.now)();
  if (confirmation.expiresAt < now) fail("CONFIRMATION_EXPIRED", "The population preview expired. Preview it again.", 409);
  if (confirmation.organizationId !== context.organizationId || confirmation.actorId !== context.userId
    || confirmation.campaignHandle !== campaignHandle || confirmation.operation !== operationValue
    || confirmation.criteriaHash !== canonicalHash(criteria)) {
    fail("CONFIRMATION_MISMATCH", "The population criteria changed. Preview them again.", 409);
  }

  const baseQuery = dependencies.query ?? queryLocal801;
  const search = await (dependencies.searchMaterial ?? defaultSearchMaterial)(criteria, context.organizationId, baseQuery);
  const transaction = dependencies.transaction ?? withLocal801Transaction;
  const audit = dependencies.audit ?? writeAuditEvent;
  return transaction(async (query) => {
    const [locked] = await query<{ campaign_id: string }>(`
      /* campaign-bulk-population:lock-campaign */
      SELECT campaign.id::text AS campaign_id
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status = 'draft'
        AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
        AND EXISTS (
          SELECT 1 FROM local801.users actor
          JOIN local801.workspace_user_roles user_role ON user_role.user_id = actor.id
          JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid
          WHERE actor.id = $3::uuid AND actor.organization_id = $1::uuid AND actor.deactivated_at IS NULL
            AND role.code = $4::text AND role.code IN ('system_owner','local_admin','cat_admin')
        )
      FOR UPDATE OF campaign
    `, [context.organizationId, campaignHandle, context.userId, context.role]);
    if (!locked?.campaign_id) fail("CAMPAIGN_NOT_AVAILABLE", "The draft campaign is no longer available.", 409);
    const live = await livePreview(context, campaignHandle, criteria, operationValue, search, query);
    if (live.revision !== confirmation.revision || live.wouldChange !== confirmation.wouldChange) {
      fail("STALE_CONFIRMATION", "The campaign population changed. Preview it again.", 409);
    }

    const [changed] = await query<{ changed_count: number | string }>(`
      /* campaign-bulk-population:apply */
      WITH ${selectionCtes()}, ${operationValue === "remove" ? `
        archived_assignments AS (
          UPDATE local801.engagement_assignments assignment
          SET archived_at = now()
          FROM selected_state state, selected_campaign campaign
          WHERE assignment.organization_id = $1::uuid AND assignment.campaign_id = campaign.id
            AND assignment.person_id = state.person_id AND assignment.archived_at IS NULL
            AND assignment.status <> 'completed' AND state.population_id IS NOT NULL
            AND NOT state.protected_activity
          RETURNING assignment.id
        ),
      ` : ""} changed AS (
        ${operationValue === "add" ? `
          INSERT INTO local801.outreach_campaign_population (organization_id, campaign_id, person_id, frozen_at)
          SELECT $1::uuid, campaign.id, state.person_id, now()
          FROM selected_state state CROSS JOIN selected_campaign campaign
          WHERE state.population_id IS NULL
          ON CONFLICT (campaign_id, person_id) DO NOTHING
          RETURNING id
        ` : `
          DELETE FROM local801.outreach_campaign_population population
          USING selected_state state, selected_campaign campaign
          WHERE population.organization_id = $1::uuid AND population.campaign_id = campaign.id
            AND population.person_id = state.person_id AND state.population_id IS NOT NULL
            AND NOT state.protected_activity
          RETURNING population.id
        `}
      )
      SELECT count(*)::int AS changed_count FROM changed
    `, selectionParameters(context, campaignHandle, criteria, operationValue, search));
    const changedCount = count(changed?.changed_count);
    if (changedCount !== live.wouldChange) {
      fail("CONCURRENT_CAMPAIGN_CHANGE", "The campaign changed while the population was being updated.", 409);
    }
    await audit({
      eventType: "record.update",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "outreach_campaign",
      subjectId: live.campaignId,
      payload: {
        bulkPopulation: true,
        operation: operationValue,
        changedCount,
        matchedCount: live.matched,
        protectedCount: live.protectedActivity,
        openAssignmentsArchived: operationValue === "remove",
        membershipCriterion: Boolean(criteria.membershipStatus),
        departmentCriterion: Boolean(criteria.department),
        classificationCriterion: Boolean(criteria.classification),
        locationCriterion: Boolean(criteria.workLocation),
        searchCriterion: Boolean(criteria.search),
        explicitIncludeCount: criteria.includeHandles.length,
        explicitExcludeCount: criteria.excludeHandles.length,
      },
    }, query);
    return { changed: changedCount, operation: operationValue };
  });
}

export const __testing = {
  CONFIRMATION_SECONDS,
  MAX_EXCEPTIONS,
  MAX_FILTER_LENGTH,
  MAX_SEARCH_LENGTH,
  canonicalHash,
  readConfirmation,
  signConfirmation,
};
