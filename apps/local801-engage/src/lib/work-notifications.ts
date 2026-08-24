import "server-only";

import { can } from "./access.ts";
import { getCampaignsPage } from "./campaigns.ts";
import { getCatActionsPage } from "./cat-actions.ts";
import { getDataQualitySummary } from "./data-quality.ts";
import { getFollowupQueue } from "./follow-ups.ts";
import { getDashboardMetrics } from "./metrics.ts";
import { hydrateFollowupQueueFromProtectedPii } from "./pii-protected-followup-read.ts";
import {
  getAcknowledgedNotificationKeys,
  notificationKey,
} from "./work-preferences.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type WorkNotificationUrgency = "overdue" | "today" | "soon" | "info";

export type WorkNotification = {
  key: string;
  type: "followup" | "import_review" | "data_quality" | "new_hire" | "campaign" | "cat_action";
  title: string;
  detail: string;
  href: string;
  urgency: WorkNotificationUrgency;
  dueAt: string | null;
};

type Dependencies = {
  getFollowups?: typeof getFollowupQueue;
  hydrateFollowups?: typeof hydrateFollowupQueueFromProtectedPii;
  getMetrics?: typeof getDashboardMetrics;
  getDataQuality?: typeof getDataQualitySummary;
  getCampaigns?: typeof getCampaignsPage;
  getCatActions?: typeof getCatActionsPage;
  getAcknowledged?: typeof getAcknowledgedNotificationKeys;
  now?: () => Date;
};

const organizationWideRoles = new Set(["system_owner", "local_admin", "cat_admin"]);

function dueWithinDays(value: string, now: Date, days: number) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const delta = parsed.getTime() - now.getTime();
  return delta >= 0 && delta <= days * 86_400_000;
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
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function dateOrdinal(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  return Number.isFinite(timestamp) ? Math.trunc(timestamp / 86_400_000) : null;
}

function dateOnlyWithinDays(value: string, now: Date, days: number) {
  const today = chicagoDateKey(now);
  const current = today ? dateOrdinal(today) : null;
  const target = dateOrdinal(value);
  if (current === null || target === null) return false;
  const delta = target - current;
  return delta >= 0 && delta <= days;
}

function notificationOrder(left: WorkNotification, right: WorkNotification) {
  const rank: Record<WorkNotificationUrgency, number> = { overdue: 0, today: 1, soon: 2, info: 3 };
  return rank[left.urgency] - rank[right.urgency]
    || (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999")
    || left.title.localeCompare(right.title);
}

export async function getWorkNotifications(
  context: WorkspaceContext,
  dependencies: Dependencies = {},
): Promise<WorkNotification[]> {
  const now = (dependencies.now ?? (() => new Date()))();
  const todayKey = chicagoDateKey(now) ?? now.toISOString().slice(0, 10);
  const notifications: WorkNotification[] = [];

  if (can(context.role, "recordEngagement")) {
    const scope = organizationWideRoles.has(context.role) ? "authorized" : "mine";
    const legacy = await (dependencies.getFollowups ?? getFollowupQueue)(context, { scope, focus: "all", pageSize: 50 });
    const page = await (dependencies.hydrateFollowups ?? hydrateFollowupQueueFromProtectedPii)(context.organizationId, legacy);
    for (const item of page.items) {
      if (item.bucket !== "overdue" && item.bucket !== "today" && !dueWithinDays(item.dueAt, now, 2)) continue;
      const urgency: WorkNotificationUrgency = item.bucket === "overdue" ? "overdue" : item.bucket === "today" ? "today" : "soon";
      notifications.push({
        key: notificationKey(["followup", item.followupHandle, item.dueAt]),
        type: "followup",
        title: `${urgency === "overdue" ? "Overdue" : urgency === "today" ? "Due today" : "Due soon"}: ${item.displayName}`,
        detail: item.campaignName ? `Follow-up from ${item.campaignName}` : "Follow-up from organizing outreach",
        href: `/outreach/${item.employeeHandle}`,
        urgency,
        dueAt: item.dueAt,
      });
    }
  }

  if (can(context.role, "manageImports")) {
    const metrics = await (dependencies.getMetrics ?? getDashboardMetrics)(context);
    if (Number(metrics.importsInReview) > 0) {
      const count = Number(metrics.importsInReview);
      notifications.push({
        key: notificationKey(["imports-in-review", todayKey, String(count)]),
        type: "import_review",
        title: `${count} import${count === 1 ? " is" : "s are"} ready for review`,
        detail: "Open Data Imports to review validated protected changes before approval.",
        href: "/imports",
        urgency: "info",
        dueAt: null,
      });
    }
    if (Number(metrics.newHiresAwaitingFirstEngagement14) > 0) {
      const count = Number(metrics.newHiresAwaitingFirstEngagement14);
      notifications.push({
        key: notificationKey(["new-hires-14-day", todayKey, String(count)]),
        type: "new_hire",
        title: `${count} new hire${count === 1 ? "" : "s"} past the 14-day first-engagement target`,
        detail: "This is a factual workflow gap based on hire and engagement dates.",
        href: "/new-hires",
        urgency: "soon",
        dueAt: null,
      });
    }
    const quality = await (dependencies.getDataQuality ?? getDataQualitySummary)(context);
    if (quality.flaggedPeople > 0) {
      notifications.push({
        key: notificationKey(["data-quality", todayKey, String(quality.flaggedPeople), String(quality.notInLatestRoster), String(quality.latestRosterAvailable)]),
        type: "data_quality",
        title: `${quality.flaggedPeople} record${quality.flaggedPeople === 1 ? " needs" : "s need"} data-quality review`,
        detail: quality.latestRosterAvailable
          ? "Explicit missing-data and latest-roster discrepancies are available for review."
          : "Explicit missing-data issues are available; latest-roster comparison is currently unavailable.",
        href: "/membership/data-quality",
        urgency: "info",
        dueAt: null,
      });
    }
  }

  if (can(context.role, "manageCampaigns")) {
    const campaigns = await (dependencies.getCampaigns ?? getCampaignsPage)(context, { pageSize: 100 });
    for (const campaign of campaigns.campaigns) {
      if (campaign.status !== "active" || !campaign.endsOn || !dateOnlyWithinDays(campaign.endsOn, now, 7)) continue;
      notifications.push({
        key: notificationKey(["campaign-ending", campaign.handle, campaign.endsOn]),
        type: "campaign",
        title: `Campaign deadline approaching: ${campaign.name}`,
        detail: `${campaign.remaining} remaining · ${campaign.completionPercentage}% complete`,
        href: `/campaigns/${campaign.handle}`,
        urgency: "soon",
        dueAt: campaign.endsOn,
      });
    }
  }

  if (can(context.role, "manageCatActions")) {
    const actions = await (dependencies.getCatActions ?? getCatActionsPage)(context, { pageSize: 100 });
    for (const action of actions.actions) {
      if (action.status !== "active") continue;
      if (action.overdueTaskCount > 0) {
        notifications.push({
          key: notificationKey(["cat-action-overdue", action.handle, String(action.overdueTaskCount), action.nextDueAt ?? "none"]),
          type: "cat_action",
          title: `${action.overdueTaskCount} overdue CAT Action task${action.overdueTaskCount === 1 ? "" : "s"}: ${action.name}`,
          detail: `${action.openTaskCount} open task${action.openTaskCount === 1 ? "" : "s"} total`,
          href: `/cat-actions/${action.handle}`,
          urgency: "overdue",
          dueAt: action.nextDueAt,
        });
      } else if (action.nextDueAt && dueWithinDays(action.nextDueAt, now, 7)) {
        notifications.push({
          key: notificationKey(["cat-action-due", action.handle, action.nextDueAt]),
          type: "cat_action",
          title: `CAT Action work due soon: ${action.name}`,
          detail: `${action.openTaskCount} open task${action.openTaskCount === 1 ? "" : "s"}`,
          href: `/cat-actions/${action.handle}`,
          urgency: "soon",
          dueAt: action.nextDueAt,
        });
      }
    }
  }

  const acknowledged = await (dependencies.getAcknowledged ?? getAcknowledgedNotificationKeys)(context);
  return notifications
    .filter((notification) => !acknowledged.has(notification.key))
    .sort(notificationOrder)
    .slice(0, 100);
}

export const __testing = { dueWithinDays, chicagoDateKey, dateOrdinal, dateOnlyWithinDays, notificationOrder };