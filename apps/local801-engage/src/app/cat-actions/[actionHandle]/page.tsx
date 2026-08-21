import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  DataTable,
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
  CatActionArchiveButton,
  CatActionEditForm,
  CatActionTaskCreateForm,
  CatActionTaskEditForm,
} from "@/components/CatActionMutations";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getCatActionManagementOptions } from "@/lib/cat-action-management";
import {
  getCatActionDetail,
  getCatActionTasksPage,
  type CatActionTaskPage,
} from "@/lib/cat-actions";
import { hydrateCatActionDetailFromProtectedPii } from "@/lib/pii-protected-cat-action-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function statusTone(status: string): StatusTone {
  if (status === "active" || status === "complete") return "ready";
  if (status === "draft" || status === "open") return "pending";
  if (status === "closed") return "neutral";
  return "warning";
}

function dateOnly(value: string | null) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function dateTime(value: string | null) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(new Date(value));
}

function taskHref(actionHandle: string, page: CatActionTaskPage, cursor: string) {
  const query = new URLSearchParams({ limit: String(page.pageSize), cursor });
  if (page.term) query.set("q", page.term);
  if (page.status) query.set("status", page.status);
  return `/cat-actions/${actionHandle}?${query}`;
}

export default async function CatActionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ actionHandle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ actionHandle }, input] = await Promise.all([params, searchParams]);
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageCatActions")) redirect("/unauthorized");

  let action: Awaited<ReturnType<typeof getCatActionDetail>> = null;
  let tasks: Awaited<ReturnType<typeof getCatActionTasksPage>> | null = null;
  let options: Awaited<ReturnType<typeof getCatActionManagementOptions>> | null = null;
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

  return <ProtectedPage permission="manageCatActions"><div className="content">
    <PageHeader
      eyebrow="CAT Action"
      title={action?.name ?? "CAT Action"}
      description="Operational action and task management. Restricted strategy content and strategy hashes are not loaded or accepted by these workflows."
      actions={<Link className="button secondary" href="/cat-actions">Back to CAT Actions</Link>}
    />

    {unavailable || !action || !tasks ? <SectionCard><UnavailableState title="CAT action unavailable" description="Action, task, and mutation controls are withheld because an authorized database and protected-PII context could not be established." /></SectionCard> : <>
      <section className="metrics-grid" aria-label="CAT action summary">
        <StatCard label="Status" value={action.status} detail="Current action state" tone="brand" />
        <StatCard label="Tasks" value={action.taskCount} detail="All tasks" />
        <StatCard label="Open" value={action.openTaskCount} detail="Outstanding work" tone="attention" />
        <StatCard label="Completed" value={action.completedTaskCount} detail={`${action.completionRate.toFixed(1)}% complete`} />
        <StatCard label="Overdue" value={action.overdueTaskCount} detail="Open and past due" tone={action.overdueTaskCount ? "danger" : "default"} />
        <StatCard label="Assigned users" value={action.assignedUserCount} detail="Distinct task assignees" />
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

      <SectionCard title="Manage action" description="Changes are Preview-only, same-origin protected, organization scoped, and written atomically with a durable audit event.">
        {mutationReady ? <CatActionEditForm
          actionHandle={action.handle}
          initialName={action.name}
          initialStatus={action.status}
          cycles={options!.contractCycles}
        /> : <UnavailableState title="Action editing unavailable" description="Authorized management options could not be loaded." />}
        {action.status === "closed" && mutationReady ? <div style={{ marginTop: 16 }}><CatActionArchiveButton actionHandle={action.handle} actionName={action.name} /></div> : null}
      </SectionCard>

      {action.status !== "closed" ? <SectionCard title="Create task" description="Create an operational task with an optional CAT organizer and due date. Strategy notes are not accepted here."
        badge={protectedReadEnabled ? <StatusBadge tone="preview">Protected PII</StatusBadge> : undefined}>
        {mutationReady ? <CatActionTaskCreateForm actionHandle={action.handle} assignees={options!.assignees} />
          : <UnavailableState title="Task creation unavailable" description="Authorized assignee options could not be loaded." />}
      </SectionCard> : null}

      <SectionCard title="Task filters" description="Task search remains server-side, organization-scoped, and bounded.">
        <form action={`/cat-actions/${action.handle}`} method="get">
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
              <label htmlFor="cat-task-limit">Rows</label>
              <select id="cat-task-limit" name="limit" defaultValue={String(tasks.pageSize)}>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </div>
            <button className="button" type="submit">Update tasks</button>
          </FilterBar>
        </form>
      </SectionCard>

      <section className="metrics-grid" aria-label="Filtered task summary">
        <StatCard label="Matching tasks" value={tasks.total} detail="Current task filters" tone="brand" />
        <StatCard label="Open" value={tasks.summary.open} detail="Matching open tasks" />
        <StatCard label="Complete" value={tasks.summary.complete} detail="Matching completed tasks" />
        <StatCard label="Overdue" value={tasks.summary.overdue} detail="Matching open tasks past due" tone={tasks.summary.overdue ? "danger" : "default"} />
        <StatCard label="Unassigned" value={tasks.summary.unassigned} detail="No current assignee record" tone="attention" />
      </section>

      <SectionCard title="Tasks" badge={<StatusBadge tone="info">{protectedReadEnabled ? `Protected PII · ${tasks.total} matching` : `${tasks.total} matching`}</StatusBadge>}>
        {tasks.tasks.length === 0 ? <EmptyState title="No matching tasks" description="No CAT action tasks match the current filters." /> : <>
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
            nextHref={tasks.nextCursor ? taskHref(action.handle, tasks, tasks.nextCursor) : null}
          />
        </>}
      </SectionCard>
    </>}
  </div></ProtectedPage>;
}
