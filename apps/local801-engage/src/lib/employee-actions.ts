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

export type EmployeeActionResponse = "willing" | "considering" | "declined" | "completed";
export type EmployeeActionPosture = "open_to_actions" | "declines_all";
export type EmployeeActionResponseOption = { value: EmployeeActionResponse; label: string; enabled: boolean };

export type EmployeeActionDefinition = {
  handle: string;
  label: string;
  engagementLevel: number;
  scope: "organization" | "campaign" | "cat_action";
  responseOptions: EmployeeActionResponseOption[];
};

export type EmployeeActionProfileItem = EmployeeActionDefinition & {
  response: EmployeeActionResponse;
  firstRecordedAt: string;
  lastUpdatedAt: string;
  responseHistoryCount: number;
};

export type EmployeeActionProfile = {
  posture: EmployeeActionPosture | "not_recorded";
  postureUpdatedAt: string | null;
  actions: EmployeeActionProfileItem[];
};

type ScopeRow = {
  allowed: boolean;
  declines_all_actions: boolean | null;
};

type DefinitionRow = {
  id: string;
  label: string;
  engagement_level: unknown;
  scope: "organization" | "campaign" | "cat_action";
  willing_response_label: string;
  considering_response_label: string;
  declined_response_label: string;
  completed_response_label: string;
  enabled_response_statuses: string[];
};

type ProfileRow = DefinitionRow & {
  response_status: EmployeeActionResponse;
  first_recorded_at: string | Date;
  last_updated_at: string | Date;
  response_history_count: unknown;
};

type PostureRow = {
  declines_all_actions: boolean;
  decline_all_seq: unknown;
  reopen_seq: unknown;
  updated_at: string | Date | null;
};

export type EmployeeActionWriteDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[0-9a-f]{64}$/i;
const RESPONSE_VALUES = ["willing", "considering", "declined", "completed"] as const;
const DEFAULT_RESPONSE_LABELS: Record<EmployeeActionResponse, string> = {
  willing: "Willing",
  considering: "Considering",
  declined: "Declined",
  completed: "Completed",
};

function requireUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requireActionHandle(value: unknown) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) throw new Error("Action handle is invalid.");
  return value.toLowerCase();
}

function requireActionLabel(value: unknown) {
  if (typeof value !== "string") throw new Error("Action label is invalid.");
  const label = value.trim();
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("Action label is invalid.");
  return label;
}

function requireEngagementLevel(value: unknown) {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1 || level > 5) throw new Error("Engagement level must be from 1 to 5.");
  return level;
}

function normalizeTimestamp(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Action willingness timestamp is invalid.");
  return date.toISOString();
}

function response(value: unknown): EmployeeActionResponse {
  if (value === "willing" || value === "considering" || value === "declined" || value === "completed") return value;
  throw new Error("Employee action response is invalid.");
}

function responseLabel(value: unknown) {
  if (typeof value !== "string") throw new Error("Action response label is invalid.");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("Action response label is invalid.");
  return label;
}

function responseOptionsFromRow(row: DefinitionRow): EmployeeActionResponseOption[] {
  const enabled = new Set(Array.isArray(row.enabled_response_statuses) ? row.enabled_response_statuses : RESPONSE_VALUES);
  return [
    { value: "willing", label: row.willing_response_label || DEFAULT_RESPONSE_LABELS.willing, enabled: enabled.has("willing") },
    { value: "considering", label: row.considering_response_label || DEFAULT_RESPONSE_LABELS.considering, enabled: enabled.has("considering") },
    { value: "declined", label: row.declined_response_label || DEFAULT_RESPONSE_LABELS.declined, enabled: enabled.has("declined") },
    { value: "completed", label: row.completed_response_label || DEFAULT_RESPONSE_LABELS.completed, enabled: enabled.has("completed") },
  ];
}

function requireResponseOptions(value: unknown): EmployeeActionResponseOption[] {
  if (!Array.isArray(value) || value.length !== RESPONSE_VALUES.length) throw new Error("Action response choices are invalid.");
  const supplied = new Map<EmployeeActionResponse, EmployeeActionResponseOption>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Action response choices are invalid.");
    const item = raw as Record<string, unknown>;
    const key = response(item.value);
    if (supplied.has(key) || typeof item.enabled !== "boolean") throw new Error("Action response choices are invalid.");
    supplied.set(key, { value: key, label: responseLabel(item.label), enabled: item.enabled });
  }
  const options = RESPONSE_VALUES.map((key) => supplied.get(key)).filter((item): item is EmployeeActionResponseOption => Boolean(item));
  if (options.length !== RESPONSE_VALUES.length || !options.some((item) => item.enabled)) throw new Error("Keep at least one action response available.");
  const labels = options.filter((item) => item.enabled).map((item) => item.label.toLocaleLowerCase());
  if (new Set(labels).size !== labels.length) throw new Error("Available action response labels must be different.");
  return options;
}

function hasDefinitionManagement(context: WorkspaceContext) {
  return can(context.role, "manageActionCatalog");
}

function requireEngagementAccess(context: WorkspaceContext) {
  if (!can(context.role, "recordEngagement")) throw new Error("Employee action willingness access is not authorized.");
}

function actionHandle(organizationId: string, actionId: string) {
  return createHash("sha256").update(`${organizationId}:${actionId}`).digest("hex");
}

function scopeFromRow(value: unknown): EmployeeActionDefinition["scope"] {
  if (value === "organization" || value === "campaign" || value === "cat_action") return value;
  throw new Error("Employee action scope is invalid.");
}

async function getPersonScope(
  context: WorkspaceContext,
  personId: string,
  query: DatabaseQuery,
): Promise<ScopeRow> {
  const [row] = await query<ScopeRow>(`
    /* employee-actions:person-scope */
    SELECT
      EXISTS (
        SELECT 1
        FROM local801.people person
        WHERE person.organization_id = $1::uuid
          AND person.id = $2::uuid
          AND person.archived_at IS NULL
          AND (
            $3::text IN ('system_owner','local_admin','cat_admin')
            OR EXISTS (
              SELECT 1
              FROM local801.engagement_assignments assignment
              WHERE assignment.organization_id = $1::uuid
                AND assignment.person_id = person.id
                AND assignment.archived_at IS NULL
                AND assignment.status = 'open'
                AND (assignment.primary_user_id = $4::uuid OR assignment.backup_user_id = $4::uuid)
            )
          )
      ) AS allowed,
      COALESCE((
        SELECT current.declines_all_actions
        FROM reporting.employee_action_current_posture current
        WHERE current.organization_id = $1::uuid
          AND current.person_id = $2::uuid
        LIMIT 1
      ), false) AS declines_all_actions
  `, [context.organizationId, personId, context.role, context.userId]);
  return { allowed: Boolean(row?.allowed), declines_all_actions: Boolean(row?.declines_all_actions) };
}

async function requirePersonScope(
  context: WorkspaceContext,
  personId: string,
  query: DatabaseQuery,
) {
  requireEngagementAccess(context);
  const scope = await getPersonScope(context, personId, query);
  if (!scope.allowed) throw new Error("Employee action willingness access is not authorized.");
  return scope;
}

export async function listEmployeeActionDefinitions(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<EmployeeActionDefinition[]> {
  if (!can(context.role, "recordEngagement") && !can(context.role, "manageActionCatalog")) {
    throw new Error("Employee action catalog access is not authorized.");
  }
  const rows = await query<DefinitionRow>(`
    /* employee-actions:definitions */
    SELECT id, name AS label, engagement_level, scope_type AS scope,
      willing_response_label, considering_response_label, declined_response_label, completed_response_label,
      enabled_response_statuses
    FROM local801.employee_actions
    WHERE organization_id = $1::uuid
      AND archived_at IS NULL
    ORDER BY engagement_level ASC, name ASC, id ASC
    LIMIT 100
  `, [context.organizationId]);
  return rows.map((row) => ({
    handle: actionHandle(context.organizationId, row.id),
    label: row.label,
    engagementLevel: requireEngagementLevel(row.engagement_level),
    scope: scopeFromRow(row.scope),
    responseOptions: responseOptionsFromRow(row),
  }));
}

export async function updateEmployeeActionResponseOptions(
  context: WorkspaceContext,
  input: { actionHandle: unknown; responses: unknown },
  dependencies: EmployeeActionWriteDependencies = {},
) {
  if (!hasDefinitionManagement(context)) throw new Error("Employee action definition management is not authorized.");
  const handle = requireActionHandle(input.actionHandle);
  const options = requireResponseOptions(input.responses);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const actionId = await resolveActionId(context, handle, query);
  const labels = new Map(options.map((item) => [item.value, item.label]));
  const enabled = options.filter((item) => item.enabled).map((item) => item.value);
  const updateStatement: DatabaseStatement = {
    sql: `
      /* employee-actions:update-response-options */
      WITH updated AS (
        UPDATE local801.employee_actions action
        SET willing_response_label = $3::text,
          considering_response_label = $4::text,
          declined_response_label = $5::text,
          completed_response_label = $6::text,
          enabled_response_statuses = $7::text[],
          updated_at = now()
        WHERE action.organization_id = $1::uuid
          AND action.id = $2::uuid
          AND action.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM local801.users actor
            JOIN local801.workspace_user_roles user_role ON user_role.user_id = actor.id
            JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid
            WHERE actor.organization_id = $1::uuid AND actor.id = $8::uuid AND actor.deactivated_at IS NULL
              AND role.code = $9::text
              AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member')
          )
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS responses_updated
      FROM updated
    `,
    parameters: [context.organizationId, actionId, labels.get("willing"), labels.get("considering"), labels.get("declined"), labels.get("completed"), enabled, context.userId, context.role],
  };
  const auditStatement = await prepareAudit({
    eventType: "config.change",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "employee_action_response_options",
    subjectId: actionId,
    payload: { enabledResponses: enabled },
  }, query);
  await runTransaction([updateStatement, auditStatement]);
  return { updated: true, responseOptions: options };
}

export async function getEmployeeActionProfile(
  context: WorkspaceContext,
  personIdInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<EmployeeActionProfile> {
  const personId = requireUuid(personIdInput, "Person identifier");
  await requirePersonScope(context, personId, query);

  const [postureRows, actionRows] = await Promise.all([
    query<PostureRow>(`
      /* employee-actions:current-posture */
      SELECT
        posture.declines_all_actions,
        posture.decline_all_seq,
        posture.reopen_seq,
        GREATEST(
          (SELECT max(recorded_at) FROM local801.employee_action_all_declines decline_event
            WHERE decline_event.organization_id = $1::uuid AND decline_event.person_id = $2::uuid),
          (SELECT max(recorded_at) FROM local801.employee_action_responses response_event
            WHERE response_event.organization_id = $1::uuid AND response_event.person_id = $2::uuid)
        ) AS updated_at
      FROM reporting.employee_action_current_posture posture
      WHERE posture.organization_id = $1::uuid
        AND posture.person_id = $2::uuid
      LIMIT 1
    `, [context.organizationId, personId]),
    query<ProfileRow>(`
      /* employee-actions:current-profile */
      SELECT
        action.id,
        action.name AS label,
        action.engagement_level,
        action.scope_type AS scope,
        action.willing_response_label,
        action.considering_response_label,
        action.declined_response_label,
        action.completed_response_label,
        action.enabled_response_statuses,
        current.response_status,
        min(history.recorded_at) AS first_recorded_at,
        current.recorded_at AS last_updated_at,
        count(history.id) AS response_history_count
      FROM reporting.employee_action_current_responses current
      JOIN local801.employee_actions action
        ON action.id = current.action_id
       AND action.organization_id = current.organization_id
       AND action.archived_at IS NULL
      JOIN local801.employee_action_responses history
        ON history.organization_id = current.organization_id
       AND history.person_id = current.person_id
       AND history.action_id = current.action_id
      WHERE current.organization_id = $1::uuid
        AND current.person_id = $2::uuid
      GROUP BY
        action.id,
        action.name,
        action.engagement_level,
        action.scope_type,
        action.willing_response_label,
        action.considering_response_label,
        action.declined_response_label,
        action.completed_response_label,
        action.enabled_response_statuses,
        current.response_status,
        current.recorded_at
      ORDER BY action.engagement_level ASC, action.name ASC, action.id ASC
      LIMIT 100
    `, [context.organizationId, personId]),
  ]);

  const currentPosture = postureRows[0];
  const hasRecordedPosture = currentPosture?.decline_all_seq != null || currentPosture?.reopen_seq != null || actionRows.length > 0;
  const normalizedPosture: EmployeeActionProfile["posture"] = currentPosture?.declines_all_actions
    ? "declines_all"
    : hasRecordedPosture ? "open_to_actions" : "not_recorded";

  return {
    posture: normalizedPosture,
    postureUpdatedAt: currentPosture?.updated_at ? normalizeTimestamp(currentPosture.updated_at) : null,
    actions: actionRows.map((row) => ({
      handle: actionHandle(context.organizationId, row.id),
      label: row.label,
      engagementLevel: requireEngagementLevel(row.engagement_level),
      scope: scopeFromRow(row.scope),
      responseOptions: responseOptionsFromRow(row),
      response: response(row.response_status),
      firstRecordedAt: normalizeTimestamp(row.first_recorded_at),
      lastUpdatedAt: normalizeTimestamp(row.last_updated_at),
      responseHistoryCount: Math.max(0, Number(row.response_history_count) || 0),
    })),
  };
}

export async function createEmployeeActionDefinition(
  context: WorkspaceContext,
  input: {
    label: unknown;
    engagementLevel: unknown;
    campaignId?: unknown;
    catActionId?: unknown;
  },
  dependencies: EmployeeActionWriteDependencies = {},
) {
  if (!hasDefinitionManagement(context)) throw new Error("Employee action definition management is not authorized.");
  const label = requireActionLabel(input.label);
  const engagementLevel = requireEngagementLevel(input.engagementLevel);
  const campaignId = input.campaignId == null ? null : requireUuid(input.campaignId, "Campaign identifier");
  const catActionId = input.catActionId == null ? null : requireUuid(input.catActionId, "CAT action identifier");
  if (campaignId && catActionId) throw new Error("An employee action can belong to only one scope.");
  const scopeType: EmployeeActionDefinition["scope"] = campaignId ? "campaign" : catActionId ? "cat_action" : "organization";
  const actionId = randomUUID();
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;

  const [scope] = await query<{ campaign_valid: boolean; cat_action_valid: boolean }>(`
    /* employee-actions:validate-definition-scope */
    SELECT
      ($2::uuid IS NULL OR EXISTS (
        SELECT 1 FROM local801.outreach_campaigns campaign
        WHERE campaign.id = $2::uuid AND campaign.organization_id = $1::uuid AND campaign.status <> 'archived'
      )) AS campaign_valid,
      ($3::uuid IS NULL OR EXISTS (
        SELECT 1 FROM local801.cat_actions action
        WHERE action.id = $3::uuid AND action.organization_id = $1::uuid AND action.status <> 'archived'
      )) AS cat_action_valid
  `, [context.organizationId, campaignId, catActionId]);
  if (!scope?.campaign_valid || !scope.cat_action_valid) throw new Error("Employee action definition scope is not available.");

  const definitionStatement: DatabaseStatement = {
    sql: `
      /* employee-actions:store-definition */
      WITH inserted AS (
        INSERT INTO local801.employee_actions
          (id, organization_id, name, engagement_level, scope_type, campaign_id, cat_action_id, created_by)
        SELECT $2::uuid, $1::uuid, $3::text, $4::smallint, $5::text, $6::uuid, $7::uuid, actor.id
        FROM local801.users actor
        WHERE actor.id = $8::uuid
          AND actor.organization_id = $1::uuid
          AND actor.deactivated_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM local801.workspace_user_roles user_role
            JOIN local801.workspace_roles role
              ON role.id = user_role.role_id
             AND role.organization_id = $1::uuid
            WHERE user_role.user_id = actor.id
              AND role.code = $9::text
              AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member')
          )
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS action_created
      FROM inserted
    `,
    parameters: [context.organizationId, actionId, label, engagementLevel, scopeType, campaignId, catActionId, context.userId, context.role],
  };
  const auditStatement = await prepareAudit({
    eventType: "config.change",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "employee_action_definition",
    subjectId: actionId,
    payload: { engagementLevel, scopeType },
  }, query);
  await runTransaction([definitionStatement, auditStatement]);
  return { handle: actionHandle(context.organizationId, actionId) };
}

async function resolveActionId(
  context: WorkspaceContext,
  handle: string,
  query: DatabaseQuery,
) {
  const rows = await query<{ id: string }>(`
    /* employee-actions:resolve-handle */
    SELECT id
    FROM local801.employee_actions
    WHERE organization_id = $1::uuid
      AND archived_at IS NULL
    ORDER BY engagement_level ASC, name ASC, id ASC
    LIMIT 100
  `, [context.organizationId]);
  const match = rows.find((row) => actionHandle(context.organizationId, row.id) === handle);
  if (!match) throw new Error("Employee action target is not available.");
  return match.id;
}

async function validateEngagementEvent(
  context: WorkspaceContext,
  personId: string,
  engagementEventId: string | null,
  query: DatabaseQuery,
) {
  if (!engagementEventId) return;
  const [row] = await query<{ valid: boolean }>(`
    /* employee-actions:validate-engagement-event */
    SELECT EXISTS (
      SELECT 1
      FROM local801.engagement_events event
      WHERE event.id = $3::uuid
        AND event.organization_id = $1::uuid
        AND event.person_id = $2::uuid
        AND event.voided_at IS NULL
    ) AS valid
  `, [context.organizationId, personId, engagementEventId]);
  if (!row?.valid) throw new Error("Engagement event is not available.");
}

function responseInsertStatement(
  context: WorkspaceContext,
  personId: string,
  actionId: string,
  selectedResponse: EmployeeActionResponse,
  engagementEventId: string | null,
): DatabaseStatement {
  return {
    sql: `
      /* employee-actions:append-response */
      WITH inserted AS (
        INSERT INTO local801.employee_action_responses
          (organization_id, person_id, action_id, engagement_event_id, response_status, recorded_by, recorded_at)
        SELECT
          $1::uuid,
          person.id,
          action.id,
          event.id,
          $4::text,
          actor.id,
          COALESCE(event.occurred_at, now())
        FROM local801.people person
        JOIN local801.employee_actions action
          ON action.id = $3::uuid
         AND action.organization_id = $1::uuid
         AND action.archived_at IS NULL
        JOIN local801.users actor
          ON actor.id = $5::uuid
         AND actor.organization_id = $1::uuid
         AND actor.deactivated_at IS NULL
        LEFT JOIN local801.engagement_events event
          ON event.id = $6::uuid
         AND event.organization_id = $1::uuid
         AND event.person_id = person.id
         AND event.voided_at IS NULL
        WHERE person.organization_id = $1::uuid
          AND person.id = $2::uuid
          AND person.archived_at IS NULL
          AND ($6::uuid IS NULL OR event.id IS NOT NULL)
          AND $4::text = ANY(action.enabled_response_statuses)
          AND (
            $7::text IN ('system_owner','local_admin','cat_admin')
            OR EXISTS (
              SELECT 1
              FROM local801.engagement_assignments assignment
              WHERE assignment.organization_id = $1::uuid
                AND assignment.person_id = person.id
                AND assignment.archived_at IS NULL
                AND assignment.status = 'open'
                AND (assignment.primary_user_id = actor.id OR assignment.backup_user_id = actor.id)
            )
          )
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS response_recorded
      FROM inserted
    `,
    parameters: [context.organizationId, personId, actionId, selectedResponse, context.userId, engagementEventId, context.role],
  };
}

function declineAllInsertStatement(
  context: WorkspaceContext,
  personId: string,
  engagementEventId: string | null,
): DatabaseStatement {
  return {
    sql: `
      /* employee-actions:append-decline-all */
      WITH inserted AS (
        INSERT INTO local801.employee_action_all_declines
          (organization_id, person_id, engagement_event_id, recorded_by, recorded_at)
        SELECT
          $1::uuid,
          person.id,
          event.id,
          actor.id,
          COALESCE(event.occurred_at, now())
        FROM local801.people person
        JOIN local801.users actor
          ON actor.id = $3::uuid
         AND actor.organization_id = $1::uuid
         AND actor.deactivated_at IS NULL
        LEFT JOIN local801.engagement_events event
          ON event.id = $4::uuid
         AND event.organization_id = $1::uuid
         AND event.person_id = person.id
         AND event.voided_at IS NULL
        WHERE person.organization_id = $1::uuid
          AND person.id = $2::uuid
          AND person.archived_at IS NULL
          AND ($4::uuid IS NULL OR event.id IS NOT NULL)
          AND (
            $5::text IN ('system_owner','local_admin','cat_admin')
            OR EXISTS (
              SELECT 1
              FROM local801.engagement_assignments assignment
              WHERE assignment.organization_id = $1::uuid
                AND assignment.person_id = person.id
                AND assignment.archived_at IS NULL
                AND assignment.status = 'open'
                AND (assignment.primary_user_id = actor.id OR assignment.backup_user_id = actor.id)
            )
          )
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS decline_all_recorded
      FROM inserted
    `,
    parameters: [context.organizationId, personId, context.userId, engagementEventId, context.role],
  };
}

export async function recordEmployeeActionResponse(
  context: WorkspaceContext,
  input: {
    personId: unknown;
    actionHandle: unknown;
    response: unknown;
    engagementEventId?: unknown;
  },
  dependencies: EmployeeActionWriteDependencies = {},
) {
  const personId = requireUuid(input.personId, "Person identifier");
  const handle = requireActionHandle(input.actionHandle);
  const selectedResponse = response(input.response);
  const engagementEventId = input.engagementEventId == null ? null : requireUuid(input.engagementEventId, "Engagement event identifier");
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;

  const scope = await requirePersonScope(context, personId, query);
  const actionId = await resolveActionId(context, handle, query);
  await validateEngagementEvent(context, personId, engagementEventId, query);
  if (scope.declines_all_actions && selectedResponse === "declined") {
    throw new Error("The employee currently declines all actions.");
  }

  const autoReopened = scope.declines_all_actions && selectedResponse !== "declined";
  const statements = [
    responseInsertStatement(context, personId, actionId, selectedResponse, engagementEventId),
    await prepareAudit({
      eventType: "record.update",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "employee_action_willingness",
      subjectId: personId,
      payload: { response: selectedResponse, autoReopened },
    }, query),
  ];
  await runTransaction(statements);
  return { recorded: true, response: selectedResponse, autoReopened };
}

export async function recordEmployeeActionPosture(
  context: WorkspaceContext,
  input: {
    personId: unknown;
    posture: unknown;
    engagementEventId?: unknown;
  },
  dependencies: EmployeeActionWriteDependencies = {},
) {
  const personId = requireUuid(input.personId, "Person identifier");
  if (input.posture !== "declines_all") {
    throw new Error("Open-to-actions posture is established by recording a willing, considering, or completed action.");
  }
  const engagementEventId = input.engagementEventId == null ? null : requireUuid(input.engagementEventId, "Engagement event identifier");
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;

  await requirePersonScope(context, personId, query);
  await validateEngagementEvent(context, personId, engagementEventId, query);
  const statements = [
    declineAllInsertStatement(context, personId, engagementEventId),
    await prepareAudit({
      eventType: "record.update",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "employee_action_posture",
      subjectId: personId,
      payload: { posture: "declines_all" },
    }, query),
  ];
  await runTransaction(statements);
  return { recorded: true, posture: "declines_all" as const };
}

export const __testing = {
  HANDLE_RE,
  actionHandle,
  requireEngagementLevel,
  requireActionLabel,
  response,
  requireResponseOptions,
};
