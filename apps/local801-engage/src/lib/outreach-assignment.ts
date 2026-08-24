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

type IdRow = { id: string; primary_user_id?: string };
type AssigneeRow = { id: string; display_name: string };

export type OutreachAssignmentDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
  uuid?: () => string;
};

export class OutreachAssignmentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "OutreachAssignmentError";
    this.code = code;
    this.status = status;
  }
}

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "assignOutreach")) {
    throw new OutreachAssignmentError("FORBIDDEN", "Outreach assignment is not authorized.", 403);
  }
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new OutreachAssignmentError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

function userHandle(organizationId: string, userId: string) {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

async function resolvePerson(context: WorkspaceContext, handleInput: unknown, query: DatabaseQuery) {
  const handle = requireHandle(handleInput, "Member");
  const [row] = await query<IdRow>(`
    /* outreach-assignment:resolve-person */
    SELECT person.id
    FROM local801.people person
    WHERE person.organization_id = $1::uuid
      AND person.archived_at IS NULL
      AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row?.id) throw new OutreachAssignmentError("NOT_FOUND", "This member is no longer available.", 404);
  return { id: row.id, handle };
}

async function resolveAssignee(context: WorkspaceContext, handleInput: unknown, query: DatabaseQuery) {
  const handle = requireHandle(handleInput, "CAT organizer");
  const [row] = await query<AssigneeRow>(`
    /* outreach-assignment:resolve-assignee */
    SELECT DISTINCT app_user.id, app_user.display_name
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id AND role.organization_id = $1::uuid
    WHERE app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND role.code IN ('cat_lead','cat_member')
      AND encode(public.digest('user:' || $1::text || ':' || app_user.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row?.id) throw new OutreachAssignmentError("INVALID_ASSIGNEE", "The selected CAT organizer is not available.", 400);
  return { ...row, handle };
}

export async function getOutreachAssignmentOptions(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<EngagementAssigneeOption[]> {
  requireAccess(context);
  const rows = await query<AssigneeRow>(`
    /* outreach-assignment:assignee-options */
    SELECT DISTINCT app_user.id, app_user.display_name
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id AND role.organization_id = $1::uuid
    WHERE app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND role.code IN ('cat_lead','cat_member')
    ORDER BY app_user.display_name, app_user.id
    LIMIT 100
  `, [context.organizationId]);
  return rows.map((row) => ({
    handle: userHandle(context.organizationId, row.id),
    label: row.display_name,
    current: row.id === context.userId,
  }));
}

export async function assignOutreachOrganizer(
  context: WorkspaceContext,
  input: { personHandle: unknown; assigneeHandle: unknown },
  dependencies: OutreachAssignmentDependencies = {},
) {
  requireAccess(context);
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const assignmentId = (dependencies.uuid ?? randomUUID)();
  const person = await resolvePerson(context, input.personHandle, query);
  const assignee = await resolveAssignee(context, input.assigneeHandle, query);

  const currentRows = await query<IdRow>(`
    /* outreach-assignment:current-direct */
    SELECT assignment.id, assignment.primary_user_id
    FROM local801.engagement_assignments assignment
    WHERE assignment.organization_id = $1::uuid
      AND assignment.person_id = $2::uuid
      AND assignment.campaign_id IS NULL
      AND assignment.assignment_type = 'direct'
      AND assignment.status = 'open'
      AND assignment.archived_at IS NULL
    ORDER BY assignment.created_at, assignment.id
    LIMIT 2
  `, [context.organizationId, person.id]);
  if (currentRows.length > 1) {
    throw new OutreachAssignmentError("ASSIGNMENT_CONFLICT", "More than one direct outreach assignment is active. An administrator must resolve the duplicate before reassigning.", 409);
  }
  const current = currentRows[0];
  if (current?.primary_user_id === assignee.id) return { assigned: true, unchanged: true };

  const lock: DatabaseStatement = {
    sql: `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
    parameters: [context.organizationId, person.id],
  };
  const replace: DatabaseStatement = {
    sql: `
      WITH actor AS MATERIALIZED (
        SELECT app_user.id
        FROM local801.users app_user
        WHERE app_user.organization_id = $1::uuid
          AND app_user.id = $3::uuid
          AND app_user.deactivated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM local801.workspace_user_roles user_role
            JOIN local801.workspace_roles role
              ON role.id = user_role.role_id AND role.organization_id = $1::uuid
            WHERE user_role.user_id = app_user.id
              AND role.code = $4::text
              AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead')
          )
      ), person AS MATERIALIZED (
        SELECT candidate.id
        FROM local801.people candidate
        WHERE candidate.organization_id = $1::uuid
          AND candidate.archived_at IS NULL
          AND encode(public.digest($1::text || ':' || candidate.id::text, 'sha256'), 'hex') = $5::text
      ), assignee AS MATERIALIZED (
        SELECT DISTINCT candidate.id
        FROM local801.users candidate
        JOIN local801.workspace_user_roles user_role ON user_role.user_id = candidate.id
        JOIN local801.workspace_roles role
          ON role.id = user_role.role_id AND role.organization_id = $1::uuid
        WHERE candidate.organization_id = $1::uuid
          AND candidate.deactivated_at IS NULL
          AND role.code IN ('cat_lead','cat_member')
          AND encode(public.digest('user:' || $1::text || ':' || candidate.id::text, 'sha256'), 'hex') = $6::text
      ), current_direct AS MATERIALIZED (
        SELECT assignment.id
        FROM local801.engagement_assignments assignment CROSS JOIN person
        WHERE assignment.organization_id = $1::uuid
          AND assignment.person_id = person.id
          AND assignment.campaign_id IS NULL
          AND assignment.assignment_type = 'direct'
          AND assignment.status = 'open'
          AND assignment.archived_at IS NULL
        ORDER BY assignment.created_at, assignment.id
        LIMIT 2
      ), direct_gate AS MATERIALIZED (
        SELECT count(*) <= 1 AS ok FROM current_direct
      ), archived AS (
        UPDATE local801.engagement_assignments assignment
        SET status = 'closed', archived_at = now()
        FROM current_direct current, direct_gate gate
        WHERE gate.ok AND assignment.id = current.id
        RETURNING assignment.id
      ), inserted AS (
        INSERT INTO local801.engagement_assignments
          (id, organization_id, campaign_id, person_id, primary_user_id, backup_user_id,
           assignment_type, status, created_by)
        SELECT $2::uuid, $1::uuid, NULL, person.id, assignee.id, NULL, 'direct', 'open', actor.id
        FROM actor CROSS JOIN person CROSS JOIN assignee CROSS JOIN direct_gate
        CROSS JOIN (SELECT count(*) FROM archived) archive_barrier
        WHERE direct_gate.ok
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS assignment_created
      FROM inserted
    `,
    parameters: [context.organizationId, assignmentId, context.userId, context.role, person.handle, assignee.handle],
  };
  const audit = await prepareAudit({
    eventType: "record.create",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "engagement_assignment",
    subjectId: assignmentId,
    payload: { source: "member_outreach", assignmentType: "direct", relationship: "primary", replaced: Boolean(current?.id) },
  }, query);

  try {
    await runTransaction([lock, replace, audit]);
  } catch {
    throw new OutreachAssignmentError("ASSIGNMENT_UNAVAILABLE", "The outreach assignment could not be saved safely. Refresh and try again.", 503);
  }
  return { assigned: true, unchanged: false };
}

export const __testing = { requireHandle, userHandle };
