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
const MAX_ACTION_NAME = 160;
const MAX_TASK_TITLE = 240;
const MAX_DUE_MS = 2 * 366 * 24 * 60 * 60 * 1000;
const managementRoles = ["system_owner", "local_admin", "cat_admin"] as const;
const assigneeRoles = ["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"] as const;

export type CatActionManagementDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
  now?: () => Date;
  uuid?: () => string;
};

export type CatActionManagementOption = {
  handle: string;
  label: string;
  detail: string | null;
};

export type CatActionManagementOptions = {
  contractCycles: CatActionManagementOption[];
  assignees: CatActionManagementOption[];
};

export class CatActionMutationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CatActionMutationError";
    this.code = code;
    this.status = status;
  }
}

type ActionResolution = {
  id: string;
  name: string;
  status: string;
  contract_cycle_id: string | null;
};

type TaskResolution = {
  id: string;
  action_id: string;
  action_status: string;
  title: string;
  status: string;
  assigned_to: string | null;
  due_at: string | Date | null;
};

type IdRow = { id: string };
type CycleOptionRow = { handle: string; name: string; status: string | null; starts_on: string | Date | null; ends_on: string | Date | null };
type AssigneeOptionRow = { handle: string; display_name: string; role_codes: string | null };

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCatActions")) {
    throw new CatActionMutationError("FORBIDDEN", "CAT action management is not authorized.", 403);
  }
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new CatActionMutationError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

function normalizeText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new CatActionMutationError("INVALID_INPUT", `${label} is required.`, 400);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) {
    throw new CatActionMutationError("INVALID_INPUT", `${label} must be between 1 and ${maxLength} characters.`, 400);
  }
  return normalized;
}

function normalizeActionStatus(value: unknown, allowClosed = true) {
  if (value === "draft" || value === "active" || (allowClosed && value === "closed")) return value;
  throw new CatActionMutationError("INVALID_STATUS", "The CAT action status is invalid.", 400);
}

function normalizeTaskStatus(value: unknown) {
  if (value === "open" || value === "complete") return value;
  throw new CatActionMutationError("INVALID_STATUS", "The CAT task status is invalid.", 400);
}

function normalizeDueAt(value: unknown, now: Date, requireFuture: boolean) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new CatActionMutationError("INVALID_DUE_AT", "The CAT task due date is invalid.", 400);
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (Number.isNaN(time)) {
    throw new CatActionMutationError("INVALID_DUE_AT", "The CAT task due date is invalid.", 400);
  }
  if (requireFuture && time <= now.getTime()) {
    throw new CatActionMutationError("INVALID_DUE_AT", "An open CAT task must be due in the future when its due date is changed.", 400);
  }
  if (time > now.getTime() + MAX_DUE_MS) {
    throw new CatActionMutationError("INVALID_DUE_AT", "The CAT task due date is too far in the future.", 400);
  }
  return parsed.toISOString();
}

function sameTimestamp(left: string | Date | null, right: string | null) {
  if (left === null || right === null) return left === null && right === null;
  return new Date(left).getTime() === new Date(right).getTime();
}

function opaqueHandle(kind: "cat-action" | "cat-action-task", organizationId: string, id: string) {
  return createHash("sha256").update(`${kind}:${organizationId}:${id}`).digest("hex");
}

async function resolveAction(context: WorkspaceContext, actionHandleInput: unknown, query: DatabaseQuery) {
  requireAccess(context);
  const handle = requireHandle(actionHandleInput, "CAT action");
  const [row] = await query<ActionResolution>(`
    /* cat-action-management:resolve-action */
    SELECT action.id, action.name, action.status, action.contract_cycle_id
    FROM local801.cat_actions action
    WHERE action.organization_id = $1::uuid
      AND action.archived_at IS NULL
      AND action.status <> 'archived'
      AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row) throw new CatActionMutationError("ACTION_NOT_FOUND", "The CAT action is no longer available.", 409);
  return row;
}

async function resolveTask(
  context: WorkspaceContext,
  actionHandleInput: unknown,
  taskHandleInput: unknown,
  query: DatabaseQuery,
) {
  requireAccess(context);
  const actionHandle = requireHandle(actionHandleInput, "CAT action");
  const taskHandle = requireHandle(taskHandleInput, "CAT task");
  const [row] = await query<TaskResolution>(`
    /* cat-action-management:resolve-task */
    SELECT task.id, task.cat_action_id AS action_id, action.status AS action_status,
      task.title, task.status, task.assigned_to, task.due_at
    FROM local801.cat_action_tasks task
    JOIN local801.cat_actions action
      ON action.organization_id = task.organization_id
     AND action.id = task.cat_action_id
    WHERE task.organization_id = $1::uuid
      AND action.archived_at IS NULL
      AND action.status <> 'archived'
      AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $2::text
      AND encode(public.digest('cat-action-task:' || task.organization_id::text || ':' || task.id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, actionHandle, taskHandle]);
  if (!row) throw new CatActionMutationError("TASK_NOT_FOUND", "The CAT task is no longer available.", 409);
  return row;
}

async function resolveCycle(context: WorkspaceContext, cycleHandleInput: unknown, query: DatabaseQuery) {
  const handle = requireHandle(cycleHandleInput, "Contract cycle");
  const [row] = await query<IdRow>(`
    /* cat-action-management:resolve-cycle */
    SELECT cycle.id
    FROM local801.contract_cycles cycle
    WHERE cycle.organization_id = $1::uuid
      AND encode(public.digest('contract-cycle:' || cycle.organization_id::text || ':' || cycle.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row) throw new CatActionMutationError("INVALID_CYCLE", "The selected contract cycle is not available.", 400);
  return row.id;
}

async function resolveAssignee(context: WorkspaceContext, assigneeHandleInput: unknown, query: DatabaseQuery) {
  const handle = requireHandle(assigneeHandleInput, "CAT task assignee");
  const [row] = await query<IdRow>(`
    /* cat-action-management:resolve-assignee */
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
  if (!row) throw new CatActionMutationError("INVALID_ASSIGNEE", "The selected CAT organizer is not available.", 400);
  return row.id;
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

export async function getCatActionManagementOptions(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<CatActionManagementOptions> {
  requireAccess(context);
  const [cycleRows, assigneeRows] = await Promise.all([
    query<CycleOptionRow>(`
      /* cat-action-management:cycle-options */
      SELECT
        encode(public.digest('contract-cycle:' || cycle.organization_id::text || ':' || cycle.id::text, 'sha256'), 'hex') AS handle,
        cycle.name,
        cycle.status,
        cycle.starts_on,
        cycle.ends_on
      FROM local801.contract_cycles cycle
      WHERE cycle.organization_id = $1::uuid
      ORDER BY cycle.starts_on DESC NULLS LAST, cycle.name ASC
      LIMIT 100
    `, [context.organizationId]),
    query<AssigneeOptionRow>(`
      /* cat-action-management:assignee-options */
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
    `, [context.organizationId]),
  ]);
  return {
    contractCycles: cycleRows.filter((row) => HANDLE_RE.test(row.handle)).map((row) => ({
      handle: row.handle,
      label: row.name,
      detail: row.status?.trim() || null,
    })),
    assignees: assigneeRows.filter((row) => HANDLE_RE.test(row.handle)).map((row) => ({
      handle: row.handle,
      label: row.display_name,
      detail: row.role_codes,
    })),
  };
}

export async function createCatAction(
  context: WorkspaceContext,
  input: { name: unknown; status?: unknown; contractCycleHandle?: unknown },
  dependencies: CatActionManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const id = (dependencies.uuid ?? randomUUID)();
  const name = normalizeText(input.name, "CAT action name", MAX_ACTION_NAME);
  const status = input.status === undefined ? "draft" : normalizeActionStatus(input.status, false);
  const cycleId = input.contractCycleHandle === undefined || input.contractCycleHandle === null || input.contractCycleHandle === ""
    ? null
    : await resolveCycle(context, input.contractCycleHandle, query);

  const insertStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, inserted AS (
        INSERT INTO local801.cat_actions
          (id, organization_id, contract_cycle_id, name, status, created_by)
        SELECT $2::uuid, $1::uuid, $5::uuid, $6::text, $7::text, actor.id
        FROM actor
        WHERE $5::uuid IS NULL OR EXISTS (
          SELECT 1 FROM local801.contract_cycles cycle
          WHERE cycle.id = $5::uuid AND cycle.organization_id = $1::uuid
        )
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS action_created
      FROM inserted
    `,
    parameters: [context.organizationId, id, context.userId, context.role, cycleId, name, status],
  };
  const audit = await prepareAudit({
    eventType: "record.create",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "cat_action",
    subjectId: id,
    payload: { status, contractCycleSelected: Boolean(cycleId) },
  }, query);
  await runTransaction([insertStatement, audit]);
  return { created: true, handle: opaqueHandle("cat-action", context.organizationId, id) };
}

export async function updateCatAction(
  context: WorkspaceContext,
  input: { actionHandle: unknown; name?: unknown; status?: unknown; contractCycleHandle?: unknown },
  dependencies: CatActionManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const action = await resolveAction(context, input.actionHandle, query);
  const hasName = Object.prototype.hasOwnProperty.call(input, "name");
  const hasStatus = Object.prototype.hasOwnProperty.call(input, "status");
  const hasCycle = Object.prototype.hasOwnProperty.call(input, "contractCycleHandle");
  if (!hasName && !hasStatus && !hasCycle) {
    throw new CatActionMutationError("NO_CHANGES", "Choose an action field to update.", 400);
  }

  const name = hasName ? normalizeText(input.name, "CAT action name", MAX_ACTION_NAME) : action.name;
  const status = hasStatus ? normalizeActionStatus(input.status) : action.status;
  const cycleId = hasCycle
    ? input.contractCycleHandle === null || input.contractCycleHandle === ""
      ? null
      : await resolveCycle(context, input.contractCycleHandle, query)
    : action.contract_cycle_id;
  const nameChanged = name !== action.name;
  const statusChanged = status !== action.status;
  const cycleChanged = cycleId !== action.contract_cycle_id;
  if (!nameChanged && !statusChanged && !cycleChanged) {
    throw new CatActionMutationError("NO_CHANGES", "The CAT action already has those settings.", 400);
  }

  const updateStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, updated AS (
        UPDATE local801.cat_actions action
        SET
          name = CASE WHEN $8::boolean THEN $5::text ELSE action.name END,
          status = CASE WHEN $9::boolean THEN $6::text ELSE action.status END,
          contract_cycle_id = CASE WHEN $10::boolean THEN $7::uuid ELSE action.contract_cycle_id END
        FROM actor
        WHERE action.id = $2::uuid
          AND action.organization_id = $1::uuid
          AND action.archived_at IS NULL
          AND action.status <> 'archived'
          AND (NOT $10::boolean OR $7::uuid IS NULL OR EXISTS (
            SELECT 1 FROM local801.contract_cycles cycle
            WHERE cycle.id = $7::uuid AND cycle.organization_id = $1::uuid
          ))
        RETURNING action.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS action_updated
      FROM updated
    `,
    parameters: [
      context.organizationId,
      action.id,
      context.userId,
      context.role,
      name,
      status,
      cycleId,
      nameChanged,
      statusChanged,
      cycleChanged,
    ],
  };
  const audit = await prepareAudit({
    eventType: "record.update",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "cat_action",
    subjectId: action.id,
    payload: { nameChanged, statusChanged, contractCycleChanged: cycleChanged, status: statusChanged ? status : null },
  }, query);
  await runTransaction([updateStatement, audit]);
  return { updated: true };
}

export async function deleteCatAction(
  context: WorkspaceContext,
  actionHandle: unknown,
  dependencies: CatActionManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const action = await resolveAction(context, actionHandle, query);
  const archiveStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, updated AS (
        UPDATE local801.cat_actions action
        SET status = 'archived', archived_at = now()
        FROM actor
        WHERE action.id = $2::uuid
          AND action.organization_id = $1::uuid
          AND action.archived_at IS NULL
          AND action.status IN ('draft','active','closed')
        RETURNING action.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS action_archived
      FROM updated
    `,
    parameters: [context.organizationId, action.id, context.userId, context.role],
  };
  const audit = await prepareAudit({
    eventType: "record.archive",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "cat_action",
    subjectId: action.id,
    payload: { previousStatus: action.status },
  }, query);
  await runTransaction([archiveStatement, audit]);
  return { deleted: true };
}

export async function createCatActionTask(
  context: WorkspaceContext,
  input: { actionHandle: unknown; title: unknown; assigneeHandle?: unknown; dueAt?: unknown },
  dependencies: CatActionManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const now = (dependencies.now ?? (() => new Date()))();
  const id = (dependencies.uuid ?? randomUUID)();
  const action = await resolveAction(context, input.actionHandle, query);
  if (action.status === "closed") {
    throw new CatActionMutationError("ACTION_CLOSED", "Closed CAT actions do not accept new tasks.", 409);
  }
  const title = normalizeText(input.title, "CAT task title", MAX_TASK_TITLE);
  const assigneeId = input.assigneeHandle === undefined || input.assigneeHandle === null || input.assigneeHandle === ""
    ? null
    : await resolveAssignee(context, input.assigneeHandle, query);
  const dueAt = input.dueAt === undefined ? null : normalizeDueAt(input.dueAt, now, true);

  const insertStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, inserted AS (
        INSERT INTO local801.cat_action_tasks
          (id, organization_id, cat_action_id, assigned_to, title, status, due_at)
        SELECT $5::uuid, $1::uuid, action.id, $6::uuid, $7::text, 'open', $8::timestamptz
        FROM actor
        JOIN local801.cat_actions action
          ON action.id = $2::uuid
         AND action.organization_id = $1::uuid
         AND action.archived_at IS NULL
         AND action.status IN ('draft','active')
        WHERE $6::uuid IS NULL OR EXISTS (
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
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS task_created
      FROM inserted
    `,
    parameters: [context.organizationId, action.id, context.userId, context.role, id, assigneeId, title, dueAt],
  };
  const audit = await prepareAudit({
    eventType: "record.create",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "cat_action_task",
    subjectId: id,
    payload: { assigned: Boolean(assigneeId), dueAtSet: Boolean(dueAt) },
  }, query);
  await runTransaction([insertStatement, audit]);
  return { created: true, handle: opaqueHandle("cat-action-task", context.organizationId, id) };
}

export async function updateCatActionTask(
  context: WorkspaceContext,
  input: {
    actionHandle: unknown;
    taskHandle: unknown;
    title?: unknown;
    status?: unknown;
    assigneeHandle?: unknown;
    dueAt?: unknown;
  },
  dependencies: CatActionManagementDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const now = (dependencies.now ?? (() => new Date()))();
  const task = await resolveTask(context, input.actionHandle, input.taskHandle, query);
  if (task.action_status === "closed") {
    throw new CatActionMutationError("ACTION_CLOSED", "Tasks in a closed CAT action are read-only.", 409);
  }

  const hasTitle = Object.prototype.hasOwnProperty.call(input, "title");
  const hasStatus = Object.prototype.hasOwnProperty.call(input, "status");
  const hasAssignee = Object.prototype.hasOwnProperty.call(input, "assigneeHandle");
  const hasDueAt = Object.prototype.hasOwnProperty.call(input, "dueAt");
  if (!hasTitle && !hasStatus && !hasAssignee && !hasDueAt) {
    throw new CatActionMutationError("NO_CHANGES", "Choose a CAT task field to update.", 400);
  }

  const title = hasTitle ? normalizeText(input.title, "CAT task title", MAX_TASK_TITLE) : task.title;
  const status = hasStatus ? normalizeTaskStatus(input.status) : task.status;
  const assigneeId = hasAssignee
    ? input.assigneeHandle === null || input.assigneeHandle === ""
      ? null
      : await resolveAssignee(context, input.assigneeHandle, query)
    : task.assigned_to;
  const dueAt = hasDueAt ? normalizeDueAt(input.dueAt, now, status === "open") : task.due_at === null ? null : new Date(task.due_at).toISOString();

  const titleChanged = title !== task.title;
  const statusChanged = status !== task.status;
  const assigneeChanged = assigneeId !== task.assigned_to;
  const dueAtChanged = !sameTimestamp(task.due_at, dueAt);
  if (!titleChanged && !statusChanged && !assigneeChanged && !dueAtChanged) {
    throw new CatActionMutationError("NO_CHANGES", "The CAT task already has those settings.", 400);
  }

  const updateStatement: DatabaseStatement = {
    sql: `
      WITH ${actorCte()}, updated AS (
        UPDATE local801.cat_action_tasks task
        SET
          title = CASE WHEN $9::boolean THEN $5::text ELSE task.title END,
          status = CASE WHEN $10::boolean THEN $6::text ELSE task.status END,
          assigned_to = CASE WHEN $11::boolean THEN $7::uuid ELSE task.assigned_to END,
          due_at = CASE WHEN $12::boolean THEN $8::timestamptz ELSE task.due_at END
        FROM actor
        WHERE task.id = $2::uuid
          AND task.organization_id = $1::uuid
          AND EXISTS (
            SELECT 1
            FROM local801.cat_actions action
            WHERE action.id = task.cat_action_id
              AND action.id = $13::uuid
              AND action.organization_id = $1::uuid
              AND action.archived_at IS NULL
              AND action.status IN ('draft','active')
          )
          AND (NOT $11::boolean OR $7::uuid IS NULL OR EXISTS (
            SELECT 1
            FROM local801.users candidate
            WHERE candidate.id = $7::uuid
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
        RETURNING task.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS task_updated
      FROM updated
    `,
    parameters: [
      context.organizationId,
      task.id,
      context.userId,
      context.role,
      title,
      status,
      assigneeId,
      dueAt,
      titleChanged,
      statusChanged,
      assigneeChanged,
      dueAtChanged,
      task.action_id,
    ],
  };
  const audit = await prepareAudit({
    eventType: "record.update",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "cat_action_task",
    subjectId: task.id,
    payload: {
      titleChanged,
      statusChanged,
      status: statusChanged ? status : null,
      reassigned: assigneeChanged,
      dueAtChanged,
      dueAtSet: dueAtChanged ? Boolean(dueAt) : null,
    },
  }, query);
  await runTransaction([updateStatement, audit]);
  return { updated: true };
}

export const __testing = {
  assigneeRoles,
  managementRoles,
  normalizeActionStatus,
  normalizeDueAt,
  normalizeTaskStatus,
  normalizeText,
  opaqueHandle,
  requireHandle,
  sameTimestamp,
};
