import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActionReadinessSummary } from "@/components/ActionReadinessSummary";
import {
  AlertBanner,
  DataTable,
  DisclosureCard,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  SectionCard,
  StatCard,
  StatusBadge,
  UnavailableState,
  type StatusTone,
} from "@/components/DesignSystem";
import {
  CatActionDeleteButton,
  CatActionEditForm,
  CatActionTaskCreateForm,
  CatActionTaskEditForm,
} from "@/components/CatActionMutations";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getCampaignActionReadiness, getCatActionReadiness } from "@/lib/action-readiness-summary";
import { getPreviewUser } from "@/lib/authz.server";
import { getCampaignDetail } from "@/lib/campaigns";
import { listCatActionCampaignLinks } from "@/lib/campaign-cat-links";
import { getCatActionManagementOptions } from "@/lib/cat-action-management";
import {
  getCatActionDetail,
  getCatActionTasksPage,
  type CatActionTaskPage,
} from "@/lib/cat-actions";
import { formatCatDate, formatCatDateTime } from "@/lib/date-format";
import { hydrateCatActionDetailFromProtectedPii } from "@/lib/pii-protected-cat-action-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

const HANDLE_RE = /^[0-9a-f]{64}$/i;

function statusTone(status: string): StatusTone {
  if (status === "active" || status === "complete") return "ready";
  if (status === "draft" || status === "open") return "pending";
  if (status === "closed") return "neutral";
  return "warning";
}

function dateOnly(value: string | null) {
  return formatCatDate(value, "Not set");
}

function dateTime(value: string | null) {
  return formatCatDateTime(value, "Not set");
}

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function sourceCampaignHandle(value: string | string[] | undefined) {
  const handle = scalar(value).trim().toLowerCase();
  return HANDLE_RE.test(handle) ? handle : "";
}

function taskHref(actionHandle: string, page: CatActionTaskPage, cursor: string | null, fromCampaign: string) {
  const query = new URLSearchParams({ limit: String(page.pageSize) });
  if (cursor) query.set("cursor", cursor);
  if (page.term) query.set("q", page.term);
  if (page.status) query.set("status", page.status);
  if (fromCampaign) query.set("fromCampaign", fromCampaign);
  return `/cat-actions/${actionHandle}?${query}`;
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((Math.min(value, total) / total) * 1000) / 10);
}

export default async function CatActionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ actionHandle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ actionHandle }, input] = await Promise.all([params, searchParams]);
  const hasCursor = typeof input.cursor === "string" && input.cursor.length > 0;
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageCatActions")) redirect("/unauthorized");

  const fromCampaign = sourceCampaignHandle(input.fromCampaign);
  let action: Awaited<ReturnType<typeof getCatActionDetail>> = null;
  let tasks: Awaited<ReturnType<typeof getCatActionTasksPage>> | null = null;
  let options: Awaited<ReturnType<typeof getCatActionManagementOptions>> | null = null;
  let readiness: Awaited<ReturnType<typeof getCatActionReadiness>> | null = null;
  let readinessUnavailable = false;
  let sourceCampaign: Awaited<ReturnType<typeof getCampaignDetail>> = null;
  let sourceCampaignReadiness: Awaited<ReturnType<typeof getCampaignActionReadiness>> | null = null;
  let sourceCampaignUnavailable = false;
  let linkedCampaigns: Awaited<ReturnType<typeof listCatActionCampaignLinks>> = [];
  let unavailable = false;
  let protectedReadEnabled = false;
  try {
    const context = await resolveWorkspaceContext(user);
    [action, options] = await Promise.all([
      getCatActionDetail(context, actionHandle),
      getCatActionManagementOptions(context),
    ]);
    if (action) {
      tasks = await getCatActionTasksPage(context, actionHandle, {
        term: input.q,
        status: input.status,
        pageSize: input.limit,
        cursor: input.cursor,
      });
      try {
        readiness = await getCatActionReadiness(context, actionHandle);
      } catch {
        readinessUnavailable = true;
      }
      if (fromCampaign && can(user.role, "manageCampaigns")) {
        try {
          sourceCampaign = await getCampaignDetail(context, fromCampaign);
          if (sourceCampaign) sourceCampaignReadiness = await getCampaignActionReadiness(context, fromCampaign);
        } catch {
          sourceCampaignUnavailable = true;
        }
      }
      if (can(user.role, "manageCampaigns")) linkedCampaigns = await listCatActionCampaignLinks(context, actionHandle);
      const hydrated = await hydrateCatActionDetailFromProtectedPii(context.organizationId, actionHandle, {
        tasks,
        options,
      });
      tasks = hydrated.tasks;
      options = hydrated.options;
      protectedReadEnabled = isPiiProtectedReadEnabled();
    }
  } catch {
    unavailable = true;
  }

  if (!unavailable && !action) notFound();
  const mutationReady = Boolean(action && tasks && options && !unavailable);

  return <ProtectedPage permission="manageCatActions"><div className="content route-cat-action-detail-page record-workspace-page">
    <PageHeader
      eyebrow="CAT Actions"
      title={action?.name ?? "CAT Action"}
      description="Manage the action and its tasks here. Restricted strategy content stays in the separate protected strategy area and is not loaded on this page."
      actions={<div className="page-actions"><Link className="button secondary" href="/cat-actions">Back to CAT Actions</Link>{sourceCampaign ? <Link className="button secondary" href={`/campaigns/${sourceCampaign.handle}`}>Back to {sourceCampaign.name}</Link> : null}</div>}
    />

    {unavailable || !action || !tasks ? <SectionCard><UnavailableState title="CAT Action unavailable" description="We couldn’t safely load this action, its tasks, and the protected user details needed to manage it." /></SectionCard> : <>
      <section className="metrics-grid" aria-label="CAT action summary">
        <StatCard label="Status" value={action.status} detail="Current action state" tone="brand" />
        <StatCard label="Tasks" value={action.taskCount} detail="All tasks" />
        <StatCard label="Open" value={action.openTaskCount} detail="Still to do" tone="attention" />
        <StatCard label="Completed" value={action.completedTaskCount} detail={`${action.completionRate.toFixed(1)}% complete`} />
        <StatCard label="Overdue" value={action.overdueTaskCount} detail="Open and past due" tone={action.overdueTaskCount ? "danger" : "default"} />
        <StatCard label="Assigned users" value={action.assignedUserCount} detail="People assigned to tasks" />
      </section>

      <SectionCard title="Action context" badge={<StatusBadge tone={statusTone(action.status)}>{action.status}</StatusBadge>}>
        <DataTable caption="CAT action context" headers={["Contract cycle", "Cycle status", "Starts", "Ends", "Next open due", "Created"]}>
          <tr>
            <td>{action.contractCycle?.name ?? "No contract cycle"}</td>
            <td>{action.contractCycle?.status ?? "—"}</td>
            <td>{dateOnly(action.contractCycle?.startsOn ?? null)}</td>
            <td>{dateOnly(action.contractCycle?.endsOn ?? null)}</td>
            <td>{dateTime(action.nextDueAt)}</td>
            <td>{dateTime(action.createdAt)}</td>
          </tr>
        </DataTable>
      </SectionCard>

      <SectionCard title="Manage action" description="Changes are same-origin protected, organization scoped, role authorized, and written atomically with a durable audit event.">
        {mutationReady ? <CatActionEditForm
          actionHandle={action.handle}
          initialName={action.name}
          initialStatus={action.status}
          cycles={options!.contractCycles}
        /> : <UnavailableState title="Action editing unavailable" description="Authorized management options could not be loaded." />}
      </SectionCard>

      {action.status !== "closed" ? <SectionCard title="Create task" description="Create an operational task with an optional CAT organizer and due date. Strategy notes are not accepted here."
        badge={protectedReadEnabled ? <StatusBadge tone="preview">Protected PII</StatusBadge> : undefined}>
        {mutationReady ? <CatActionTaskCreateForm actionHandle={action.handle} assignees={options!.assignees} />
          : <UnavailableState title="Task creation unavailable" description="Authorized assignee options could not be loaded." />}
      </SectionCard> : null}

      <DisclosureCard title="Filter tasks" description="Search this CAT Action’s tasks and narrow them by status." defaultOpen={Boolean(tasks.term || tasks.status)} className="route-secondary-panel task-filter-panel">
        <form action={`/cat-actions/${action.handle}`} method="get">
          {fromCampaign ? <input type="hidden" name="fromCampaign" value={fromCampaign} /> : null}
          <FilterBar>
            <div className="field">
              <label htmlFor="cat-task-search">Search tasks</label>
              <input id="cat-task-search" name="q" type="search" maxLength={100} defaultValue={tasks.term} placeholder="Task title or assignee" />
            </div>
            <div className="field">
              <label htmlFor="cat-task-status">Status</label>
              <select id="cat-task-status" name="status" defaultValue={tasks.status}>
                <option value="">Any task status</option>
                <option value="open">Open</option>
                <option value="complete">Complete</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="cat-task-limit">Results per page</label>
              <select id="cat-task-limit" name="limit" defaultValue={String(tasks.pageSize)}>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </div>
            <button className="button" type="submit">Apply filters</button>
          </FilterBar>
        </form>
      </DisclosureCard>

      <section className="metrics-grid" aria-label="Filtered task summary">
        <StatCard label="Matching tasks" value={tasks.total} detail="Current filters" tone="brand" />
        <StatCard label="Open" value={tasks.summary.open} detail="Matching open tasks" />
        <StatCard label="Complete" value={tasks.summary.complete} detail="Matching completed tasks" />
        <StatCard label="Overdue" value={tasks.summary.overdue} detail="Matching open tasks past due" tone={tasks.summary.overdue ? "danger" : "default"} />
        <StatCard label="Unassigned" value={tasks.summary.unassigned} detail="No current assignee" tone="attention" />
      </section>

      <SectionCard title="CAT Action tasks" description={`${tasks.total} ${tasks.total === 1 ? "task matches" : "tasks match"} the current filters.`} badge={protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}>
        {tasks.tasks.length === 0 ? <EmptyState title="No matching tasks" description="No tasks match the filters you chose." /> : <>
          <DataTable caption={`${action.name} tasks`} headers={["Task", "Status", "Assignee", "Due", "Created", "Manage"]}>
            {tasks.tasks.map((task) => <tr key={task.handle}>
              <td><strong>{task.title}</strong></td>
              <td>{task.overdue ? <StatusBadge tone="danger">Overdue</StatusBadge> : <StatusBadge tone={statusTone(task.status)}>{task.status}</StatusBadge>}</td>
              <td>{task.assigneeName ? <>{task.assigneeName}{!task.assigneeActive ? <div className="muted">Inactive user</div> : null}</> : "Unassigned"}</td>
              <td>{dateTime(task.dueAt)}</td>
              <td>{dateTime(task.createdAt)}</td>
              <td>{action.status !== "closed" && mutationReady
                ? <CatActionTaskEditForm actionHandle={action.handle} task={task} assignees={options!.assignees} />
                : <span className="muted">Read only</span>}</td>
            </tr>)}
          </DataTable>
          <Pagination
            label={`Showing up to ${tasks.pageSize} of ${tasks.total} tasks`}
            historyBackFallbackHref={hasCursor ? taskHref(action.handle, tasks, null, fromCampaign) : null}
            nextHref={tasks.nextCursor ? taskHref(action.handle, tasks, tasks.nextCursor, fromCampaign) : null}
          />
        </>}
      </SectionCard>

      {action.status !== "closed" ? <DisclosureCard title="Create a task" description={sourceCampaign ? `Create CAT Action work after reviewing the ${sourceCampaign.name} campaign context below. Campaign details are not copied into a task automatically.` : "Add a task with an optional CAT organizer and due date. Restricted strategy notes do not belong here."}
        className="route-secondary-panel task-create-panel"
        badge={protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : undefined}>
        {mutationReady ? <CatActionTaskCreateForm actionHandle={action.handle} assignees={options!.assignees} />
          : <UnavailableState title="Task creation unavailable" description="We couldn’t load the organizer options needed to create a task." />}
      </DisclosureCard> : null}

      <ActionReadinessSummary summary={readiness} unavailable={readinessUnavailable} subject="CAT action" />

      <DisclosureCard title="Linked campaigns" description={`${linkedCampaigns.length} ${linkedCampaigns.length === 1 ? "campaign has" : "campaigns have"} a durable relationship to this CAT Action. Member records and campaign assignments are not copied.`} className="route-secondary-panel">
        {linkedCampaigns.length ? <DataTable caption="Campaigns linked to this CAT Action" headers={["Campaign", "Open"]}>{linkedCampaigns.map((link) => <tr key={link.handle}><td><strong>{link.campaignName}</strong></td><td><Link className="button secondary" href={`/campaigns/${link.campaignHandle}`}>Open campaign</Link></td></tr>)}</DataTable> : <EmptyState title="No linked campaign" description="Create the durable relationship from a campaign workspace." />}
      </DisclosureCard>

      {fromCampaign ? <DisclosureCard
        title="Campaign context"
        description="This campaign summary is shown here for planning. Opening it did not copy people, assignments, action-readiness responses, or commitments into the CAT Action."
        className="route-secondary-panel campaign-context-panel"
      >
        {sourceCampaignUnavailable || !sourceCampaign ? <UnavailableState title="Campaign context unavailable" description="We couldn’t load the source campaign with your current access. The CAT Action itself is still available and unchanged." /> : <>
          <AlertBanner title={`From campaign: ${sourceCampaign.name}`} tone="preview">Use the campaign progress and action-readiness summary below when deciding what tasks to create. New tasks and responses still require a separate action from an authorized user.</AlertBanner>
          <div className="metrics-grid">
            <StatCard label="Campaign population" value={sourceCampaign.population} detail={sourceCampaign.status} tone="brand" />
            <StatCard label="Assigned" value={sourceCampaign.assigned} detail={`${percent(sourceCampaign.assigned, sourceCampaign.population)}% of population`} />
            <StatCard label="Contacted" value={sourceCampaign.contacted} detail={`${percent(sourceCampaign.contacted, sourceCampaign.population)}% of population`} />
            <StatCard label="Completed" value={sourceCampaign.completed} detail={`${percent(sourceCampaign.completed, sourceCampaign.population)}% of population`} />
            <StatCard label="Remaining" value={sourceCampaign.remaining} detail="Still not completed" tone={sourceCampaign.remaining ? "attention" : "default"} />
          </div>
          <ActionReadinessSummary summary={sourceCampaignReadiness} unavailable={sourceCampaignUnavailable} subject="campaign" />
          <div className="page-actions"><Link className="button secondary" href={`/campaigns/${sourceCampaign.handle}`}>Open full campaign</Link></div>
        </>}
      </DisclosureCard> : null}

      <DisclosureCard title="CAT Action dates and contract cycle" description={`Current action status: ${action.status}.`} className="route-secondary-panel action-reference-panel">
        <DataTable caption="CAT Action details" headers={["Contract cycle", "Cycle status", "Starts", "Ends", "Next open due", "Created"]}>
          <tr>
            <td>{action.contractCycle?.name ?? "No contract cycle"}</td>
            <td>{action.contractCycle?.status ?? "—"}</td>
            <td>{dateOnly(action.contractCycle?.startsOn ?? null)}</td>
            <td>{dateOnly(action.contractCycle?.endsOn ?? null)}</td>
            <td>{dateTime(action.nextDueAt)}</td>
            <td>{dateTime(action.createdAt)}</td>
          </tr>
        </DataTable>
      </DisclosureCard>

      <DisclosureCard title="Edit CAT Action settings" description="Changes are protected by the same access and audit rules as the rest of Engaging Local 801." className="route-secondary-panel record-settings-panel">
        {mutationReady ? <CatActionEditForm
          actionHandle={action.handle}
          initialName={action.name}
          initialStatus={action.status}
          cycles={options!.contractCycles}
        /> : <UnavailableState title="Editing unavailable" description="We couldn’t load the options needed to edit this action." />}
        {mutationReady ? <div className="section-separator">
          <p className="muted">Deletion is available to 801 Administrators, Local Administrators, and System Owners. The CAT Action and its tasks leave operational views while audit history is retained.</p>
          <CatActionDeleteButton actionHandle={action.handle} actionName={action.name} />
        </div> : null}
      </DisclosureCard>
    </>}
  </div></ProtectedPage>;
}
