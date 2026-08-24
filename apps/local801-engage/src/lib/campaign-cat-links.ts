import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;

export type CampaignCatLink = {
  handle: string;
  campaignHandle: string;
  campaignName: string;
  actionHandle: string;
  actionName: string;
  actionStatus: string;
  createdAt: string;
};

export class CampaignCatLinkError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CampaignCatLinkError";
    this.code = code;
    this.status = status;
  }
}

type Dependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
};

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCampaigns") || !can(context.role, "manageCatActions")) {
    throw new CampaignCatLinkError("FORBIDDEN", "Campaign and CAT Action linking is not authorized.", 403);
  }
}

function handle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new CampaignCatLinkError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

export async function listCampaignCatLinks(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<CampaignCatLink[]> {
  requireAccess(context);
  const campaignHandle = handle(campaignHandleInput, "Campaign");
  const rows = await query<{
    handle: string; campaign_handle: string; campaign_name: string; action_handle: string;
    action_name: string; action_status: string; created_at: string | Date;
  }>(`
    /* campaign-cat-links:list */
    SELECT
      encode(public.digest('campaign-cat-link:' || link.organization_id::text || ':' || link.id::text, 'sha256'), 'hex') AS handle,
      encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle,
      campaign.name AS campaign_name,
      encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') AS action_handle,
      action.name AS action_name, action.status AS action_status, link.created_at
    FROM local801.campaign_cat_action_links link
    JOIN local801.outreach_campaigns campaign
      ON campaign.organization_id = link.organization_id AND campaign.id = link.campaign_id
    JOIN local801.cat_actions action
      ON action.organization_id = link.organization_id AND action.id = link.cat_action_id
    WHERE link.organization_id = $1::uuid AND link.archived_at IS NULL
      AND campaign.archived_at IS NULL AND action.archived_at IS NULL
      AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
    ORDER BY link.created_at DESC, link.id DESC
    LIMIT 100
  `, [context.organizationId, campaignHandle]);
  return rows.map((row) => ({
    handle: row.handle,
    campaignHandle: row.campaign_handle,
    campaignName: row.campaign_name,
    actionHandle: row.action_handle,
    actionName: row.action_name,
    actionStatus: row.action_status,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function listCatActionCampaignLinks(
  context: WorkspaceContext,
  actionHandleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<CampaignCatLink[]> {
  requireAccess(context);
  const actionHandle = handle(actionHandleInput, "CAT Action");
  const rows = await query<{
    handle: string; campaign_handle: string; campaign_name: string; action_handle: string;
    action_name: string; action_status: string; created_at: string | Date;
  }>(`
    /* campaign-cat-links:list-by-action */
    SELECT encode(public.digest('campaign-cat-link:' || link.organization_id::text || ':' || link.id::text, 'sha256'), 'hex') AS handle,
      encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle,
      campaign.name AS campaign_name,
      encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') AS action_handle,
      action.name AS action_name, action.status AS action_status, link.created_at
    FROM local801.campaign_cat_action_links link
    JOIN local801.outreach_campaigns campaign ON campaign.organization_id = link.organization_id AND campaign.id = link.campaign_id
    JOIN local801.cat_actions action ON action.organization_id = link.organization_id AND action.id = link.cat_action_id
    WHERE link.organization_id = $1::uuid AND link.archived_at IS NULL
      AND campaign.archived_at IS NULL AND action.archived_at IS NULL
      AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $2::text
    ORDER BY link.created_at DESC, link.id DESC LIMIT 100
  `, [context.organizationId, actionHandle]);
  return rows.map((row) => ({ handle: row.handle, campaignHandle: row.campaign_handle,
    campaignName: row.campaign_name, actionHandle: row.action_handle, actionName: row.action_name,
    actionStatus: row.action_status, createdAt: new Date(row.created_at).toISOString() }));
}

export async function linkCampaignToCatAction(
  context: WorkspaceContext,
  input: { campaignHandle: unknown; actionHandle: unknown },
  dependencies: Dependencies = {},
) {
  requireAccess(context);
  const campaignHandle = handle(input.campaignHandle, "Campaign");
  const actionHandle = handle(input.actionHandle, "CAT Action");
  const query = dependencies.query ?? queryLocal801;
  const [targets] = await query<{ campaign_id: string; action_id: string }>(`
    /* campaign-cat-links:resolve-targets */
    SELECT campaign.id AS campaign_id, action.id AS action_id
    FROM local801.outreach_campaigns campaign
    CROSS JOIN local801.cat_actions action
    WHERE campaign.organization_id = $1::uuid AND action.organization_id = $1::uuid
      AND campaign.archived_at IS NULL AND campaign.status <> 'archived'
      AND action.archived_at IS NULL AND action.status <> 'archived'
      AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, campaignHandle, actionHandle]);
  if (!targets) throw new CampaignCatLinkError("TARGET_NOT_FOUND", "The campaign or CAT Action is no longer available.", 409);

  const mutation: DatabaseStatement = {
    sql: `
      /* campaign-cat-links:create */
      WITH actor AS (
        SELECT app_user.id FROM local801.users app_user
        WHERE app_user.organization_id = $1::uuid AND app_user.id = $4::uuid
          AND app_user.deactivated_at IS NULL
          AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = app_user.id AND role.code IN ('system_owner','local_admin','cat_admin'))
      ), restored AS (
        UPDATE local801.campaign_cat_action_links link
        SET archived_at = NULL, created_by = $4::uuid, created_at = now()
        FROM actor
        WHERE link.organization_id = $1::uuid AND link.campaign_id = $2::uuid
          AND link.cat_action_id = $3::uuid AND link.archived_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM local801.outreach_campaigns campaign WHERE campaign.organization_id = $1::uuid AND campaign.id = $2::uuid AND campaign.archived_at IS NULL AND campaign.status <> 'archived')
          AND EXISTS (SELECT 1 FROM local801.cat_actions action WHERE action.organization_id = $1::uuid AND action.id = $3::uuid AND action.archived_at IS NULL AND action.status <> 'archived')
        RETURNING link.id
      ), inserted AS (
        INSERT INTO local801.campaign_cat_action_links
          (organization_id, campaign_id, cat_action_id, created_by)
        SELECT $1::uuid, campaign.id, action.id, actor.id FROM actor
        JOIN local801.outreach_campaigns campaign ON campaign.organization_id = $1::uuid AND campaign.id = $2::uuid AND campaign.archived_at IS NULL AND campaign.status <> 'archived'
        JOIN local801.cat_actions action ON action.organization_id = $1::uuid AND action.id = $3::uuid AND action.archived_at IS NULL AND action.status <> 'archived'
        WHERE NOT EXISTS (SELECT 1 FROM restored)
          AND NOT EXISTS (
            SELECT 1 FROM local801.campaign_cat_action_links current_link
            WHERE current_link.organization_id = $1::uuid AND current_link.campaign_id = $2::uuid
              AND current_link.cat_action_id = $3::uuid AND current_link.archived_at IS NULL
          )
        RETURNING id
      )
      SELECT 1 / CASE WHEN (SELECT count(*) FROM restored) + (SELECT count(*) FROM inserted) = 1
        THEN 1 ELSE 0 END = 1 AS linked
    `,
    parameters: [context.organizationId, targets.campaign_id, targets.action_id, context.userId],
  };
  const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({
    eventType: "record.create", organizationId: context.organizationId, actorId: context.userId,
    subjectType: "campaign_cat_action_link", subjectId: targets.campaign_id,
    payload: { catActionId: targets.action_id },
  }, query);
  await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  return { linked: true } as const;
}

export async function unlinkCampaignCatAction(
  context: WorkspaceContext,
  linkHandleInput: unknown,
  dependencies: Dependencies = {},
) {
  requireAccess(context);
  const linkHandle = handle(linkHandleInput, "Campaign/CAT Action relationship");
  const query = dependencies.query ?? queryLocal801;
  const [link] = await query<{ id: string; campaign_id: string; cat_action_id: string }>(`
    SELECT id, campaign_id, cat_action_id FROM local801.campaign_cat_action_links
    WHERE organization_id = $1::uuid AND archived_at IS NULL
      AND encode(public.digest('campaign-cat-link:' || organization_id::text || ':' || id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, linkHandle]);
  if (!link) throw new CampaignCatLinkError("LINK_NOT_FOUND", "The relationship is no longer current.", 409);
  const mutation: DatabaseStatement = {
    sql: `
      WITH archived AS (
        UPDATE local801.campaign_cat_action_links link SET archived_at = now()
        WHERE link.organization_id = $1::uuid AND link.id = $2::uuid AND link.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM local801.users actor WHERE actor.organization_id = $1::uuid
            AND actor.id = $3::uuid AND actor.deactivated_at IS NULL
            AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = actor.id AND role.code IN ('system_owner','local_admin','cat_admin')))
        RETURNING id
      ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM archived
    `,
    parameters: [context.organizationId, link.id, context.userId],
  };
  const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({
    eventType: "record.archive", organizationId: context.organizationId, actorId: context.userId,
    subjectType: "campaign_cat_action_link", subjectId: link.id,
    payload: { campaignId: link.campaign_id, catActionId: link.cat_action_id },
  }, query);
  await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  return { unlinked: true } as const;
}
