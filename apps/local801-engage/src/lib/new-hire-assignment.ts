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
import type { EngagementAssigneeOption } from "./engagement-recording.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;

export type NewHireAssignmentDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
  uuid?: () => string;
};

export class NewHireAssignmentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "NewHireAssignmentError";
    this.code = code;
    this.status = status;
  }
}

type IdRow = { id: string };
type AssigneeRow = { id: string; display_name: string };

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "assignNewHires")) {
    throw new NewHireAssignmentError("FORBIDDEN", "New-hire assignment is not authorized.", 403);
  }
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new NewHireAssignmentError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

function userHandle(organizationId: string, userId: string) {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

async function resolveNewHirePerson(context: WorkspaceContext, handleInput: unknown, query: DatabaseQuery) {
  const handle = requireHandle(handleInput, "Employee");
  const [row] = await query<IdRow>(`
    /* new-hire-assignment:resolve-person */
    SELECT person.id
    FROM local801.people person
    WHERE person.organization_id = $1::uuid
      AND person.archived_at IS NULL
      AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $2::text
      AND EXISTS (
        SELECT 1
        FROM reporting.new_hires hire
        WHERE hire.organization_id = $1::uuid
          AND hire.person_id = person.id
      )
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row?.id) throw new NewHireAssignmentError("NOT_FOUND", "This new hire is no longer available.", 404);
  return { id: row.id, handle };
}

async function resolveCatAssignee(context: WorkspaceContext, handleInput: unknown, query: DatabaseQuery) {
  const handle = requireHandle(handleInput, "CAT member");
  const [row] = await query<AssigneeRow>(`
    /* new-hire-assignment:resolve-assignee */
    SELECT DISTINCT app_user.id, app_user.display_name
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
     AND role.organization_id = $1::uuid
    WHERE app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND role.code IN ('cat_admin','cat_lead','cat_member')
      AND encode(public.digest('user:' || $1::text || ':' || app_user.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row?.id) throw new NewHireAssignmentError("INVALID_ASSIGNEE", "The selected CAT member is not available.", 400);
  return { ...row, handle };
}

export async function getNewHireAssignmentOptions(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<EngagementAssigneeOption[]> {
  requireAccess(context);
  const rows = await query<AssigneeRow>(`
    /* new-hire-assignment:assignee-options */
    SELECT DISTINCT app_user.id, app_user.display_name
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
     AND role.organization_id = $1::uuid
    WHERE app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND role.code IN ('cat_admin','cat_lead','cat_member')
    ORDER BY app_user.display_name ASC, app_user.id ASC
    LIMIT 100
  `, [context.organizationId]);
  return rows.map((row) => ({
    handle: userHandle(context.organizationId, row.id),
    label: row.display_name,
    current: row.id === context.userId,
  }));
}

export async function assignNewHireOrganizer(
  context: WorkspaceContext,
  input: { personHandle: unknown; assigneeHandle: unknown },
  dependencies: NewHireAssignmentDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const assignmentId = (dependencies.uuid ?? randomUUID)();

  const person = await resolveNewHirePerson(context, input.personHandle, query);
  await resolveCatAssignee(context, input.assigneeHandle, query);
  const assigneeHandle = requireHandle(input.assigneeHandle, "CAT member");
  const [existing] = await query<IdRow>(`
    /* new-hire-assignment:existing-open */
    SELECT assignment.id
    FROM local801.engagement_assignments assignment
    WHERE assignment.organization_id = $1::uuid
      AND assignment.person_id = $2::uuid
      AND assignment.archived_at IS NULL
      AND assignment.status = 'open'
    ORDER BY assignment.created_at, assignment.id
    LIMIT 1
  `, [context.organizationId, person.id]);
  if (existing?.id) {
    throw new NewHireAssignmentError("ALREADY_ASSIGNED", "This person already has an open organizer assignment. Refresh the list to see it.", 409);
  }

  const lockStatement: DatabaseStatement = {
    sql: `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
    parameters: [context.organizationId, person.id],
  };
  const insertStatement: DatabaseStatement = {
    sql: `
      WITH actor AS (
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
              AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead')
          )
      ), person AS (
        SELECT candidate.id
        FROM local801.people candidate
        WHERE candidate.organization_id = $1::uuid
          AND candidate.archived_at IS NULL
          AND encode(public.digest($1::text || ':' || candidate.id::text, 'sha256'), 'hex') = $5::text
          AND EXISTS (
            SELECT 1 FROM reporting.new_hires hire
            WHERE hire.organization_id = $1::uuid
              AND hire.person_id = candidate.id
          )
      ), assignee AS (
        SELECT DISTINCT candidate.id
        FROM local801.users candidate
        JOIN local801.workspace_user_roles user_role ON user_role.user_id = candidate.id
        JOIN local801.workspace_roles role
          ON role.id = user_role.role_id
         AND role.organization_id = $1::uuid
        WHERE candidate.organization_id = $1::uuid
          AND candidate.deactivated_at IS NULL
          AND role.code IN ('cat_admin','cat_lead','cat_member')
          AND encode(public.digest('user:' || $1::text || ':' || candidate.id::text, 'sha256'), 'hex') = $6::text
      ), inserted AS (
        INSERT INTO local801.engagement_assignments
          (id, organization_id, campaign_id, person_id, primary_user_id, backup_user_id, assignment_type, status, created_by)
        SELECT $2::uuid, $1::uuid, NULL, person.id, assignee.id, NULL, 'direct', 'open', actor.id
        FROM actor CROSS JOIN person CROSS JOIN assignee
        WHERE NOT EXISTS (
          SELECT 1
          FROM local801.engagement_assignments current_assignment
          WHERE current_assignment.organization_id = $1::uuid
            AND current_assignment.person_id = person.id
            AND current_assignment.archived_at IS NULL
            AND current_assignment.status = 'open'
        )
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS assignment_created
      FROM inserted
    `,
    parameters: [
      context.organizationId,
      assignmentId,
      context.userId,
      context.role,
      person.handle,
      assigneeHandle,
    ],
  };
  const audit = await prepareAudit({
    eventType: "record.create",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "engagement_assignment",
    subjectId: assignmentId,
    payload: { source: "new_hires", assignmentType: "direct", relationship: "primary" },
  }, query);

  try {
    await runTransaction([lockStatement, insertStatement, audit]);
  } catch {
    throw new NewHireAssignmentError("ASSIGNMENT_UNAVAILABLE", "The assignment could not be saved safely. Refresh the list and try again.", 503);
  }
  return { assigned: true };
}

export const __testing = { requireHandle, userHandle };
