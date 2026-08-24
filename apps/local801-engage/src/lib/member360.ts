import "server-only";

import { can, type Role } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "cat_admin"]);

export type Member360Campaign = {
  handle: string;
  name: string;
  status: string;
  assignmentStatus: string | null;
  assignmentDueAt: string | null;
};

export type Member360ScopedReadiness = {
  scope: "campaign" | "cat_action";
  parentHandle: string | null;
  parentName: string;
  parentStatus: string;
  actionLabel: string;
  response: "willing" | "considering" | "declined" | "completed";
  updatedAt: string;
};

export type Member360ConnectedContext = {
  campaigns: Member360Campaign[];
  scopedReadiness: Member360ScopedReadiness[];
};

type PersonRow = { person_id: string };
type CampaignRow = {
  campaign_handle: string;
  name: string;
  status: string;
  assignment_status: string | null;
  assignment_due_at: string | Date | null;
};
type ReadinessRow = {
  scope: "campaign" | "cat_action";
  parent_handle: string | null;
  parent_name: string | null;
  parent_status: string | null;
  action_label: string;
  response_status: Member360ScopedReadiness["response"];
  recorded_at: string | Date;
};

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireHandle(value: unknown) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) throw new Error("Employee workspace is not available.");
  return value.toLowerCase();
}

export async function getMember360ConnectedContext(
  context: WorkspaceContext,
  handleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<Member360ConnectedContext> {
  if (!can(context.role, "recordEngagement")) throw new Error("Member outreach access is not authorized.");
  const handle = requireHandle(handleInput);
  const organizationWide = organizationWideRoles.has(context.role);

  const [person] = await query<PersonRow>(`
    /* member360:person-scope */
    SELECT person.id AS person_id
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
  `, [context.organizationId, context.userId, handle, organizationWide]);

  if (!person) throw new Error("Employee workspace is not available.");

  const [campaignRows, readinessRows] = await Promise.all([
    query<CampaignRow>(`
      /* member360:campaign-history */
      SELECT
        encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle,
        campaign.name,
        campaign.status,
        assignment.status AS assignment_status,
        assignment.due_at AS assignment_due_at
      FROM local801.outreach_campaigns campaign
      LEFT JOIN LATERAL (
        SELECT item.status, item.due_at
        FROM local801.engagement_assignments item
        WHERE item.organization_id = $1::uuid
          AND item.campaign_id = campaign.id
          AND item.person_id = $2::uuid
        ORDER BY item.created_at DESC, item.id DESC
        LIMIT 1
      ) assignment ON true
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status <> 'archived'
        AND (
          EXISTS (
            SELECT 1 FROM local801.outreach_campaign_population population
            WHERE population.organization_id = $1::uuid
              AND population.campaign_id = campaign.id
              AND population.person_id = $2::uuid
          )
          OR assignment.status IS NOT NULL
        )
      ORDER BY CASE campaign.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END,
        campaign.name ASC
      LIMIT 50
    `, [context.organizationId, person.person_id]),
    query<ReadinessRow>(`
      /* member360:scoped-readiness */
      SELECT
        action.scope_type AS scope,
        CASE action.scope_type
          WHEN 'campaign' THEN encode(public.digest('campaign:' || action.organization_id::text || ':' || action.campaign_id::text, 'sha256'), 'hex')
          WHEN 'cat_action' THEN encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.cat_action_id::text, 'sha256'), 'hex')
          ELSE NULL
        END AS parent_handle,
        CASE action.scope_type WHEN 'campaign' THEN campaign.name WHEN 'cat_action' THEN cat_action.name ELSE NULL END AS parent_name,
        CASE action.scope_type WHEN 'campaign' THEN campaign.status WHEN 'cat_action' THEN cat_action.status ELSE NULL END AS parent_status,
        action.name AS action_label,
        current.response_status,
        current.recorded_at
      FROM reporting.employee_action_current_responses current
      JOIN local801.employee_actions action
        ON action.organization_id = current.organization_id
       AND action.id = current.action_id
       AND action.archived_at IS NULL
      LEFT JOIN local801.outreach_campaigns campaign
        ON campaign.organization_id = action.organization_id
       AND campaign.id = action.campaign_id
       AND campaign.archived_at IS NULL
      LEFT JOIN local801.cat_actions cat_action
        ON cat_action.organization_id = action.organization_id
       AND cat_action.id = action.cat_action_id
       AND cat_action.archived_at IS NULL
      WHERE current.organization_id = $1::uuid
        AND current.person_id = $2::uuid
        AND action.scope_type IN ('campaign','cat_action')
      ORDER BY current.recorded_at DESC, action.name ASC
      LIMIT 100
    `, [context.organizationId, person.person_id]),
  ]);

  return {
    campaigns: campaignRows.map((row) => ({
      handle: row.campaign_handle,
      name: row.name,
      status: row.status,
      assignmentStatus: row.assignment_status,
      assignmentDueAt: timestamp(row.assignment_due_at),
    })),
    scopedReadiness: readinessRows
      .filter((row) => row.parent_name && row.parent_status)
      .map((row) => ({
        scope: row.scope,
        parentHandle: row.parent_handle,
        parentName: row.parent_name!,
        parentStatus: row.parent_status!,
        actionLabel: row.action_label,
        response: row.response_status,
        updatedAt: timestamp(row.recorded_at)!,
      })),
  };
}
