import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import {
  queryLocal801,
  runLocal801Transaction,
  type DatabaseQuery,
  type DatabaseStatement,
} from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CAMPAIGN_NAME = 160;
const MAX_ASSIGNMENT_MS = 2 * 366 * 24 * 60 * 60 * 1000;
const managementRoles = ["system_owner", "local_admin", "cat_admin"] as const;
const assigneeRoles = ["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"] as const;

export type CampaignManagementDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
  now?: () => Date;
  uuid?: () => string;
};

export type CampaignManagementOption = {
  handle: string;
  label: string;
  detail: string | null;
};

export type CampaignManagementOptions = {
  assignees: CampaignManagementOption[];
};

export class CampaignMutationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CampaignMutationError";
    this.code = code;
    this.status = status;
  }
}

type CampaignResolution = {
  id: string;
  name: string;
  status: string;
  starts_on: string | Date | null;
  ends_on: string | Date | null;
  launched_at: string | Date | null;
};

type ParticipantResolution = {
  person_id: string;
  campaign_id: string;
  campaign_status: string;
  assignment_id: string | null;
  assignment_status: string | null;
  primary_user_id: string | null;
  due_at: string | Date | null;
};

type IdRow = { id: string };
type AssigneeOptionRow = { handle: string; display_name: string; role_codes: string | null };

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCampaigns")) {
    throw new CampaignMutationError("FORBIDDEN", "Campaign management is not authorized.", 403);
  }
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new CampaignMutationError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

function normalizeText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new CampaignMutationError("INVALID_INPUT", `${label} is required.`, 400);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) {
    throw new CampaignMutationError("INVALID_INPUT", `${label} must be between 1 and ${maxLength} characters.`, 400);
  }
  return normalized;
}

function normalizeStatus(value: unknown, allowClosed = true) {
  if (value === "draft" || value === "active" || (allowClosed && value === "closed")) return value;
  throw new CampaignMutationError("INVALID_STATUS", "The campaign status is invalid.", 400);
}

function normalizeDate(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new CampaignMutationError("INVALID_DATE", `${label} is invalid.`, 400);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CampaignMutationError("INVALID_DATE", `${label} is invalid.`, 400);
  }
  return value;
}

function dateOnly(value: string | Date | null) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function validateDateRange(startsOn: string | null, endsOn: string | null) {
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new CampaignMutationError("INVALID_DATE_RANGE", "Campaign end date cannot be before the start date.", 400);
  }
}

function normalizeDueAt(value: unknown, now: Date) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new CampaignMutationError("INVALID_DUE_AT", "The assignment due date is invalid.", 400);
  }
  const parsed = new Date(value);
  const timestamp = parsed.getTime();
  if (Number.isNaN(timestamp)) {
    throw new CampaignMutationError("INVALID_DUE_AT", "The assignment due date is invalid.", 400);
  }
  if (timestamp <= now.getTime()) {
    throw new CampaignMutationError("INVALID_DUE_AT", "An assignment due date must be in the future.", 400);
  }
  if (timestamp > now.getTime() + MAX_ASSIGNMENT_MS) {
    throw new CampaignMutationError("INVALID_DUE_AT", "The assignment due date is too far in the future.", 400);
  }
  return parsed.toISOString();
}

function sameTimestamp(left: string | Date | null, right: string | null) {
  if (left === null || right === null) return left === null && right === null;
  return new Date(left).getTime() === new Date(right).getTime();
}

function opaqueHandle(kind: "campaign", organizationId: string, id: string) {
  return createHash("sha256").update(`${kind}:${organizationId}:${id}`).digest("hex");
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

async function resolveCampaign(context: WorkspaceContext, campaignHandleInput: unknown, query: DatabaseQuery) {
  requireAccess(context);
  const handle = requireHandle(campaignHandleInput, "Campaign");
  const [row] = await query<CampaignResolution>(`
    /* campaign-management:resolve-campaign */
    SELECT campaign.id, campaign.name, campaign.status, campaign.starts_on, campaign.ends_on, campaign.launched_at
    FROM local801.outreach_campaigns campaign
    WHERE campaign.organization_id = $1::uuid
      AND campaign.archived_at IS NULL
      AND campaign.status <> 'archived'
      AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row) throw new CampaignMutationError("CAMPAIGN_NOT_FOUND", "The campaign is no longer available.", 409);
  return row;
}

async function resolveParticipant(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  personHandleInput: unknown,
  query: DatabaseQuery,
) {
  requireAccess(context);
  const campaignHandle = requireHandle(campaignHandleInput, "Campaign");
  const personHandle = requireHandle(personHandleInput, "Employee");
  const [row] = await query<ParticipantResolution>(`
    /* campaign-management:resolve-participant */
    SELECT person.id AS person_id, campaign.id AS campaign_id, campaign.status AS campaign_status,
      assignment.id AS assignment_id, assignment.status AS assignment_status,
      assignment.primary_user_id, assignment.due_at
    FROM local801.outreach_campaigns campaign
    JOIN local801.outreach_campaign_population population
      ON population.organization_id = campaign.organization_id
     AND population.campaign_id = campaign.id
    JOIN local801.people person
      ON person.organization_id = population.organization_id
     AND person.id = population.person_id
     AND person.archived_at IS NULL
    LEFT JOIN LATERAL (
      SELECT current_assignment.id, current_assignment.status, current_assignment.primary_user_id, current_assignment.due_at
      FROM local801.engagement_assignments current_assignment
      WHERE current_assignment.organization_id = $1::uuid
        AND current_assignment.campaign_id = campaign.id
        AND current_assignment.person_id = person.id
        AND current_assignment.archived_at IS NULL
      ORDER BY current_assignment.created_at DESC, current_assignment.id DESC
      LIMIT 1
    ) assignment ON true
    WHERE campaign.organization_id = $1::uuid
      AND campaign.archived_at IS NULL
      AND campaign.status <> 'archived'
      AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, campaignHandle, personHandle]);
  if (!row) throw new CampaignMutationError("PARTICIPANT_NOT_FOUND", "The campaign participant is no longer available.", 409);
  return row;
}

async function resolveAssignee(context: WorkspaceContext, assigneeHandleInput: unknown, query: DatabaseQuery) {
  const handle = requireHandle(assigneeHandleInput, "Campaign organizer");
  const [row] = await query<IdRow>(`
    /* campaign-management:resolve-assignee */
    SELECT candidate.id
    FROM local801.users candidate
    WHERE candidate.organization_id = $1::uuid
      AND candidate.deactivated_at IS NULL
      AND encode(public.digest('user:' || $1::text || ':' || candidate.id::text, 'sha256'), 'hex') = $2::text
      AND EXISTS (
        SELECT 1
        FROM local801.workspace_user_roles user_role
        JOIN local801.workspace_roles role
          ON role.id = user_role.role_id
         AND role.organization_id = $1::uuid
        WHERE user_role.user_id = candidate.id
          AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
      )
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row) throw new CampaignMutationError("INVALID_ASSIGNEE", "The selected CAT organizer is not available.", 400);
  return row.id;
}

export async function getCampaignManagementOptions(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<CampaignManagementOptions> {
  requireAccess(context);
  const rows = await query<AssigneeOptionRow>(`
    /* campaign-management:assignee-options */
    SELECT
      encode(public.digest('user:' || $1::text || ':' || app_user.id::text, 'sha256'), 'hex') AS handle,
      app_user.display_name,
      string_agg(DISTINCT role.code, ', ' ORDER BY role.code) AS role_codes
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
     AND role.organization_id = $1::uuid
    WHERE app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
    GROUP BY app_user.id, app_user.display_name
    ORDER BY app_user.display_name ASC, app_user.id ASC
    LIMIT 200
  `, [context.organizationId]);
  return {
    assignees: rows.filter((row) => HANDLE_RE.test(row.handle)).map((row) => ({
      handle: row.handle,
      label: row.display_name,
      detail: row.role_codes,
    })),
  };
}

export async function createCampaign(
  context: WorkspaceContext,
  input: { name: unknown; status?: unknown; startsOn?: unknown; endsOn?: unknown },
  dependencies: CampaignManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const id = (dependencies.uuid ?? randomUUID)();
  const name = normalizeText(input.name, "Campaign name", MAX_CAMPAIGN_NAME);
  const status = input.status === undefined ? "draft" : normalizeStatus(input.status, false);
  const startsOn = normalizeDate(input.startsOn, "Campaign start date") ?? null;
  const endsOn = normalizeDate(input.endsOn, "Campaign end date") ?? null;
  validateDateRange(startsOn, endsOn);

  const insertStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, inserted AS (
        INSERT INTO local801.outreach_campaigns
          (id, organization_id, name, status, starts_on, ends_on, created_by, launched_at)
        SELECT $2::uuid, $1::uuid, $5::text, $6::text, $7::date, $8::date, actor.id,
          CASE WHEN $6::text = 'active' THEN now() ELSE NULL END
        FROM actor
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS campaign_created
      FROM inserted
    `,
    parameters: [context.organizationId, id, context.userId, context.role, name, status, startsOn, endsOn],
  };
  const audit = await prepareAudit({
    eventType: "record.create",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "outreach_campaign",
    subjectId: id,
    payload: { status, startDateSet: Boolean(startsOn), endDateSet: Boolean(endsOn) },
  }, query);
  await runTransaction([insertStatement, audit]);
  return { created: true, handle: opaqueHandle("campaign", context.organizationId, id) };
}

function validateTransition(current: string, next: string) {
  if (current === "closed") {
    throw new CampaignMutationError("CAMPAIGN_CLOSED", "Closed campaigns are read-only until archived.", 409);
  }
  if (current === "active" && next === "draft") {
    throw new CampaignMutationError("INVALID_STATUS_TRANSITION", "An active campaign cannot return to draft status.", 409);
  }
}

export async function updateCampaign(
  context: WorkspaceContext,
  input: { campaignHandle: unknown; name?: unknown; status?: unknown; startsOn?: unknown; endsOn?: unknown },
  dependencies: CampaignManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const campaign = await resolveCampaign(context, input.campaignHandle, query);
  const hasName = Object.prototype.hasOwnProperty.call(input, "name");
  const hasStatus = Object.prototype.hasOwnProperty.call(input, "status");
  const hasStartsOn = Object.prototype.hasOwnProperty.call(input, "startsOn");
  const hasEndsOn = Object.prototype.hasOwnProperty.call(input, "endsOn");
  if (!hasName && !hasStatus && !hasStartsOn && !hasEndsOn) {
    throw new CampaignMutationError("NO_CHANGES", "Choose a campaign field to update.", 400);
  }
  if (campaign.status === "closed") {
    throw new CampaignMutationError("CAMPAIGN_CLOSED", "Closed campaigns are read-only until archived.", 409);
  }

  const name = hasName ? normalizeText(input.name, "Campaign name", MAX_CAMPAIGN_NAME) : campaign.name;
  const status = hasStatus ? normalizeStatus(input.status) : campaign.status;
  validateTransition(campaign.status, status);
  const startsOn = hasStartsOn ? normalizeDate(input.startsOn, "Campaign start date") ?? null : dateOnly(campaign.starts_on);
  const endsOn = hasEndsOn ? normalizeDate(input.endsOn, "Campaign end date") ?? null : dateOnly(campaign.ends_on);
  validateDateRange(startsOn, endsOn);

  const nameChanged = name !== campaign.name;
  const statusChanged = status !== campaign.status;
  const startsOnChanged = startsOn !== dateOnly(campaign.starts_on);
  const endsOnChanged = endsOn !== dateOnly(campaign.ends_on);
  if (!nameChanged && !statusChanged && !startsOnChanged && !endsOnChanged) {
    throw new CampaignMutationError("NO_CHANGES", "The campaign already has those settings.", 400);
  }

  const updateStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, updated AS (
        UPDATE local801.outreach_campaigns campaign
        SET
          name = CASE WHEN $9::boolean THEN $5::text ELSE campaign.name END,
          status = CASE WHEN $10::boolean THEN $6::text ELSE campaign.status END,
          starts_on = CASE WHEN $11::boolean THEN $7::date ELSE campaign.starts_on END,
          ends_on = CASE WHEN $12::boolean THEN $8::date ELSE campaign.ends_on END,
          launched_at = CASE
            WHEN $10::boolean AND $6::text = 'active' THEN COALESCE(campaign.launched_at, now())
            ELSE campaign.launched_at
          END
        FROM actor
        WHERE campaign.id = $2::uuid
          AND campaign.organization_id = $1::uuid
          AND campaign.archived_at IS NULL
          AND campaign.status = $13::text
          AND campaign.status <> 'archived'
        RETURNING campaign.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS campaign_updated
      FROM updated
    `,
    parameters: [
      context.organizationId,
      campaign.id,
      context.userId,
      context.role,
      name,
      status,
      startsOn,
      endsOn,
      nameChanged,
      statusChanged,
      startsOnChanged,
      endsOnChanged,
      campaign.status,
    ],
  };
  const audit = await prepareAudit({
    eventType: "record.update",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "outreach_campaign",
    subjectId: campaign.id,
    payload: {
      nameChanged,
      statusChanged,
      status: statusChanged ? status : null,
      startDateChanged: startsOnChanged,
      endDateChanged: endsOnChanged,
    },
  }, query);
  await runTransaction([updateStatement, audit]);
  return { updated: true };
}

export async function archiveCampaign(
  context: WorkspaceContext,
  campaignHandle: unknown,
  dependencies: CampaignManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const campaign = await resolveCampaign(context, campaignHandle, query);
  if (campaign.status !== "closed") {
    throw new CampaignMutationError("CAMPAIGN_NOT_CLOSED", "Close the campaign before archiving it.", 409);
  }

  const campaignStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, updated AS (
        UPDATE local801.outreach_campaigns campaign
        SET status = 'archived', archived_at = now()
        FROM actor
        WHERE campaign.id = $2::uuid
          AND campaign.organization_id = $1::uuid
          AND campaign.archived_at IS NULL
          AND campaign.status = 'closed'
        RETURNING campaign.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS campaign_archived
      FROM updated
    `,
    parameters: [context.organizationId, campaign.id, context.userId, context.role],
  };
  const assignmentStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}
      UPDATE local801.engagement_assignments assignment
      SET archived_at = now()
      FROM actor
      WHERE assignment.organization_id = $1::uuid
        AND assignment.campaign_id = $2::uuid
        AND assignment.archived_at IS NULL
        AND assignment.status <> 'completed'
    `,
    parameters: [context.organizationId, campaign.id, context.userId, context.role],
  };
  const audit = await prepareAudit({
    eventType: "record.archive",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "outreach_campaign",
    subjectId: campaign.id,
    payload: { previousStatus: campaign.status, openAssignmentsArchived: true },
  }, query);
  await runTransaction([campaignStatement, assignmentStatement, audit]);
  return { archived: true };
}

export async function updateCampaignAssignment(
  context: WorkspaceContext,
  input: {
    campaignHandle: unknown;
    personHandle: unknown;
    assigneeHandle?: unknown;
    dueAt?: unknown;
  },
  dependencies: CampaignManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const now = (dependencies.now ?? (() => new Date()))();
  const participant = await resolveParticipant(context, input.campaignHandle, input.personHandle, query);
  if (participant.campaign_status === "closed") {
    throw new CampaignMutationError("CAMPAIGN_CLOSED", "Assignments in a closed campaign are read-only.", 409);
  }
  if (participant.assignment_status === "completed") {
    throw new CampaignMutationError("ASSIGNMENT_COMPLETE", "Completed campaign assignments are read-only.", 409);
  }

  const hasAssignee = Object.prototype.hasOwnProperty.call(input, "assigneeHandle");
  const hasDueAt = Object.prototype.hasOwnProperty.call(input, "dueAt");
  if (!hasAssignee && !hasDueAt) {
    throw new CampaignMutationError("NO_CHANGES", "Choose an organizer or due date before saving.", 400);
  }
  const assigneeId = hasAssignee
    ? input.assigneeHandle === null || input.assigneeHandle === ""
      ? null
      : await resolveAssignee(context, input.assigneeHandle, query)
    : participant.primary_user_id;
  const dueAt = hasDueAt
    ? normalizeDueAt(input.dueAt, now)
    : participant.due_at === null ? null : new Date(participant.due_at).toISOString();

  if (!participant.assignment_id) {
    if (!assigneeId) {
      throw new CampaignMutationError("ASSIGNEE_REQUIRED", "Choose a CAT organizer before creating this campaign assignment.", 400);
    }
    const id = (dependencies.uuid ?? randomUUID)();
    const insertStatement: DatabaseStatement = {
      sql: `
        WITH ${actorCte()}, inserted AS (
          INSERT INTO local801.engagement_assignments
            (id, organization_id, campaign_id, person_id, primary_user_id, assignment_type, status, due_at, created_by)
          SELECT $5::uuid, $1::uuid, campaign.id, person.id, $6::uuid, 'direct', 'open', $7::timestamptz, actor.id
          FROM actor
          JOIN local801.outreach_campaigns campaign
            ON campaign.id = $2::uuid
           AND campaign.organization_id = $1::uuid
           AND campaign.archived_at IS NULL
           AND campaign.status IN ('draft','active')
          JOIN local801.outreach_campaign_population population
            ON population.organization_id = $1::uuid
           AND population.campaign_id = campaign.id
           AND population.person_id = $8::uuid
          JOIN local801.people person
            ON person.organization_id = $1::uuid
           AND person.id = population.person_id
           AND person.archived_at IS NULL
          WHERE EXISTS (
            SELECT 1
            FROM local801.users candidate
            WHERE candidate.id = $6::uuid
              AND candidate.organization_id = $1::uuid
              AND candidate.deactivated_at IS NULL
              AND EXISTS (
                SELECT 1
                FROM local801.workspace_user_roles user_role
                JOIN local801.workspace_roles role
                  ON role.id = user_role.role_id
                 AND role.organization_id = $1::uuid
                WHERE user_role.user_id = candidate.id
                  AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
              )
          )
          RETURNING id
        )
        SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS assignment_created
        FROM inserted
      `,
      parameters: [context.organizationId, participant.campaign_id, context.userId, context.role, id, assigneeId, dueAt, participant.person_id],
    };
    const audit = await prepareAudit({
      eventType: "record.create",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "engagement_assignment",
      subjectId: id,
      payload: { campaignAssignment: true, assigned: true, dueAtSet: Boolean(dueAt) },
    }, query);
    await runTransaction([insertStatement, audit]);
    return { updated: true, created: true };
  }

  if (hasAssignee && assigneeId === null) {
    const archiveStatement: DatabaseStatement = {
      sql: `
        WITH ${actorCte()}, updated AS (
          UPDATE local801.engagement_assignments assignment
          SET archived_at = now()
          FROM actor
          WHERE assignment.id = $2::uuid
            AND assignment.organization_id = $1::uuid
            AND assignment.campaign_id = $5::uuid
            AND assignment.person_id = $6::uuid
            AND assignment.archived_at IS NULL
            AND assignment.status = 'open'
          RETURNING assignment.id
        )
        SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS assignment_archived
        FROM updated
      `,
      parameters: [context.organizationId, participant.assignment_id, context.userId, context.role, participant.campaign_id, participant.person_id],
    };
    const audit = await prepareAudit({
      eventType: "record.archive",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "engagement_assignment",
      subjectId: participant.assignment_id,
      payload: { campaignAssignment: true, unassigned: true },
    }, query);
    await runTransaction([archiveStatement, audit]);
    return { updated: true, unassigned: true };
  }

  const assigneeChanged = assigneeId !== participant.primary_user_id;
  const dueAtChanged = !sameTimestamp(participant.due_at, dueAt);
  if (!assigneeChanged && !dueAtChanged) {
    throw new CampaignMutationError("NO_CHANGES", "The campaign assignment already has those settings.", 400);
  }

  const updateStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, updated AS (
        UPDATE local801.engagement_assignments assignment
        SET
          primary_user_id = CASE WHEN $8::boolean THEN $5::uuid ELSE assignment.primary_user_id END,
          due_at = CASE WHEN $9::boolean THEN $6::timestamptz ELSE assignment.due_at END
        FROM actor
        WHERE assignment.id = $2::uuid
          AND assignment.organization_id = $1::uuid
          AND assignment.campaign_id = $7::uuid
          AND assignment.person_id = $10::uuid
          AND assignment.archived_at IS NULL
          AND assignment.status = 'open'
          AND EXISTS (
            SELECT 1 FROM local801.outreach_campaigns campaign
            WHERE campaign.id = assignment.campaign_id
              AND campaign.organization_id = $1::uuid
              AND campaign.archived_at IS NULL
              AND campaign.status IN ('draft','active')
          )
          AND (NOT $8::boolean OR EXISTS (
            SELECT 1
            FROM local801.users candidate
            WHERE candidate.id = $5::uuid
              AND candidate.organization_id = $1::uuid
              AND candidate.deactivated_at IS NULL
              AND EXISTS (
                SELECT 1
                FROM local801.workspace_user_roles user_role
                JOIN local801.workspace_roles role
                  ON role.id = user_role.role_id
                 AND role.organization_id = $1::uuid
                WHERE user_role.user_id = candidate.id
                  AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
              )
          ))
        RETURNING assignment.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS assignment_updated
      FROM updated
    `,
    parameters: [
      context.organizationId,
      participant.assignment_id,
      context.userId,
      context.role,
      assigneeId,
      dueAt,
      participant.campaign_id,
      assigneeChanged,
      dueAtChanged,
      participant.person_id,
    ],
  };
  const audit = await prepareAudit({
    eventType: "record.update",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "engagement_assignment",
    subjectId: participant.assignment_id,
    payload: { campaignAssignment: true, reassigned: assigneeChanged, dueAtChanged, dueAtSet: dueAtChanged ? Boolean(dueAt) : null },
  }, query);
  await runTransaction([updateStatement, audit]);
  return { updated: true, reassigned: assigneeChanged, dueAtChanged };
}

export const __testing = {
  assigneeRoles,
  managementRoles,
  normalizeDate,
  normalizeDueAt,
  normalizeStatus,
  normalizeText,
  opaqueHandle,
  requireHandle,
  sameTimestamp,
  validateDateRange,
  validateTransition,
};
