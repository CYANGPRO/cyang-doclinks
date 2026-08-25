import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DisclosureCard,
  EmptyState,
  PageHeader,
  SectionCard,
  StatusBadge,
  UnavailableState,
} from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { PushNotificationControl } from "@/components/PushNotificationControl";
import { MobileDeviceControl } from "@/components/MobileDeviceControl";
import { DeleteSavedViewButton, DismissNotificationButton } from "@/components/WorkPreferenceControls";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDate, formatCatDateTime } from "@/lib/date-format";
import { listSavedWorkViews } from "@/lib/work-preferences";
import { getWorkNotifications, type WorkNotification, type WorkNotificationUrgency } from "@/lib/work-notifications";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { getPushConfiguration } from "@/lib/push-notifications";

function urgencyTone(urgency: WorkNotificationUrgency) {
  if (urgency === "overdue") return "danger" as const;
  if (urgency === "today") return "warning" as const;
  if (urgency === "soon") return "info" as const;
  return "ready" as const;
}

function urgencyLabel(urgency: WorkNotificationUrgency) {
  if (urgency === "overdue") return "Overdue";
  if (urgency === "today") return "Today";
  if (urgency === "soon") return "Due soon";
  return "Review";
}

function dateTime(value: string | null) {
  if (!value) return null;
  const formatted = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? formatCatDate(value, "")
    : formatCatDateTime(value, "");
  return formatted || null;
}

function NotificationItems({ items }: { items: WorkNotification[] }) {
  return <div className="stack">
    {items.map((notification) => {
      const due = dateTime(notification.dueAt);
      return <article className="section-card" key={notification.key}>
        <div className="section-heading">
          <div>
            <h3>{notification.title}</h3>
            <p>{notification.detail}</p>
          </div>
          <StatusBadge tone={urgencyTone(notification.urgency)}>{urgencyLabel(notification.urgency)}</StatusBadge>
        </div>
        {due ? <p><strong>Due:</strong> {due}</p> : null}
        <div className="page-actions">
          <Link className="button" href={notification.href}>Open</Link>
          <DismissNotificationButton notificationKey={notification.key} />
        </div>
      </article>;
    })}
  </div>;
}

export default async function NotificationsPage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "viewPersonalWorkspace")) redirect("/unauthorized");

  let notifications: Awaited<ReturnType<typeof getWorkNotifications>> = [];
  let savedViews: Awaited<ReturnType<typeof listSavedWorkViews>> = [];
  let unavailable = false;
  try {
    const context = await resolveWorkspaceContext(user);
    [notifications, savedViews] = await Promise.all([
      getWorkNotifications(context),
      listSavedWorkViews(context),
    ]);
  } catch {
    unavailable = true;
  }

  const urgent = notifications.filter((notification) => notification.urgency === "overdue" || notification.urgency === "today");
  const upcoming = notifications.filter((notification) => notification.urgency === "soon");
  const reviews = notifications.filter((notification) => notification.urgency === "info");
  const push = getPushConfiguration();

  return <ProtectedPage permission="viewPersonalWorkspace"><div className="content">
    <PageHeader
      eyebrow="My work"
      title="To Do"
      description={unavailable ? "Your deadlines, review requests, and saved work views could not be loaded safely." : `${notifications.length} current ${notifications.length === 1 ? "item is" : "items are"} ordered by urgency; ${urgent.length} ${urgent.length === 1 ? "requires" : "require"} action today.`}
    />

    <DisclosureCard title="Browser notifications" description={push.enabled ? "Allow this browser to receive private, generic alerts that never include member names or protected details." : "Browser push is unavailable until an administrator completes the deployment configuration."}>
      <PushNotificationControl enabled={push.enabled} publicKey={push.publicKey} />
    </DisclosureCard>

    <MobileDeviceControl urgentCount={urgent.length} totalCount={notifications.length} />

    {unavailable ? <SectionCard><UnavailableState title="To Do is unavailable" description="We couldn’t safely load your current work reminders or saved views, so no substitute data is shown." /></SectionCard> : <>
      {notifications.length === 0 ? <SectionCard>
        <EmptyState title="Your To Do list is clear" description="There are no current reminders, or you’ve already dismissed the current versions." />
      </SectionCard> : <>
        <SectionCard title="Overdue or due today" description={`${urgent.length} ${urgent.length === 1 ? "item requires" : "items require"} attention now.`}>
          {urgent.length ? <NotificationItems items={urgent} /> : <EmptyState title="Nothing urgent" description="No work is overdue or due today." />}
        </SectionCard>

        {upcoming.length ? <DisclosureCard
          title="Due in the next seven days"
          description={`${upcoming.length} upcoming ${upcoming.length === 1 ? "deadline or outreach target" : "deadlines or outreach targets"}.`}
          defaultOpen={urgent.length === 0}
        ><NotificationItems items={upcoming} /></DisclosureCard> : null}

        {reviews.length ? <DisclosureCard
          title="Waiting for your review"
          description={`${reviews.length} ${reviews.length === 1 ? "import, data issue, or workflow decision is" : "imports, data issues, or workflow decisions are"} ready for review.`}
          defaultOpen={urgent.length === 0 && upcoming.length === 0}
        ><NotificationItems items={reviews} /></DisclosureCard> : null}
      </>}

      <DisclosureCard
        title="Saved work views"
        description={`${savedViews.length} reusable ${savedViews.length === 1 ? "filter shortcut is" : "filter shortcuts are"} available for the Work planner.`}
      >
        {savedViews.length === 0 ? <EmptyState title="No saved views yet" description="Open Work Planner and save a filter combination you want to use again." /> : <div className="stack">
          {savedViews.map((view) => <article className="section-card" key={view.handle}>
            <div className="section-heading">
              <div>
                <h3>{view.label}</h3>
                <p>{view.destination}{Object.keys(view.queryParams).length ? ` · ${Object.entries(view.queryParams).map(([key, value]) => `${key}=${value}`).join(" · ")}` : " · default filters"}</p>
              </div>
              <StatusBadge tone="ready">Saved</StatusBadge>
            </div>
            <div className="page-actions">
              <Link className="button" href={view.href}>Open view</Link>
              <DeleteSavedViewButton handle={view.handle} />
            </div>
          </article>)}
        </div>}
      </DisclosureCard>

      <DisclosureCard title="How To Do items stay private" description="What is stored when you dismiss an item">
        <p className="muted">Items are created from your authorized work when this page opens. Dismissing one stores only a private acknowledgement, not its notification text. A new reminder can appear when the underlying work changes.</p>
      </DisclosureCard>
    </>}
  </div></ProtectedPage>;
}
