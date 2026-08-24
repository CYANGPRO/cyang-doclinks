import "server-only";

import { can, type Role } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "cat_admin"]);
const MAX_LIFECYCLE_EVENTS = 50;

export type PersonLifecycleEvent = {
  kind: "membership" | "employment";
  eventType: string;
  effectiveDate: string;
  department: string | null;
  workLocation: string | null;
};

type LifecycleRow = {
  kind: "membership" | "employment";
  event_type: string;
  effective_date: string | Date;
  department: string | null;
  work_location: string | null;
};

function normalizeHandle(value: unknown) {
  if (typeof value !== "string") throw new Error("Employee lifecycle is not available.");
  const handle = value.trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) throw new Error("Employee lifecycle is not available.");
  return handle;
}

function dateOnly(value: string | Date) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? value.slice(0, 10);
}

export async function getPersonLifecycle(
  context: WorkspaceContext,
  personHandleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<PersonLifecycleEvent[]> {
  if (!can(context.role, "recordEngagement")) throw new Error("Employee lifecycle is not authorized.");
  const personHandle = normalizeHandle(personHandleInput);
  const organizationWide = organizationWideRoles.has(context.role);

  const rows = await query<LifecycleRow>(`
    /* person-lifecycle:authorized-timeline */
    WITH authorized_person AS (
      SELECT person.id
      FROM local801.people person
      WHERE person.organization_id = $1::uuid
        AND person.archived_at IS NULL
        AND encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
        AND (
          $4::boolean
          OR EXISTS (
            SELECT 1
            FROM local801.engagement_assignments assignment
            WHERE assignment.organization_id = $1::uuid
              AND assignment.person_id = person.id
              AND assignment.archived_at IS NULL
              AND assignment.status = 'open'
              AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
          )
        )
      LIMIT 1
    ), lifecycle AS (
      SELECT
        'membership'::text AS kind,
        membership.event_type,
        membership.effective_date,
        NULL::text AS department,
        NULL::text AS work_location,
        membership.created_at
      FROM local801.membership_events membership
      JOIN authorized_person person ON person.id = membership.person_id
      WHERE membership.organization_id = $1::uuid
      UNION ALL
      SELECT
        'employment'::text AS kind,
        employment.event_type,
        employment.effective_date,
        employment.department,
        employment.work_location,
        employment.created_at
      FROM local801.employment_events employment
      JOIN authorized_person person ON person.id = employment.person_id
      WHERE employment.organization_id = $1::uuid
    )
    SELECT kind, event_type, effective_date, department, work_location
    FROM lifecycle
    ORDER BY effective_date DESC, created_at DESC, kind ASC, event_type ASC
    LIMIT ${MAX_LIFECYCLE_EVENTS}
  `, [context.organizationId, context.userId, personHandle, organizationWide]);

  return rows.map((row) => ({
    kind: row.kind,
    eventType: row.event_type,
    effectiveDate: dateOnly(row.effective_date),
    department: row.department,
    workLocation: row.work_location,
  }));
}
