import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type CatActionReportOverview = {
  actionCount: number;
  activeActionCount: number;
  taskCount: number;
  openTaskCount: number;
  completedTaskCount: number;
  overdueTaskCount: number;
  participantCount: number;
  completionRate: number;
};

export type CatActionStatusBreakdown = {
  status: string;
  actionCount: number;
};

export type CatActionTaskStatusBreakdown = {
  status: string;
  taskCount: number;
};

export type CatActionPerformance = {
  handle: string;
  name: string;
  status: string;
  taskCount: number;
  openTaskCount: number;
  completedTaskCount: number;
  overdueTaskCount: number;
  participantCount: number;
  completionRate: number;
};

export type CatActionReport = {
  overview: CatActionReportOverview;
  actionStatuses: CatActionStatusBreakdown[];
  taskStatuses: CatActionTaskStatusBreakdown[];
  actions: CatActionPerformance[];
};

type OverviewRow = {
  action_count: unknown;
  active_action_count: unknown;
  task_count: unknown;
  open_task_count: unknown;
  completed_task_count: unknown;
  overdue_task_count: unknown;
  participant_count: unknown;
};

type ActionStatusRow = { status: string; action_count: unknown };
type TaskStatusRow = { status: string; task_count: unknown };
type ActionRow = {
  handle: string;
  name: string;
  status: string;
  task_count: unknown;
  open_task_count: unknown;
  completed_task_count: unknown;
  overdue_task_count: unknown;
  participant_count: unknown;
};

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.min(100, Math.round((numerator / denominator) * 1000) / 10);
}

function performance(row: ActionRow): CatActionPerformance {
  const taskCount = count(row.task_count);
  const completedTaskCount = Math.min(count(row.completed_task_count), taskCount);
  const openTaskCount = Math.min(count(row.open_task_count), taskCount);
  const overdueTaskCount = Math.min(count(row.overdue_task_count), openTaskCount);
  const participantCount = Math.min(count(row.participant_count), completedTaskCount);

  return {
    handle: row.handle,
    name: row.name,
    status: row.status,
    taskCount,
    openTaskCount,
    completedTaskCount,
    overdueTaskCount,
    participantCount,
    completionRate: rate(completedTaskCount, taskCount),
  };
}

export async function getCatActionReport(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<CatActionReport> {
  if (!can(context.role, "viewReports")) throw new Error("Forbidden.");

  const [overviewRows, actionStatusRows, taskStatusRows, actionRows] = await Promise.all([
    query<OverviewRow>(`
      /* reports:cat-actions-overview */
      WITH task_rollup AS (
        SELECT
          task.cat_action_id,
          count(*) AS task_count,
          count(*) FILTER (WHERE lower(task.status) = 'open') AS open_task_count,
          count(*) FILTER (WHERE lower(task.status) = 'complete') AS completed_task_count,
          count(*) FILTER (
            WHERE lower(task.status) = 'open'
              AND task.due_at IS NOT NULL
              AND task.due_at < now()
          ) AS overdue_task_count
        FROM local801.cat_action_tasks task
        WHERE task.organization_id = $1::uuid
        GROUP BY task.cat_action_id
      ), participant_rollup AS (
        SELECT count(DISTINCT task.assigned_to) AS participant_count
        FROM local801.cat_action_tasks task
        JOIN local801.cat_actions action
          ON action.organization_id = task.organization_id
         AND action.id = task.cat_action_id
        WHERE task.organization_id = $1::uuid
          AND lower(task.status) = 'complete'
          AND task.assigned_to IS NOT NULL
          AND action.status <> 'archived'
          AND action.archived_at IS NULL
      )
      SELECT
        count(*) AS action_count,
        count(*) FILTER (WHERE summary.status = 'active') AS active_action_count,
        COALESCE(sum(task.task_count), 0) AS task_count,
        COALESCE(sum(task.open_task_count), 0) AS open_task_count,
        COALESCE(sum(task.completed_task_count), 0) AS completed_task_count,
        COALESCE(sum(task.overdue_task_count), 0) AS overdue_task_count,
        COALESCE((SELECT participant_count FROM participant_rollup), 0) AS participant_count
      FROM reporting.cat_action_summary summary
      JOIN local801.cat_actions action
        ON action.organization_id = summary.organization_id
       AND action.id = summary.cat_action_id
      LEFT JOIN task_rollup task ON task.cat_action_id = summary.cat_action_id
      WHERE summary.organization_id = $1::uuid
        AND summary.status <> 'archived'
        AND action.archived_at IS NULL
    `, [context.organizationId]),
    query<ActionStatusRow>(`
      /* reports:cat-actions-statuses */
      SELECT summary.status, count(*) AS action_count
      FROM reporting.cat_action_summary summary
      JOIN local801.cat_actions action
        ON action.organization_id = summary.organization_id
       AND action.id = summary.cat_action_id
      WHERE summary.organization_id = $1::uuid
        AND summary.status <> 'archived'
        AND action.archived_at IS NULL
      GROUP BY summary.status
      ORDER BY summary.status ASC
      LIMIT 20
    `, [context.organizationId]),
    query<TaskStatusRow>(`
      /* reports:cat-actions-task-statuses */
      SELECT
        COALESCE(NULLIF(trim(task.status), ''), 'Unspecified') AS status,
        count(*) AS task_count
      FROM local801.cat_action_tasks task
      JOIN local801.cat_actions action
        ON action.organization_id = task.organization_id
       AND action.id = task.cat_action_id
      WHERE task.organization_id = $1::uuid
        AND action.status <> 'archived'
        AND action.archived_at IS NULL
      GROUP BY COALESCE(NULLIF(trim(task.status), ''), 'Unspecified')
      ORDER BY status ASC
      LIMIT 20
    `, [context.organizationId]),
    query<ActionRow>(`
      /* reports:cat-actions-performance */
      WITH task_rollup AS (
        SELECT
          task.cat_action_id,
          count(*) AS task_count,
          count(*) FILTER (WHERE lower(task.status) = 'open') AS open_task_count,
          count(*) FILTER (WHERE lower(task.status) = 'complete') AS completed_task_count,
          count(*) FILTER (
            WHERE lower(task.status) = 'open'
              AND task.due_at IS NOT NULL
              AND task.due_at < now()
          ) AS overdue_task_count
        FROM local801.cat_action_tasks task
        WHERE task.organization_id = $1::uuid
        GROUP BY task.cat_action_id
      )
      SELECT
        encode(public.digest('cat-action:' || summary.organization_id::text || ':' || summary.cat_action_id::text, 'sha256'), 'hex') AS handle,
        summary.name,
        summary.status,
        COALESCE(task.task_count, 0) AS task_count,
        COALESCE(task.open_task_count, 0) AS open_task_count,
        COALESCE(task.completed_task_count, 0) AS completed_task_count,
        COALESCE(task.overdue_task_count, 0) AS overdue_task_count,
        COALESCE(participation.participant_count, 0) AS participant_count
      FROM reporting.cat_action_summary summary
      JOIN local801.cat_actions action
        ON action.organization_id = summary.organization_id
       AND action.id = summary.cat_action_id
      LEFT JOIN task_rollup task ON task.cat_action_id = summary.cat_action_id
      LEFT JOIN reporting.cat_action_participation participation
        ON participation.organization_id = summary.organization_id
       AND participation.cat_action_id = summary.cat_action_id
      WHERE summary.organization_id = $1::uuid
        AND summary.status <> 'archived'
        AND action.archived_at IS NULL
      ORDER BY summary.name ASC
      LIMIT 50
    `, [context.organizationId]),
  ]);

  const overview = overviewRows[0];
  const taskCount = count(overview?.task_count);
  const openTaskCount = Math.min(count(overview?.open_task_count), taskCount);
  const completedTaskCount = Math.min(count(overview?.completed_task_count), taskCount);
  const overdueTaskCount = Math.min(count(overview?.overdue_task_count), openTaskCount);
  const participantCount = Math.min(count(overview?.participant_count), completedTaskCount);

  return {
    overview: {
      actionCount: count(overview?.action_count),
      activeActionCount: count(overview?.active_action_count),
      taskCount,
      openTaskCount,
      completedTaskCount,
      overdueTaskCount,
      participantCount,
      completionRate: rate(completedTaskCount, taskCount),
    },
    actionStatuses: actionStatusRows.map((row) => ({ status: row.status, actionCount: count(row.action_count) })),
    taskStatuses: taskStatusRows.map((row) => ({ status: row.status, taskCount: count(row.task_count) })),
    actions: actionRows.map(performance),
  };
}

export const __testing = { count, rate, performance };
