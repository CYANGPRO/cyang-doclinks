import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const DEFAULT_CAT_ACTION_PAGE_SIZE = 25;
export const MAX_CAT_ACTION_PAGE_SIZE = 100;
export const CAT_ACTION_PAGE_SIZES = [25, 50, 100] as const;
export const MAX_CAT_ACTION_SEARCH_LENGTH = 100;

export type CatActionStatusFilter = "" | "draft" | "active" | "closed";
export type CatActionTaskStatusFilter = "" | "open" | "complete";

type CatActionCursor = {
  rank: number;
  name: string;
  handle: string;
};

type CatActionTaskCursor = {
  createdAt: string;
  handle: string;
};

export type CatActionPortfolioInput = {
  term?: unknown;
  status?: unknown;
  pageSize?: unknown;
  cursor?: unknown;
};

export type CatActionTaskInput = {
  term?: unknown;
  status?: unknown;
  pageSize?: unknown;
  cursor?: unknown;
};

export type CatActionPortfolioItem = {
  handle: string;
  name: string;
  status: "draft" | "active" | "closed";
  contractCycleName: string | null;
  taskCount: number;
  openTaskCount: number;
  completedTaskCount: number;
  overdueTaskCount: number;
  assignedUserCount: number;
  completionRate: number;
  nextDueAt: string | null;
};

export type CatActionPortfolioPage = {
  actions: CatActionPortfolioItem[];
  term: string;
  status: CatActionStatusFilter;
  pageSize: number;
  total: number;
  summary: {
    activeActions: number;
    openTasks: number;
    completedTasks: number;
    overdueTasks: number;
  };
  nextCursor: string | null;
};

export type CatActionDetail = {
  handle: string;
  name: string;
  status: "draft" | "active" | "closed";
  createdAt: string;
  contractCycle: {
    name: string;
    status: string;
    startsOn: string | null;
    endsOn: string | null;
  } | null;
  taskCount: number;
  openTaskCount: number;
  completedTaskCount: number;
  overdueTaskCount: number;
  assignedUserCount: number;
  completionRate: number;
  nextDueAt: string | null;
};

export type CatActionTask = {
  handle: string;
  title: string;
  status: string;
  assigneeName: string | null;
  assigneeActive: boolean;
  dueAt: string | null;
  createdAt: string;
  overdue: boolean;
};

export type CatActionTaskPage = {
  tasks: CatActionTask[];
  term: string;
  status: CatActionTaskStatusFilter;
  pageSize: number;
  total: number;
  summary: {
    open: number;
    complete: number;
    overdue: number;
    unassigned: number;
  };
  nextCursor: string | null;
};

type PortfolioRow = {
  action_handle: string | null;
  name: string | null;
  status: string | null;
  status_rank: unknown;
  name_sort: string | null;
  contract_cycle_name: string | null;
  task_count: unknown;
  open_task_count: unknown;
  completed_task_count: unknown;
  overdue_task_count: unknown;
  assigned_user_count: unknown;
  next_due_at: string | Date | null;
  total_count: unknown;
  active_action_count: unknown;
  total_open_tasks: unknown;
  total_completed_tasks: unknown;
  total_overdue_tasks: unknown;
};

type DetailRow = {
  action_handle: string;
  name: string;
  status: string;
  created_at: string | Date;
  cycle_name: string | null;
  cycle_status: string | null;
  cycle_starts_on: string | Date | null;
  cycle_ends_on: string | Date | null;
  task_count: unknown;
  open_task_count: unknown;
  completed_task_count: unknown;
  overdue_task_count: unknown;
  assigned_user_count: unknown;
  next_due_at: string | Date | null;
};

type TaskRow = {
  task_handle: string | null;
  title: string | null;
  status: string | null;
  assignee_name: string | null;
  assignee_deactivated_at: string | Date | null;
  due_at: string | Date | null;
  created_at: string | Date | null;
  total_count: unknown;
  open_count: unknown;
  complete_count: unknown;
  overdue_count: unknown;
  unassigned_count: unknown;
};

const handlePattern = /^[0-9a-f]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class CatActionAccessError extends Error {
  constructor() {
    super("CAT action access is forbidden.");
    this.name = "CatActionAccessError";
  }
}

export class CatActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatActionInputError";
  }
}

function scalarString(value: unknown) {
  if (Array.isArray(value)) return scalarString(value[0]);
  return typeof value === "string" ? value : "";
}

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function rate(completed: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((Math.min(completed, total) / total) * 1000) / 10);
}

function normalizeStatus(value: unknown): CatActionStatusFilter {
  const raw = scalarString(value);
  return raw === "draft" || raw === "active" || raw === "closed" ? raw : "";
}

function normalizeTaskStatus(value: unknown): CatActionTaskStatusFilter {
  const raw = scalarString(value);
  return raw === "open" || raw === "complete" ? raw : "";
}

function normalizePageSize(value: unknown) {
  const parsed = Number(scalarString(value));
  return CAT_ACTION_PAGE_SIZES.includes(parsed as (typeof CAT_ACTION_PAGE_SIZES)[number])
    ? parsed
    : DEFAULT_CAT_ACTION_PAGE_SIZE;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function like(value: string) {
  return value ? `%${escapeLikePattern(value)}%` : null;
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateOnly(value: string | Date | null) {
  const normalized = timestamp(value);
  return normalized ? normalized.slice(0, 10) : null;
}

function requireActionHandle(value: unknown) {
  const raw = scalarString(value).trim().toLowerCase();
  if (!handlePattern.test(raw)) throw new CatActionInputError("CAT action handle is invalid.");
  return raw;
}

function decodeActionCursor(value: unknown): CatActionCursor | null {
  const raw = scalarString(value);
  if (!raw || raw.length > 800) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CatActionCursor>;
    if (!Number.isInteger(parsed.rank) || parsed.rank! < 0 || parsed.rank! > 9
      || typeof parsed.name !== "string" || parsed.name.length > 200
      || typeof parsed.handle !== "string" || !handlePattern.test(parsed.handle)) return null;
    return { rank: parsed.rank!, name: parsed.name, handle: parsed.handle };
  } catch {
    return null;
  }
}

function encodeActionCursor(row: PortfolioRow) {
  if (!row.action_handle || !handlePattern.test(row.action_handle) || row.name_sort === null) return null;
  const rank = Number(row.status_rank);
  if (!Number.isInteger(rank)) return null;
  return Buffer.from(JSON.stringify({ rank, name: row.name_sort, handle: row.action_handle } satisfies CatActionCursor), "utf8").toString("base64url");
}

function decodeTaskCursor(value: unknown): CatActionTaskCursor | null {
  const raw = scalarString(value);
  if (!raw || raw.length > 800) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CatActionTaskCursor>;
    if (typeof parsed.createdAt !== "string" || !timestampPattern.test(parsed.createdAt)
      || Number.isNaN(new Date(parsed.createdAt).getTime())
      || typeof parsed.handle !== "string" || !handlePattern.test(parsed.handle)) return null;
    return { createdAt: parsed.createdAt, handle: parsed.handle };
  } catch {
    return null;
  }
}

function encodeTaskCursor(row: TaskRow) {
  const createdAt = timestamp(row.created_at);
  if (!createdAt || !row.task_handle || !handlePattern.test(row.task_handle)) return null;
  return Buffer.from(JSON.stringify({ createdAt, handle: row.task_handle } satisfies CatActionTaskCursor), "utf8").toString("base64url");
}

function publicStatus(value: string | null): CatActionPortfolioItem["status"] {
  return value === "active" || value === "closed" ? value : "draft";
}

function portfolioItem(row: PortfolioRow): CatActionPortfolioItem {
  const taskCount = count(row.task_count);
  const completedTaskCount = Math.min(count(row.completed_task_count), taskCount);
  const openTaskCount = Math.min(count(row.open_task_count), taskCount);
  return {
    handle: row.action_handle!,
    name: row.name!,
    status: publicStatus(row.status),
    contractCycleName: row.contract_cycle_name,
    taskCount,
    openTaskCount,
    completedTaskCount,
    overdueTaskCount: Math.min(count(row.overdue_task_count), openTaskCount),
    assignedUserCount: count(row.assigned_user_count),
    completionRate: rate(completedTaskCount, taskCount),
    nextDueAt: timestamp(row.next_due_at),
  };
}

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCatActions")) throw new CatActionAccessError();
}

export function normalizeCatActionPortfolioInput(input: CatActionPortfolioInput) {
  return {
    term: scalarString(input.term).trim().replace(/\s+/g, " ").slice(0, MAX_CAT_ACTION_SEARCH_LENGTH),
    status: normalizeStatus(input.status),
    pageSize: normalizePageSize(input.pageSize),
    cursor: decodeActionCursor(input.cursor),
  };
}

export function normalizeCatActionTaskInput(input: CatActionTaskInput) {
  return {
    term: scalarString(input.term).trim().replace(/\s+/g, " ").slice(0, MAX_CAT_ACTION_SEARCH_LENGTH),
    status: normalizeTaskStatus(input.status),
    pageSize: normalizePageSize(input.pageSize),
    cursor: decodeTaskCursor(input.cursor),
  };
}

export async function getCatActionsPage(
  context: WorkspaceContext,
  input: CatActionPortfolioInput = {},
  query: DatabaseQuery = queryLocal801,
): Promise<CatActionPortfolioPage> {
  requireAccess(context);
  const normalized = normalizeCatActionPortfolioInput(input);
  const cursor = normalized.cursor;
  const rows = await query<PortfolioRow>(`
    /* cat-actions:portfolio-keyset */
    WITH task_rollup AS (
      SELECT
        task.cat_action_id,
        count(*) AS task_count,
        count(*) FILTER (WHERE lower(task.status) = 'open') AS open_task_count,
        count(*) FILTER (WHERE lower(task.status) = 'complete') AS completed_task_count,
        count(*) FILTER (WHERE lower(task.status) = 'open' AND task.due_at IS NOT NULL AND task.due_at < now()) AS overdue_task_count,
        count(DISTINCT task.assigned_to) FILTER (WHERE task.assigned_to IS NOT NULL) AS assigned_user_count,
        min(task.due_at) FILTER (WHERE lower(task.status) = 'open' AND task.due_at IS NOT NULL) AS next_due_at
      FROM local801.cat_action_tasks task
      WHERE task.organization_id = $1::uuid
      GROUP BY task.cat_action_id
    ), base AS (
      SELECT
        encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') AS action_handle,
        action.name,
        action.status,
        CASE action.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'closed' THEN 2 ELSE 9 END AS status_rank,
        lower(action.name) AS name_sort,
        cycle.name AS contract_cycle_name,
        COALESCE(task.task_count, 0) AS task_count,
        COALESCE(task.open_task_count, 0) AS open_task_count,
        COALESCE(task.completed_task_count, 0) AS completed_task_count,
        COALESCE(task.overdue_task_count, 0) AS overdue_task_count,
        COALESCE(task.assigned_user_count, 0) AS assigned_user_count,
        task.next_due_at
      FROM local801.cat_actions action
      LEFT JOIN local801.contract_cycles cycle
        ON cycle.organization_id = action.organization_id
       AND cycle.id = action.contract_cycle_id
      LEFT JOIN task_rollup task ON task.cat_action_id = action.id
      WHERE action.organization_id = $1::uuid
        AND action.archived_at IS NULL
        AND action.status <> 'archived'
        AND ($2::text IS NULL OR action.status = $2::text)
        AND ($3::text IS NULL OR action.name ILIKE $3 ESCAPE '\\' OR cycle.name ILIKE $3 ESCAPE '\\')
    ), stats AS (
      SELECT
        count(*) AS total_count,
        count(*) FILTER (WHERE status = 'active') AS active_action_count,
        COALESCE(sum(open_task_count), 0) AS total_open_tasks,
        COALESCE(sum(completed_task_count), 0) AS total_completed_tasks,
        COALESCE(sum(overdue_task_count), 0) AS total_overdue_tasks
      FROM base
    ), page_rows AS (
      SELECT *
      FROM base
      WHERE ($4::integer IS NULL
        OR status_rank > $4::integer
        OR (status_rank = $4::integer AND name_sort > $5::text)
        OR (status_rank = $4::integer AND name_sort = $5::text AND action_handle > $6::text))
      ORDER BY status_rank ASC, name_sort ASC, action_handle ASC
      LIMIT $7::integer
    )
    SELECT page_rows.*, stats.total_count, stats.active_action_count, stats.total_open_tasks,
      stats.total_completed_tasks, stats.total_overdue_tasks
    FROM stats
    LEFT JOIN page_rows ON true
    ORDER BY page_rows.status_rank ASC NULLS LAST, page_rows.name_sort ASC, page_rows.action_handle ASC
  `, [
    context.organizationId,
    normalized.status || null,
    like(normalized.term),
    cursor?.rank ?? null,
    cursor?.name ?? null,
    cursor?.handle ?? null,
    normalized.pageSize + 1,
  ]);

  const dataRows = rows.filter((row) => row.action_handle && row.name && handlePattern.test(row.action_handle));
  const hasNext = dataRows.length > normalized.pageSize;
  const bounded = dataRows.slice(0, normalized.pageSize);
  const last = hasNext ? bounded.at(-1) : null;
  return {
    actions: bounded.map(portfolioItem),
    term: normalized.term,
    status: normalized.status,
    pageSize: normalized.pageSize,
    total: count(rows[0]?.total_count),
    summary: {
      activeActions: count(rows[0]?.active_action_count),
      openTasks: count(rows[0]?.total_open_tasks),
      completedTasks: count(rows[0]?.total_completed_tasks),
      overdueTasks: count(rows[0]?.total_overdue_tasks),
    },
    nextCursor: last ? encodeActionCursor(last) : null,
  };
}

export async function getCatActionDetail(
  context: WorkspaceContext,
  actionHandle: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<CatActionDetail | null> {
  requireAccess(context);
  const handle = requireActionHandle(actionHandle);
  const rows = await query<DetailRow>(`
    /* cat-actions:detail */
    WITH task_rollup AS (
      SELECT
        task.cat_action_id,
        count(*) AS task_count,
        count(*) FILTER (WHERE lower(task.status) = 'open') AS open_task_count,
        count(*) FILTER (WHERE lower(task.status) = 'complete') AS completed_task_count,
        count(*) FILTER (WHERE lower(task.status) = 'open' AND task.due_at IS NOT NULL AND task.due_at < now()) AS overdue_task_count,
        count(DISTINCT task.assigned_to) FILTER (WHERE task.assigned_to IS NOT NULL) AS assigned_user_count,
        min(task.due_at) FILTER (WHERE lower(task.status) = 'open' AND task.due_at IS NOT NULL) AS next_due_at
      FROM local801.cat_action_tasks task
      WHERE task.organization_id = $1::uuid
      GROUP BY task.cat_action_id
    )
    SELECT
      encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') AS action_handle,
      action.name,
      action.status,
      action.created_at,
      cycle.name AS cycle_name,
      cycle.status AS cycle_status,
      cycle.starts_on AS cycle_starts_on,
      cycle.ends_on AS cycle_ends_on,
      COALESCE(task.task_count, 0) AS task_count,
      COALESCE(task.open_task_count, 0) AS open_task_count,
      COALESCE(task.completed_task_count, 0) AS completed_task_count,
      COALESCE(task.overdue_task_count, 0) AS overdue_task_count,
      COALESCE(task.assigned_user_count, 0) AS assigned_user_count,
      task.next_due_at
    FROM local801.cat_actions action
    LEFT JOIN local801.contract_cycles cycle
      ON cycle.organization_id = action.organization_id
     AND cycle.id = action.contract_cycle_id
    LEFT JOIN task_rollup task ON task.cat_action_id = action.id
    WHERE action.organization_id = $1::uuid
      AND action.archived_at IS NULL
      AND action.status <> 'archived'
      AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  const row = rows[0];
  if (!row) return null;
  const taskCount = count(row.task_count);
  const completedTaskCount = Math.min(count(row.completed_task_count), taskCount);
  const openTaskCount = Math.min(count(row.open_task_count), taskCount);
  return {
    handle: row.action_handle,
    name: row.name,
    status: publicStatus(row.status),
    createdAt: timestamp(row.created_at)!,
    contractCycle: row.cycle_name ? {
      name: row.cycle_name,
      status: row.cycle_status ?? "unspecified",
      startsOn: dateOnly(row.cycle_starts_on),
      endsOn: dateOnly(row.cycle_ends_on),
    } : null,
    taskCount,
    openTaskCount,
    completedTaskCount,
    overdueTaskCount: Math.min(count(row.overdue_task_count), openTaskCount),
    assignedUserCount: count(row.assigned_user_count),
    completionRate: rate(completedTaskCount, taskCount),
    nextDueAt: timestamp(row.next_due_at),
  };
}

export async function getCatActionTasksPage(
  context: WorkspaceContext,
  actionHandle: unknown,
  input: CatActionTaskInput = {},
  query: DatabaseQuery = queryLocal801,
): Promise<CatActionTaskPage> {
  requireAccess(context);
  const handle = requireActionHandle(actionHandle);
  const normalized = normalizeCatActionTaskInput(input);
  const cursor = normalized.cursor;
  const rows = await query<TaskRow>(`
    /* cat-actions:task-keyset */
    WITH base AS (
      SELECT
        encode(public.digest('cat-action-task:' || task.organization_id::text || ':' || task.id::text, 'sha256'), 'hex') AS task_handle,
        task.title,
        task.status,
        assignee.display_name AS assignee_name,
        assignee.deactivated_at AS assignee_deactivated_at,
        task.due_at,
        task.created_at
      FROM local801.cat_action_tasks task
      JOIN local801.cat_actions action
        ON action.organization_id = task.organization_id
       AND action.id = task.cat_action_id
      LEFT JOIN local801.users assignee
        ON assignee.organization_id = task.organization_id
       AND assignee.id = task.assigned_to
      WHERE task.organization_id = $1::uuid
        AND action.archived_at IS NULL
        AND action.status <> 'archived'
        AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $2::text
        AND ($3::text IS NULL OR task.status = $3::text)
        AND ($4::text IS NULL OR task.title ILIKE $4 ESCAPE '\\' OR assignee.display_name ILIKE $4 ESCAPE '\\')
    ), stats AS (
      SELECT
        count(*) AS total_count,
        count(*) FILTER (WHERE lower(status) = 'open') AS open_count,
        count(*) FILTER (WHERE lower(status) = 'complete') AS complete_count,
        count(*) FILTER (WHERE lower(status) = 'open' AND due_at IS NOT NULL AND due_at < now()) AS overdue_count,
        count(*) FILTER (WHERE assignee_name IS NULL) AS unassigned_count
      FROM base
    ), page_rows AS (
      SELECT *
      FROM base
      WHERE ($5::timestamptz IS NULL
        OR created_at < $5::timestamptz
        OR (created_at = $5::timestamptz AND task_handle > $6::text))
      ORDER BY created_at DESC, task_handle ASC
      LIMIT $7::integer
    )
    SELECT page_rows.*, stats.total_count, stats.open_count, stats.complete_count, stats.overdue_count, stats.unassigned_count
    FROM stats
    LEFT JOIN page_rows ON true
    ORDER BY page_rows.created_at DESC NULLS LAST, page_rows.task_handle ASC
  `, [
    context.organizationId,
    handle,
    normalized.status || null,
    like(normalized.term),
    cursor?.createdAt ?? null,
    cursor?.handle ?? null,
    normalized.pageSize + 1,
  ]);

  const dataRows = rows.filter((row) => row.task_handle && row.title && row.created_at && handlePattern.test(row.task_handle));
  const hasNext = dataRows.length > normalized.pageSize;
  const bounded = dataRows.slice(0, normalized.pageSize);
  const last = hasNext ? bounded.at(-1) : null;
  return {
    tasks: bounded.map((row) => ({
      handle: row.task_handle!,
      title: row.title!,
      status: row.status?.trim() || "unspecified",
      assigneeName: row.assignee_name,
      assigneeActive: Boolean(row.assignee_name && !row.assignee_deactivated_at),
      dueAt: timestamp(row.due_at),
      createdAt: timestamp(row.created_at)!,
      overdue: Boolean(row.status?.toLowerCase() === "open" && row.due_at && new Date(row.due_at) < new Date()),
    })),
    term: normalized.term,
    status: normalized.status,
    pageSize: normalized.pageSize,
    total: count(rows[0]?.total_count),
    summary: {
      open: count(rows[0]?.open_count),
      complete: count(rows[0]?.complete_count),
      overdue: count(rows[0]?.overdue_count),
      unassigned: count(rows[0]?.unassigned_count),
    },
    nextCursor: last ? encodeTaskCursor(last) : null,
  };
}

export const __testing = {
  decodeActionCursor,
  decodeTaskCursor,
  requireActionHandle,
  rate,
};
