import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const MAX_DEFINITIONS = 100;

export type ScopedActionReadinessItem = {
  label: string;
  engagementLevel: number;
  willing: number;
  considering: number;
  declined: number;
  completed: number;
};

export type ScopedActionReadinessSummary = {
  actionCount: number;
  willing: number;
  considering: number;
  declined: number;
  completed: number;
  actions: ScopedActionReadinessItem[];
};

type ReadinessRow = {
  name: string;
  engagement_level: unknown;
  willing_count: unknown;
  considering_count: unknown;
  declined_count: unknown;
  completed_count: unknown;
};

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function level(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : 1;
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) throw new Error(`${label} is not available.`);
  return value.toLowerCase();
}

function summarize(rows: ReadinessRow[]): ScopedActionReadinessSummary {
  const actions = rows.slice(0, MAX_DEFINITIONS).map((row) => ({
    label: row.name,
    engagementLevel: level(row.engagement_level),
    willing: count(row.willing_count),
    considering: count(row.considering_count),
    declined: count(row.declined_count),
    completed: count(row.completed_count),
  }));

  return {
    actionCount: actions.length,
    willing: actions.reduce((total, action) => total + action.willing, 0),
    considering: actions.reduce((total, action) => total + action.considering, 0),
    declined: actions.reduce((total, action) => total + action.declined, 0),
    completed: actions.reduce((total, action) => total + action.completed, 0),
    actions,
  };
}

export async function getCampaignActionReadiness(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<ScopedActionReadinessSummary> {
  if (!can(context.role, "manageCampaigns")) throw new Error("Campaign Action Readiness is not authorized.");
  const campaignHandle = requireHandle(campaignHandleInput, "Campaign");
  const rows = await query<ReadinessRow>(`
    /* action-readiness:campaign-summary */
    SELECT
      readiness.name,
      readiness.engagement_level,
      readiness.willing_count,
      readiness.considering_count,
      readiness.declined_count,
      readiness.completed_count
    FROM reporting.employee_action_readiness_by_action readiness
    JOIN local801.outreach_campaigns campaign
      ON campaign.organization_id = readiness.organization_id
     AND campaign.id = readiness.campaign_id
    WHERE readiness.organization_id = $1::uuid
      AND readiness.scope_type = 'campaign'
      AND campaign.archived_at IS NULL
      AND campaign.status <> 'archived'
      AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
    ORDER BY readiness.engagement_level ASC, readiness.name ASC
    LIMIT ${MAX_DEFINITIONS}
  `, [context.organizationId, campaignHandle]);
  return summarize(rows);
}

export async function getCatActionReadiness(
  context: WorkspaceContext,
  catActionHandleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<ScopedActionReadinessSummary> {
  if (!can(context.role, "manageCatActions")) throw new Error("CAT Action Readiness is not authorized.");
  const catActionHandle = requireHandle(catActionHandleInput, "CAT action");
  const rows = await query<ReadinessRow>(`
    /* action-readiness:cat-action-summary */
    SELECT
      readiness.name,
      readiness.engagement_level,
      readiness.willing_count,
      readiness.considering_count,
      readiness.declined_count,
      readiness.completed_count
    FROM reporting.employee_action_readiness_by_action readiness
    JOIN local801.cat_actions action
      ON action.organization_id = readiness.organization_id
     AND action.id = readiness.cat_action_id
    WHERE readiness.organization_id = $1::uuid
      AND readiness.scope_type = 'cat_action'
      AND action.archived_at IS NULL
      AND action.status <> 'archived'
      AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $2::text
    ORDER BY readiness.engagement_level ASC, readiness.name ASC
    LIMIT ${MAX_DEFINITIONS}
  `, [context.organizationId, catActionHandle]);
  return summarize(rows);
}

export const __testing = { count, level, summarize };
