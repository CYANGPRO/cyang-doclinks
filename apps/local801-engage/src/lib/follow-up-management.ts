import "server-only";

import { can, type Role } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import {
  queryLocal801,
  runLocal801Transaction,
  type DatabaseQuery,
  type DatabaseStatement,
} from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const MAX_FOLLOWUP_MS = 366 * 24 * 60 * 60 * 1000;
const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "cat_admin"]);

export type FollowupUpdateDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
  now?: () => Date;
};

export class FollowupUpdateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "FollowupUpdateError";
    this.code = code;
    this.status = status;
  }
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new FollowupUpdateError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

function normalizeDueAt(value: unknown, now: Date) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FollowupUpdateError("INVALID_DUE_AT", "A new follow-up due date and time is required.", 400);
  }
  const parsed = new Date(value);
  const timestamp = parsed.getTime();
  if (Number.isNaN(timestamp)) {
    throw new FollowupUpdateError("INVALID_DUE_AT", "The follow-up due date and time is invalid.", 400);
  }
  if (timestamp <= now.getTime()) {
    throw new FollowupUpdateError("INVALID_DUE_AT", "A rescheduled follow-up must be due in the future.", 400);
  }
  if (timestamp > now.getTime() + MAX_FOLLOWUP_MS) {
    throw new FollowupUpdateError("INVALID_DUE_AT", "The follow-up due date is too far in the future.", 400);
  }
  return parsed.toISOString();
}

type FollowupResolution = {
  id: string;
  person_id: string;
  assigned_to: string | null;
  due_at: string | Date;
};

async function resolveOpenFollowup(
  context: WorkspaceContext,
  personHandleInput: unknown,
  followupHandleInput: unknown,
  query: DatabaseQuery,
) {
  if (!can(context.role, "recordEngagement")) {
    throw new FollowupUpdateError("FORBIDDEN", "Follow-up access is not authorized.", 403);
  }
  const personHandle = requireHandle(personHandleInput, "Employee");
  const followupHandle = requireHandle(followupHandleInput, "Follow-up");
  const [row] = await query<FollowupResolution>(`
    /* follow-up-management:resolve-open-followup */
    SELECT item.id, item.person_id, item.assigned_to, item.due_at
    FROM local801.engagement_followups item
    JOIN local801.people person
      ON person.id = item.person_id
     AND person.organization_id = $1::uuid
     AND person.archived_at IS NULL
    WHERE item.organization_id = $1::uuid
      AND item.status = 'open'
      AND item.completed_at IS NULL
      AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
      AND encode(public.digest('followup:' || $1::text || ':' || item.id::text, 'sha256'), 'hex') = $4::text
      AND (
        $5::text IN ('system_owner','local_admin','cat_admin')
        OR (
          item.assigned_to = $2::uuid
          AND EXISTS (
            SELECT 1
            FROM local801.engagement_assignments assignment
            WHERE assignment.organization_id = $1::uuid
              AND assignment.person_id = item.person_id
              AND assignment.archived_at IS NULL
              AND assignment.status = 'open'
              AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
          )
        )
      )
    LIMIT 1
  `, [context.organizationId, context.userId, personHandle, followupHandle, context.role]);

  if (!row) {
    throw new FollowupUpdateError("FOLLOWUP_NOT_FOUND", "The open follow-up is no longer available in your scope.", 409);
  }
  return row;
}

type AssigneeResolution = { id: string; display_name: string };

async function resolveReassignmentTarget(
  context: WorkspaceContext,
  personId: string,
  assigneeHandleInput: unknown,
  query: DatabaseQuery,
) {
  const handle = requireHandle(assigneeHandleInput, "Follow-up assignee");
  const [row] = await query<AssigneeResolution>(`
    /* follow-up-management:resolve-assignee */
    SELECT candidate.id, candidate.display_name
    FROM local801.users candidate
    WHERE candidate.organization_id = $1::uuid
      AND candidate.deactivated_at IS NULL
      AND encode(public.digest('user:' || $1::text || ':' || candidate.id::text, 'sha256'), 'hex') = $3::text
      AND EXISTS (
        SELECT 1
        FROM local801.workspace_user_roles user_role
        JOIN local801.workspace_roles role
          ON role.id = user_role.role_id
         AND role.organization_id = $1::uuid
        WHERE user_role.user_id = candidate.id
          AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
      )
      AND (
        $4::text IN ('system_owner','local_admin','cat_admin')
        OR (
          $4::text = 'cat_lead'
          AND EXISTS (
            SELECT 1
            FROM local801.engagement_assignments assignment
            WHERE assignment.organization_id = $1::uuid
              AND assignment.person_id = $2::uuid
              AND assignment.archived_at IS NULL
              AND assignment.status = 'open'
              AND (assignment.primary_user_id = candidate.id OR assignment.backup_user_id = candidate.id)
          )
        )
        OR ($4::text = 'cat_member' AND candidate.id = $5::uuid)
      )
    LIMIT 1
  `, [context.organizationId, personId, handle, context.role, context.userId]);

  if (!row) {
    throw new FollowupUpdateError("INVALID_ASSIGNEE", "The selected CAT organizer is not available for this employee.", 400);
  }
  return row;
}

function sameTimestamp(left: string | Date, right: string) {
  return new Date(left).getTime() === new Date(right).getTime();
}

export async function updateOutreachFollowup(
  context: WorkspaceContext,
  input: {
    personHandle: unknown;
    followupHandle: unknown;
    dueAt?: unknown;
    assigneeHandle?: unknown;
  },
  dependencies: FollowupUpdateDependencies = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const now = (dependencies.now ?? (() => new Date()))();

  const hasDueAt = Object.prototype.hasOwnProperty.call(input, "dueAt");
  const hasAssignee = Object.prototype.hasOwnProperty.call(input, "assigneeHandle");
  if (!hasDueAt && !hasAssignee) {
    throw new FollowupUpdateError("NO_CHANGES", "Choose a new due date or CAT organizer before saving.", 400);
  }

  const followup = await resolveOpenFollowup(
    context,
    input.personHandle,
    input.followupHandle,
    query,
  );

  const dueAt = hasDueAt ? normalizeDueAt(input.dueAt, now) : null;
  const target = hasAssignee
    ? await resolveReassignmentTarget(context, followup.person_id, input.assigneeHandle, query)
    : null;

  const dueAtChanged = dueAt !== null && !sameTimestamp(followup.due_at, dueAt);
  const assigneeChanged = target !== null && target.id !== followup.assigned_to;

  if (!dueAtChanged && !assigneeChanged) {
    throw new FollowupUpdateError("NO_CHANGES", "The follow-up already has those settings.", 400);
  }

  const updateStatement: DatabaseStatement = {
    sql: `
      /* follow-up-management:update-open-followup */
      WITH actor AS (
        SELECT app_user.id
        FROM local801.users app_user
        WHERE app_user.id = $4::uuid
          AND app_user.organization_id = $1::uuid
          AND app_user.deactivated_at IS NULL
      ),
      target AS (
        SELECT candidate.id
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
          AND (
            $5::text IN ('system_owner','local_admin','cat_admin')
            OR (
              $5::text = 'cat_lead'
              AND EXISTS (
                SELECT 1
                FROM local801.engagement_assignments target_assignment
                WHERE target_assignment.organization_id = $1::uuid
                  AND target_assignment.person_id = $3::uuid
                  AND target_assignment.archived_at IS NULL
                  AND target_assignment.status = 'open'
                  AND (
                    target_assignment.primary_user_id = candidate.id
                    OR target_assignment.backup_user_id = candidate.id
                  )
              )
            )
            OR ($5::text = 'cat_member' AND candidate.id = $4::uuid)
          )
      ),
      updated AS (
        UPDATE local801.engagement_followups item
        SET
          due_at = CASE WHEN $8::boolean THEN $7::timestamptz ELSE item.due_at END,
          assigned_to = CASE WHEN $9::boolean THEN target.id ELSE item.assigned_to END
        FROM actor
        LEFT JOIN target ON true
        WHERE item.id = $2::uuid
          AND item.organization_id = $1::uuid
          AND item.person_id = $3::uuid
          AND item.status = 'open'
          AND item.completed_at IS NULL
          AND (
            $5::text IN ('system_owner','local_admin','cat_admin')
            OR (
              item.assigned_to = actor.id
              AND EXISTS (
                SELECT 1
                FROM local801.engagement_assignments actor_assignment
                WHERE actor_assignment.organization_id = $1::uuid
                  AND actor_assignment.person_id = item.person_id
                  AND actor_assignment.archived_at IS NULL
                  AND actor_assignment.status = 'open'
                  AND (
                    actor_assignment.primary_user_id = actor.id
                    OR actor_assignment.backup_user_id = actor.id
                  )
              )
            )
          )
          AND (NOT $9::boolean OR target.id IS NOT NULL)
        RETURNING item.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS followup_updated
      FROM updated
    `,
    parameters: [
      context.organizationId,
      followup.id,
      followup.person_id,
      context.userId,
      context.role,
      target?.id ?? null,
      dueAt,
      dueAtChanged,
      assigneeChanged,
    ],
  };

  const audit = await prepareAudit({
    eventType: "record.update",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "engagement_followup",
    subjectId: followup.id,
    payload: {
      dueAtChanged,
      dueAt: dueAtChanged ? dueAt : null,
      reassigned: assigneeChanged,
    },
  }, query);

  await runTransaction([updateStatement, audit]);
  return {
    updated: true,
    dueAtChanged,
    reassigned: assigneeChanged,
    assigneeLabel: assigneeChanged ? target?.display_name ?? null : null,
  };
}

export const __testing = {
  normalizeDueAt,
  requireHandle,
  sameTimestamp,
  organizationWideRoles,
};
