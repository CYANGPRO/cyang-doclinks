import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;

export class EmployeeRecordError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "EmployeeRecordError";
    this.code = code;
    this.status = status;
  }
}

export async function archiveEmployeeRecord(
  context: WorkspaceContext,
  personHandle: unknown,
  dependencies: { query?: DatabaseQuery; runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {},
) {
  if (!can(context.role, "deleteEmployees")) {
    throw new EmployeeRecordError("FORBIDDEN", "Employee deletion is limited to Local Administrators and System Owners.", 403);
  }
  if (typeof personHandle !== "string" || !HANDLE_RE.test(personHandle)) {
    throw new EmployeeRecordError("INVALID_EMPLOYEE", "The employee record is invalid.", 400);
  }
  const query = dependencies.query ?? queryLocal801;
  const [person] = await query<{ id: string }>(`
    SELECT id::text
    FROM local801.people
    WHERE organization_id = $1::uuid AND archived_at IS NULL
      AND encode(public.digest($1::text || ':' || id::text, 'sha256'), 'hex') = $2
    LIMIT 1
  `, [context.organizationId, personHandle.toLowerCase()]);
  if (!person) throw new EmployeeRecordError("NOT_FOUND", "This employee is no longer active.", 404);

  const mutation: DatabaseStatement = {
    sql: `WITH actor AS (
      SELECT app_user.id
      FROM local801.users app_user
      WHERE app_user.organization_id = $1::uuid AND app_user.id = $3::uuid
        AND app_user.deactivated_at IS NULL
        AND EXISTS (
          SELECT 1 FROM local801.workspace_user_roles user_role
          JOIN local801.workspace_roles role
            ON role.id = user_role.role_id AND role.organization_id = $1::uuid
          WHERE user_role.user_id = app_user.id AND role.code IN ('system_owner','local_admin')
        )
    ), archived AS (
      UPDATE local801.people person SET archived_at = now(), updated_at = now()
      FROM actor
      WHERE person.organization_id = $1::uuid AND person.id = $2::uuid AND person.archived_at IS NULL
      RETURNING person.id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM archived`,
    parameters: [context.organizationId, person.id, context.userId],
  };
  const audit = await prepareAtomicAuditStatement({
    eventType: "record.archive",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "employee",
    subjectId: person.id,
    payload: { workflow: "directory_employee_archive", retention: "history_preserved" },
  }, query);
  try {
    await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  } catch {
    throw new EmployeeRecordError("ARCHIVE_FAILED", "The employee could not be removed safely. Refresh and try again.", 503);
  }
  return { archived: true } as const;
}
