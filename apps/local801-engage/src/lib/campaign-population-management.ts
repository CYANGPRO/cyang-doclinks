import "server-only";

import { randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { CampaignMutationError } from "./campaign-management.ts";
import {
  queryLocal801,
  runLocal801Transaction,
  type DatabaseQuery,
  type DatabaseStatement,
} from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const MAX_SEARCH_LENGTH = 100;
const MAX_CANDIDATES = 25;

export type CampaignPopulationDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
  uuid?: () => string;
};

export type CampaignPopulationCandidate = {
  personHandle: string;
  displayName: string;
  department: string | null;
  classification: string | null;
  workLocation: string | null;
};

type CandidateRow = {
  person_handle: string;
  preferred_name: string | null;
  first_name: string;
  last_name: string;
  department: string | null;
  classification: string | null;
  work_location: string | null;
};

type AddResolution = {
  campaign_id: string;
  person_id: string;
  already_in_population: boolean;
};

type RemoveResolution = {
  population_id: string;
  campaign_id: string;
  person_id: string;
  has_engagement: boolean;
  has_completed_assignment: boolean;
};

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCampaigns")) {
    throw new CampaignMutationError("FORBIDDEN", "Campaign population management is not authorized.", 403);
  }
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new CampaignMutationError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

function normalizeSearch(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_SEARCH_LENGTH);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function like(value: string) {
  return value ? `%${escapeLikePattern(value)}%` : null;
}

function actorCte() {
  return `
    actor AS (
      SELECT app_user.id
      FROM local801.users app_user
      WHERE app_user.id = $3::uuid
        AND app_user.organization_id = $1::uuid
        AND app_user.deactivated_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM local801.workspace_user_roles user_role
          JOIN local801.workspace_roles role
            ON role.id = user_role.role_id
           AND role.organization_id = $1::uuid
          WHERE user_role.user_id = app_user.id
            AND role.code = $4::text
            AND role.code IN ('system_owner','local_admin','cat_admin')
        )
    )
  `;
}

export async function getCampaignPopulationCandidates(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  searchInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<{ term: string; candidates: CampaignPopulationCandidate[] }> {
  requireAccess(context);
  const campaignHandle = requireHandle(campaignHandleInput, "Campaign");
  const term = normalizeSearch(searchInput);
  if (!term) return { term, candidates: [] };

  const rows = await query<CandidateRow>(`
    /* campaign-population:candidate-search */
    WITH selected_campaign AS (
      SELECT campaign.id
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status = 'draft'
        AND encode(digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    )
    SELECT
      encode(digest($1::text || ':' || person.id::text, 'sha256'), 'hex') AS person_handle,
      person.preferred_name,
      person.first_name,
      person.last_name,
      person.department,
      person.classification,
      person.work_location
    FROM local801.people person
    CROSS JOIN selected_campaign campaign
    WHERE person.organization_id = $1::uuid
      AND person.archived_at IS NULL
      AND person.local_number = '0801'
      AND NOT EXISTS (
        SELECT 1
        FROM local801.outreach_campaign_population population
        WHERE population.organization_id = $1::uuid
          AND population.campaign_id = campaign.id
          AND population.person_id = person.id
      )
      AND (
        person.first_name ILIKE $3 ESCAPE '\\'
        OR person.last_name ILIKE $3 ESCAPE '\\'
        OR person.preferred_name ILIKE $3 ESCAPE '\\'
        OR person.department ILIKE $3 ESCAPE '\\'
        OR person.classification ILIKE $3 ESCAPE '\\'
        OR person.work_location ILIKE $3 ESCAPE '\\'
      )
    ORDER BY person.last_name ASC, person.first_name ASC, person.id ASC
    LIMIT $4::integer
  `, [context.organizationId, campaignHandle, like(term), MAX_CANDIDATES]);

  return {
    term,
    candidates: rows.filter((row) => HANDLE_RE.test(row.person_handle)).map((row) => ({
      personHandle: row.person_handle,
      displayName: row.preferred_name?.trim() || `${row.first_name} ${row.last_name}`,
      department: row.department,
      classification: row.classification,
      workLocation: row.work_location,
    })),
  };
}

async function resolveAddTarget(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  personHandleInput: unknown,
  query: DatabaseQuery,
) {
  requireAccess(context);
  const campaignHandle = requireHandle(campaignHandleInput, "Campaign");
  const personHandle = requireHandle(personHandleInput, "Employee");
  const [row] = await query<AddResolution>(`
    /* campaign-population:resolve-add-target */
    SELECT campaign.id AS campaign_id, person.id AS person_id,
      EXISTS (
        SELECT 1
        FROM local801.outreach_campaign_population population
        WHERE population.organization_id = $1::uuid
          AND population.campaign_id = campaign.id
          AND population.person_id = person.id
      ) AS already_in_population
    FROM local801.outreach_campaigns campaign
    JOIN local801.people person
      ON person.organization_id = campaign.organization_id
     AND person.archived_at IS NULL
     AND person.local_number = '0801'
    WHERE campaign.organization_id = $1::uuid
      AND campaign.archived_at IS NULL
      AND campaign.status = 'draft'
      AND encode(digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      AND encode(digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, campaignHandle, personHandle]);
  if (!row) {
    throw new CampaignMutationError("POPULATION_TARGET_NOT_FOUND", "The draft campaign or employee is no longer available.", 409);
  }
  if (row.already_in_population) {
    throw new CampaignMutationError("ALREADY_IN_POPULATION", "This employee is already in the campaign population.", 409);
  }
  return row;
}

async function resolveRemoveTarget(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  personHandleInput: unknown,
  query: DatabaseQuery,
) {
  requireAccess(context);
  const campaignHandle = requireHandle(campaignHandleInput, "Campaign");
  const personHandle = requireHandle(personHandleInput, "Employee");
  const [row] = await query<RemoveResolution>(`
    /* campaign-population:resolve-remove-target */
    SELECT population.id AS population_id, campaign.id AS campaign_id, person.id AS person_id,
      EXISTS (
        SELECT 1
        FROM local801.engagement_events event
        WHERE event.organization_id = $1::uuid
          AND event.campaign_id = campaign.id
          AND event.person_id = person.id
          AND event.voided_at IS NULL
      ) AS has_engagement,
      EXISTS (
        SELECT 1
        FROM local801.engagement_assignments assignment
        WHERE assignment.organization_id = $1::uuid
          AND assignment.campaign_id = campaign.id
          AND assignment.person_id = person.id
          AND assignment.archived_at IS NULL
          AND assignment.status = 'completed'
      ) AS has_completed_assignment
    FROM local801.outreach_campaigns campaign
    JOIN local801.outreach_campaign_population population
      ON population.organization_id = campaign.organization_id
     AND population.campaign_id = campaign.id
    JOIN local801.people person
      ON person.organization_id = population.organization_id
     AND person.id = population.person_id
    WHERE campaign.organization_id = $1::uuid
      AND campaign.archived_at IS NULL
      AND campaign.status = 'draft'
      AND encode(digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      AND encode(digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, campaignHandle, personHandle]);
  if (!row) {
    throw new CampaignMutationError("POPULATION_MEMBER_NOT_FOUND", "The draft campaign participant is no longer available.", 409);
  }
  if (row.has_engagement || row.has_completed_assignment) {
    throw new CampaignMutationError(
      "POPULATION_MEMBER_IMMUTABLE",
      "This participant already has campaign activity and cannot be removed from the frozen history.",
      409,
    );
  }
  return row;
}

export async function addCampaignPopulationMember(
  context: WorkspaceContext,
  campaignHandle: unknown,
  personHandle: unknown,
  dependencies: CampaignPopulationDependencies = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const target = await resolveAddTarget(context, campaignHandle, personHandle, query);
  const populationId = (dependencies.uuid ?? randomUUID)();

  const insertStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, inserted AS (
        INSERT INTO local801.outreach_campaign_population
          (id, organization_id, campaign_id, person_id, frozen_at)
        SELECT $5::uuid, $1::uuid, campaign.id, person.id, now()
        FROM actor
        JOIN local801.outreach_campaigns campaign
          ON campaign.id = $2::uuid
         AND campaign.organization_id = $1::uuid
         AND campaign.archived_at IS NULL
         AND campaign.status = 'draft'
        JOIN local801.people person
          ON person.id = $6::uuid
         AND person.organization_id = $1::uuid
         AND person.archived_at IS NULL
         AND person.local_number = '0801'
        WHERE NOT EXISTS (
          SELECT 1
          FROM local801.outreach_campaign_population existing
          WHERE existing.organization_id = $1::uuid
            AND existing.campaign_id = campaign.id
            AND existing.person_id = person.id
        )
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS population_member_created
      FROM inserted
    `,
    parameters: [context.organizationId, target.campaign_id, context.userId, context.role, populationId, target.person_id],
  };
  const audit = await prepareAudit({
    eventType: "record.create",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "outreach_campaign_population",
    subjectId: populationId,
    payload: { campaignPopulation: true },
  }, query);
  await runTransaction([insertStatement, audit]);
  return { added: true };
}

export async function removeCampaignPopulationMember(
  context: WorkspaceContext,
  campaignHandle: unknown,
  personHandle: unknown,
  dependencies: CampaignPopulationDependencies = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const target = await resolveRemoveTarget(context, campaignHandle, personHandle, query);

  const archiveAssignmentsStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}
      UPDATE local801.engagement_assignments assignment
      SET archived_at = now()
      FROM actor
      WHERE assignment.organization_id = $1::uuid
        AND assignment.campaign_id = $2::uuid
        AND assignment.person_id = $5::uuid
        AND assignment.archived_at IS NULL
        AND assignment.status <> 'completed'
        AND EXISTS (
          SELECT 1
          FROM local801.outreach_campaigns campaign
          WHERE campaign.id = assignment.campaign_id
            AND campaign.organization_id = $1::uuid
            AND campaign.archived_at IS NULL
            AND campaign.status = 'draft'
        )
    `,
    parameters: [context.organizationId, target.campaign_id, context.userId, context.role, target.person_id],
  };

  const deletePopulationStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, deleted AS (
        DELETE FROM local801.outreach_campaign_population population
        WHERE population.id = $2::uuid
          AND population.organization_id = $1::uuid
          AND population.campaign_id = $5::uuid
          AND population.person_id = $6::uuid
          AND EXISTS (SELECT 1 FROM actor)
          AND EXISTS (
            SELECT 1
            FROM local801.outreach_campaigns campaign
            WHERE campaign.id = population.campaign_id
              AND campaign.organization_id = $1::uuid
              AND campaign.archived_at IS NULL
              AND campaign.status = 'draft'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM local801.engagement_events event
            WHERE event.organization_id = $1::uuid
              AND event.campaign_id = population.campaign_id
              AND event.person_id = population.person_id
              AND event.voided_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM local801.engagement_assignments assignment
            WHERE assignment.organization_id = $1::uuid
              AND assignment.campaign_id = population.campaign_id
              AND assignment.person_id = population.person_id
              AND assignment.archived_at IS NULL
              AND assignment.status = 'completed'
          )
        RETURNING population.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS population_member_removed
      FROM deleted
    `,
    parameters: [
      context.organizationId,
      target.population_id,
      context.userId,
      context.role,
      target.campaign_id,
      target.person_id,
    ],
  };
  const audit = await prepareAudit({
    eventType: "record.archive",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "outreach_campaign_population",
    subjectId: target.population_id,
    payload: { campaignPopulation: true, openAssignmentsArchived: true },
  }, query);
  await runTransaction([archiveAssignmentsStatement, deletePopulationStatement, audit]);
  return { removed: true };
}

export const __testing = {
  MAX_CANDIDATES,
  MAX_SEARCH_LENGTH,
  normalizeSearch,
  requireHandle,
};
