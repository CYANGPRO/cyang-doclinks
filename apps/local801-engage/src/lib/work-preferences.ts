import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { can, type Permission, type Role } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import {
  queryLocal801,
  runLocal801Transaction,
  type DatabaseQuery,
  type DatabaseStatement,
} from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const NOTIFICATION_KEY_RE = /^[0-9a-f]{64}$/;
const MAX_SAVED_VIEWS = 20;
const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "cat_admin"]);

export const SAVED_VIEW_DESTINATIONS = [
  "/workload",
  "/follow-ups",
  "/outreach",
  "/new-hires",
  "/imports",
  "/membership/data-quality",
] as const;

export type SavedViewDestination = typeof SAVED_VIEW_DESTINATIONS[number];

export type SavedWorkView = {
  handle: string;
  label: string;
  destination: SavedViewDestination;
  queryParams: Record<string, string>;
  href: string;
  createdAt: string;
};

type SavedViewRow = {
  id: string;
  label: string;
  destination: SavedViewDestination;
  query_params: unknown;
  created_at: string | Date;
};

export class WorkPreferenceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "WorkPreferenceError";
    this.code = code;
    this.status = status;
  }
}

const routePermission: Record<SavedViewDestination, Permission> = {
  "/workload": "recordEngagement",
  "/follow-ups": "recordEngagement",
  "/outreach": "recordEngagement",
  "/new-hires": "manageImports",
  "/imports": "manageImports",
  "/membership/data-quality": "manageImports",
};

function scalar(value: unknown) {
  if (Array.isArray(value)) return scalar(value[0]);
  return typeof value === "string" ? value.trim() : "";
}

function allow(value: unknown, choices: readonly string[], fallback = "") {
  const normalized = scalar(value);
  return choices.includes(normalized) ? normalized : fallback;
}

function cleanRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeDestination(value: unknown): SavedViewDestination {
  const destination = scalar(value);
  if (!(SAVED_VIEW_DESTINATIONS as readonly string[]).includes(destination)) {
    throw new WorkPreferenceError("INVALID_DESTINATION", "That saved-view destination is not supported.");
  }
  return destination as SavedViewDestination;
}

function requireDestinationAccess(role: Role, destination: SavedViewDestination) {
  if (!can(role, routePermission[destination])) {
    throw new WorkPreferenceError("FORBIDDEN", "That saved-view destination is not available for this role.", 403);
  }
}

export function normalizeSavedViewParams(
  role: Role,
  destinationInput: unknown,
  paramsInput: unknown,
): { destination: SavedViewDestination; queryParams: Record<string, string> } {
  const destination = normalizeDestination(destinationInput);
  requireDestinationAccess(role, destination);
  const raw = cleanRecord(paramsInput);
  const queryParams: Record<string, string> = {};

  if (destination === "/workload") {
    const source = allow(raw.source, ["all", "followup", "campaign", "cat_action"], "all");
    const authorizedSource = source === "campaign" && !can(role, "manageCampaigns")
      ? "all"
      : source === "cat_action" && !can(role, "manageCatActions") ? "all" : source;
    const window = allow(raw.window, ["all", "overdue", "today", "next7", "later"], "all");
    if (authorizedSource !== "all") queryParams.source = authorizedSource;
    if (window !== "all") queryParams.window = window;
  } else if (destination === "/follow-ups") {
    const requestedScope = allow(raw.scope, ["mine", "authorized"], "mine");
    const scope = requestedScope === "authorized" && !organizationWideRoles.has(role) ? "mine" : requestedScope;
    const focus = allow(raw.focus, ["all", "overdue", "today", "upcoming", "completed"], "all");
    const limit = allow(raw.limit, ["25", "50"], "25");
    if (scope !== "mine") queryParams.scope = scope;
    if (focus !== "all") queryParams.focus = focus;
    if (limit !== "25") queryParams.limit = limit;
  } else if (destination === "/outreach") {
    const requestedScope = allow(raw.scope, ["assigned", "authorized"], "assigned");
    const scope = requestedScope === "authorized" && !organizationWideRoles.has(role) ? "assigned" : requestedScope;
    const focus = allow(raw.focus, ["all", "attention", "never-engaged", "stale"], "all");
    const limit = allow(raw.limit, ["25", "50"], "25");
    if (scope !== "assigned") queryParams.scope = scope;
    if (focus !== "all") queryParams.focus = focus;
    if (limit !== "25") queryParams.limit = limit;
  } else if (destination === "/membership/data-quality") {
    const issue = allow(raw.issue, [
      "all",
      "missing_identifier",
      "missing_work_email",
      "missing_department",
      "missing_classification",
      "missing_work_location",
      "unknown_membership",
      "not_in_latest_roster",
    ], "all");
    const pageSize = allow(raw.pageSize, ["25", "50"], "25");
    if (issue !== "all") queryParams.issue = issue;
    if (pageSize !== "25") queryParams.pageSize = pageSize;
  }

  return { destination, queryParams };
}

function normalizeLabel(value: unknown) {
  const label = scalar(value).replace(/\s+/g, " ");
  if (!label || label.length > 80) throw new WorkPreferenceError("INVALID_LABEL", "Saved-view name must be between 1 and 80 characters.");
  return label;
}

function savedViewHandle(organizationId: string, id: string) {
  return createHash("sha256").update(`saved-view:${organizationId}:${id}`).digest("hex");
}

function timestamp(value: string | Date) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function href(destination: SavedViewDestination, queryParams: Record<string, string>) {
  const search = new URLSearchParams(queryParams).toString();
  return search ? `${destination}?${search}` : destination;
}

function parseStoredParams(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && key.length <= 40 && item.length <= 120) output[key] = item;
  }
  return output;
}

export async function listSavedWorkViews(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<SavedWorkView[]> {
  const rows = await query<SavedViewRow>(`
    /* work-preferences:list-saved-views */
    SELECT id, label, destination, query_params, created_at
    FROM local801.saved_work_views
    WHERE organization_id = $1::uuid
      AND user_id = $2::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT ${MAX_SAVED_VIEWS}
  `, [context.organizationId, context.userId]);

  return rows.flatMap((row) => {
    if (!(SAVED_VIEW_DESTINATIONS as readonly string[]).includes(row.destination)) return [];
    if (!can(context.role, routePermission[row.destination])) return [];
    const canonical = normalizeSavedViewParams(context.role, row.destination, parseStoredParams(row.query_params));
    return [{
      handle: savedViewHandle(context.organizationId, row.id),
      label: row.label,
      destination: canonical.destination,
      queryParams: canonical.queryParams,
      href: href(canonical.destination, canonical.queryParams),
      createdAt: timestamp(row.created_at),
    }];
  });
}

export async function createSavedWorkView(
  context: WorkspaceContext,
  input: { label?: unknown; destination?: unknown; queryParams?: unknown },
  dependencies: {
    query?: DatabaseQuery;
    runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
    prepareAudit?: typeof prepareAtomicAuditStatement;
  } = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const label = normalizeLabel(input.label);
  const canonical = normalizeSavedViewParams(context.role, input.destination, input.queryParams);

  const [countRow] = await query<{ saved_count: unknown }>(`
    SELECT count(*) AS saved_count
    FROM local801.saved_work_views
    WHERE organization_id = $1::uuid AND user_id = $2::uuid
  `, [context.organizationId, context.userId]);
  if (Number(countRow?.saved_count ?? 0) >= MAX_SAVED_VIEWS) {
    throw new WorkPreferenceError("SAVED_VIEW_LIMIT", `You can save up to ${MAX_SAVED_VIEWS} work views.`, 409);
  }

  const id = randomUUID();
  const insert: DatabaseStatement = {
    sql: `
      /* work-preferences:create-saved-view */
      WITH inserted AS (
        INSERT INTO local801.saved_work_views
          (id, organization_id, user_id, label, destination, query_params)
        SELECT $3::uuid, $1::uuid, app_user.id, $4::text, $5::text, $6::text::jsonb
        FROM local801.users app_user
        WHERE app_user.id = $2::uuid
          AND app_user.organization_id = $1::uuid
          AND app_user.deactivated_at IS NULL
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS saved_view_created
      FROM inserted
    `,
    parameters: [context.organizationId, context.userId, id, label, canonical.destination, JSON.stringify(canonical.queryParams)],
  };
  const audit = await prepareAudit({
    eventType: "config.change",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "saved_work_view",
    subjectId: id,
    payload: { operation: "create", destination: canonical.destination, filterKeys: Object.keys(canonical.queryParams).sort() },
  }, query);
  await runTransaction([insert, audit]);
  return {
    handle: savedViewHandle(context.organizationId, id),
    label,
    destination: canonical.destination,
    queryParams: canonical.queryParams,
    href: href(canonical.destination, canonical.queryParams),
  };
}

export async function deleteSavedWorkView(
  context: WorkspaceContext,
  handleInput: unknown,
  dependencies: {
    query?: DatabaseQuery;
    runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
    prepareAudit?: typeof prepareAtomicAuditStatement;
  } = {},
) {
  const handle = scalar(handleInput).toLowerCase();
  if (!HANDLE_RE.test(handle)) throw new WorkPreferenceError("INVALID_HANDLE", "Saved view is not available.");
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const [row] = await query<{ id: string; destination: SavedViewDestination }>(`
    SELECT id, destination
    FROM local801.saved_work_views
    WHERE organization_id = $1::uuid
      AND user_id = $2::uuid
      AND encode(public.digest('saved-view:' || $1::text || ':' || id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, context.userId, handle]);
  if (!row) throw new WorkPreferenceError("SAVED_VIEW_NOT_FOUND", "Saved view is no longer available.", 404);

  const remove: DatabaseStatement = {
    sql: `
      WITH deleted AS (
        DELETE FROM local801.saved_work_views
        WHERE id = $3::uuid
          AND organization_id = $1::uuid
          AND user_id = $2::uuid
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS saved_view_deleted
      FROM deleted
    `,
    parameters: [context.organizationId, context.userId, row.id],
  };
  const audit = await prepareAudit({
    eventType: "config.change",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "saved_work_view",
    subjectId: row.id,
    payload: { operation: "delete", destination: row.destination },
  }, query);
  await runTransaction([remove, audit]);
  return { deleted: true };
}

export async function getAcknowledgedNotificationKeys(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
) {
  const rows = await query<{ notification_key: string }>(`
    SELECT notification_key
    FROM local801.notification_acknowledgements
    WHERE organization_id = $1::uuid AND user_id = $2::uuid
      AND acknowledged_at >= now() - interval '180 days'
    ORDER BY acknowledged_at DESC
    LIMIT 500
  `, [context.organizationId, context.userId]);
  return new Set(rows.map((row) => row.notification_key));
}

export async function acknowledgeNotification(
  context: WorkspaceContext,
  keyInput: unknown,
  dependencies: {
    query?: DatabaseQuery;
    runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
    prepareAudit?: typeof prepareAtomicAuditStatement;
  } = {},
) {
  const key = scalar(keyInput).toLowerCase();
  if (!NOTIFICATION_KEY_RE.test(key)) throw new WorkPreferenceError("INVALID_NOTIFICATION", "Notification is not available.");
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const upsert: DatabaseStatement = {
    sql: `
      /* work-preferences:acknowledge-notification */
      INSERT INTO local801.notification_acknowledgements
        (organization_id, user_id, notification_key, acknowledged_at)
      SELECT $1::uuid, app_user.id, $3::text, now()
      FROM local801.users app_user
      WHERE app_user.id = $2::uuid
        AND app_user.organization_id = $1::uuid
        AND app_user.deactivated_at IS NULL
      ON CONFLICT (organization_id, user_id, notification_key)
      DO UPDATE SET acknowledged_at = excluded.acknowledged_at
    `,
    parameters: [context.organizationId, context.userId, key],
  };
  const audit = await prepareAudit({
    eventType: "config.change",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "notification_acknowledgement",
    payload: { operation: "acknowledge", notificationKey: key },
  }, query);
  await runTransaction([upsert, audit]);
  return { acknowledged: true };
}

export function notificationKey(parts: readonly string[]) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export const __testing = {
  MAX_SAVED_VIEWS,
  savedViewHandle,
  routePermission,
};