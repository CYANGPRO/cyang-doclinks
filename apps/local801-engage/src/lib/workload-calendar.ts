import "server-only";

import { can } from "./access.ts";
import { getCampaignsPage, type CampaignPage } from "./campaigns.ts";
import { getCatActionsPage, type CatActionPortfolioPage } from "./cat-actions.ts";
import { getFollowupQueue, type FollowupQueuePage } from "./follow-ups.ts";
import { getDashboardMetrics, type DashboardMetrics } from "./metrics.ts";
import { hydrateFollowupQueueFromProtectedPii } from "./pii-protected-followup-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type WorkloadCalendarBucket = "overdue" | "today" | "next7" | "later";
export type WorkloadCalendarKind = "followup" | "campaign" | "cat_action";

export type WorkloadCalendarEntry = {
  key: string;
  kind: WorkloadCalendarKind;
  title: string;
  detail: string;
  href: string;
  dueAt: string | null;
  dateKey: string;
  bucket: WorkloadCalendarBucket;
  assignedTo: string | null;
};

export type WorkloadCalendarResult = {
  scope: "mine" | "authorized";
  scopeLabel: string;
  metrics: DashboardMetrics;
  entries: WorkloadCalendarEntry[];
  visibleCounts: Record<WorkloadCalendarBucket, number>;
  truncation: {
    followups: boolean;
    campaigns: boolean;
    catActions: boolean;
  };
};

type WorkloadDependencies = {
  getMetrics?: typeof getDashboardMetrics;
  getFollowups?: typeof getFollowupQueue;
  hydrateFollowups?: typeof hydrateFollowupQueueFromProtectedPii;
  getCampaigns?: typeof getCampaignsPage;
  getCatActions?: typeof getCatActionsPage;
  now?: () => Date;
};

const organizationWideRoles = new Set(["system_owner", "local_admin", "cat_admin"]);

export class WorkloadCalendarAccessError extends Error {
  constructor() {
    super("Workload calendar access is forbidden.");
    this.name = "WorkloadCalendarAccessError";
  }
}

function chicagoDateKey(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not resolve the America/Chicago calendar date.");
  return `${year}-${month}-${day}`;
}

function timestampDateKey(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return chicagoDateKey(parsed);
}

function dateDistance(left: string, right: string) {
  const [leftYear, leftMonth, leftDay] = left.split("-").map(Number);
  const [rightYear, rightMonth, rightDay] = right.split("-").map(Number);
  const leftUtc = Date.UTC(leftYear, leftMonth - 1, leftDay);
  const rightUtc = Date.UTC(rightYear, rightMonth - 1, rightDay);
  return Math.round((rightUtc - leftUtc) / 86_400_000);
}

export function classifyCalendarDate(
  dateKey: string,
  todayKey: string,
  options: { timedValue?: string | null; now?: Date } = {},
): WorkloadCalendarBucket {
  if (options.timedValue) {
    const parsed = new Date(options.timedValue);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() < (options.now ?? new Date()).getTime()) return "overdue";
  }
  const difference = dateDistance(todayKey, dateKey);
  if (difference < 0) return "overdue";
  if (difference === 0) return "today";
  if (difference <= 7) return "next7";
  return "later";
}

function entryOrder(left: WorkloadCalendarEntry, right: WorkloadCalendarEntry) {
  const rank: Record<WorkloadCalendarBucket, number> = { overdue: 0, today: 1, next7: 2, later: 3 };
  return rank[left.bucket] - rank[right.bucket]
    || left.dateKey.localeCompare(right.dateKey)
    || left.kind.localeCompare(right.kind)
    || left.title.localeCompare(right.title);
}

function followupEntries(page: FollowupQueuePage, todayKey: string, now: Date) {
  return page.items.map<WorkloadCalendarEntry>((item) => {
    const dateKey = timestampDateKey(item.dueAt) ?? todayKey;
    const bucket = item.bucket === "overdue" || item.bucket === "today"
      ? item.bucket
      : classifyCalendarDate(dateKey, todayKey, { timedValue: item.dueAt, now });
    return {
      key: `followup:${item.followupHandle}`,
      kind: "followup",
      title: item.displayName,
      detail: `${item.campaignName || "General outreach"}${item.latestOutcome ? ` · latest: ${item.latestOutcome}` : ""}`,
      href: `/outreach/${item.employeeHandle}`,
      dueAt: item.dueAt,
      dateKey,
      bucket,
      assignedTo: item.assignedTo,
    };
  });
}

function campaignEntries(page: CampaignPage, todayKey: string) {
  return page.campaigns
    .filter((campaign) => campaign.status === "active" && campaign.endsOn)
    .map<WorkloadCalendarEntry>((campaign) => ({
      key: `campaign:${campaign.handle}`,
      kind: "campaign",
      title: campaign.name,
      detail: `${campaign.remaining} remaining · ${campaign.completionPercentage}% complete`,
      href: `/campaigns/${campaign.handle}`,
      dueAt: null,
      dateKey: campaign.endsOn!,
      bucket: classifyCalendarDate(campaign.endsOn!, todayKey),
      assignedTo: null,
    }));
}

function catActionEntries(page: CatActionPortfolioPage, todayKey: string, now: Date) {
  return page.actions
    .filter((action) => action.status === "active" && action.nextDueAt)
    .map<WorkloadCalendarEntry>((action) => {
      const dateKey = timestampDateKey(action.nextDueAt!) ?? todayKey;
      return {
        key: `cat-action:${action.handle}`,
        kind: "cat_action",
        title: action.name,
        detail: `${action.openTaskCount} open task${action.openTaskCount === 1 ? "" : "s"} · ${action.overdueTaskCount} overdue`,
        href: `/cat-actions/${action.handle}`,
        dueAt: action.nextDueAt,
        dateKey,
        bucket: classifyCalendarDate(dateKey, todayKey, { timedValue: action.nextDueAt, now }),
        assignedTo: null,
      };
    });
}

export async function getWorkloadCalendar(
  context: WorkspaceContext,
  dependencies: WorkloadDependencies = {},
): Promise<WorkloadCalendarResult> {
  if (!can(context.role, "recordEngagement")) throw new WorkloadCalendarAccessError();

  const now = (dependencies.now ?? (() => new Date()))();
  const todayKey = chicagoDateKey(now);
  const organizationWide = organizationWideRoles.has(context.role);
  const scope = organizationWide ? "authorized" : "mine";
  const getMetrics = dependencies.getMetrics ?? getDashboardMetrics;
  const getFollowups = dependencies.getFollowups ?? getFollowupQueue;
  const hydrateFollowups = dependencies.hydrateFollowups ?? hydrateFollowupQueueFromProtectedPii;
  const getCampaigns = dependencies.getCampaigns ?? getCampaignsPage;
  const getCatActions = dependencies.getCatActions ?? getCatActionsPage;

  const [metrics, legacyFollowups] = await Promise.all([
    getMetrics(context),
    getFollowups(context, { scope, focus: "all", pageSize: 50 }),
  ]);
  const followups = await hydrateFollowups(context.organizationId, legacyFollowups);

  const campaigns = can(context.role, "manageCampaigns")
    ? await getCampaigns(context, { pageSize: 100 })
    : null;
  const catActions = can(context.role, "manageCatActions")
    ? await getCatActions(context, { pageSize: 100 })
    : null;

  const entries = [
    ...followupEntries(followups, todayKey, now),
    ...(campaigns ? campaignEntries(campaigns, todayKey) : []),
    ...(catActions ? catActionEntries(catActions, todayKey, now) : []),
  ].sort(entryOrder);

  const visibleCounts: Record<WorkloadCalendarBucket, number> = { overdue: 0, today: 0, next7: 0, later: 0 };
  for (const entry of entries) visibleCounts[entry.bucket] += 1;

  return {
    scope,
    scopeLabel: organizationWide ? "All authorized organization work" : "Your current assigned work",
    metrics,
    entries,
    visibleCounts,
    truncation: {
      followups: followups.total > followups.items.length,
      campaigns: Boolean(campaigns?.nextCursor),
      catActions: Boolean(catActions?.nextCursor),
    },
  };
}

export const __testing = {
  chicagoDateKey,
  dateDistance,
  timestampDateKey,
};
