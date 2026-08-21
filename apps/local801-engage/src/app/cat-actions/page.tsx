import Link from "next/link";
import { redirect } from "next/navigation";
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
import { CatActionCreateForm } from "@/components/CatActionMutations";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getCatActionManagementOptions } from "@/lib/cat-action-management";
import { getCatActionsPage, type CatActionPortfolioPage } from "@/lib/cat-actions";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function statusTone(status: string): StatusTone {
  if (status === "active") return "ready";
  if (status === "draft") return "pending";
  if (status === "closed") return "neutral";
  return "warning";
}

function dateTime(value: string | null) {
  if (!value) return "No open deadline";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(new Date(value));
}

function href(page: CatActionPortfolioPage, cursor: string) {
  const query = new URLSearchParams({ limit: String(page.pageSize), cursor });
  if (page.term) query.set("q", page.term);
  if (page.status) query.set("status", page.status);
  return `/cat-actions?${query}`;
}

export default async function CatActionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageCatActions")) redirect("/unauthorized");

  const input = await searchParams;
  let page: Awaited<ReturnType<typeof getCatActionsPage>> | null = null;
  let options: Awaited<ReturnType<typeof getCatActionManagementOptions>> | null = null;
  try {
    const context = await resolveWorkspaceContext(user);
    [page, options] = await Promise.all([
      getCatActionsPage(context, {
        term: input.q,
        status: input.status,
        pageSize: input.limit,
        cursor: input.cursor,
      }),
      getCatActionManagementOptions(context),
    ]);
  } catch {
    // Fail closed. No synthetic CAT action data or mutation options are substituted.
  }

  return <ProtectedPage permission="manageCatActions"><div className="content">
    <PageHeader
      eyebrow="Organizing"
      title="CAT Actions"
      description="Operational CAT action workload, owners, due dates, and completion from the organization-scoped database. Strategy content remains outside this view."
    />

    <SectionCard title="Create CAT action" description="Creates only the operational action shell. Restricted strategy content is not accepted by this workflow.">
      {options ? <CatActionCreateForm cycles={options.contractCycles} />
        : <UnavailableState title="Action creation unavailable" description="Creation controls are withheld because authorized management options could not be loaded." />}
    </SectionCard>

    <SectionCard title="Action filters" description="Search and pagination are performed on the server and remain bounded to the authorized organization.">
      <form action="/cat-actions" method="get">
        <FilterBar>
          <div className="field">
            <label htmlFor="cat-action-search">Search actions</label>
            <input id="cat-action-search" name="q" type="search" maxLength={100} defaultValue={page?.term ?? ""} placeholder="Action or contract cycle" />
          </div>
          <div className="field">
            <label htmlFor="cat-action-status">Status</label>
            <select id="cat-action-status" name="status" defaultValue={page?.status ?? ""}>
              <option value="">Active, draft, and closed</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="cat-action-limit">Rows</label>
            <select id="cat-action-limit" name="limit" defaultValue={String(page?.pageSize ?? 25)}>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
          <button className="button" type="submit">Update actions</button>
        </FilterBar>
      </form>
    </SectionCard>

    {page ? <section className="metrics-grid" aria-label="CAT action workload summary">
      <StatCard label="Actions" value={page.total} detail="Current filters" tone="brand" />
      <StatCard label="Active" value={page.summary.activeActions} detail="Active CAT actions" />
      <StatCard label="Open tasks" value={page.summary.openTasks} detail="Outstanding work" tone="attention" />
      <StatCard label="Completed tasks" value={page.summary.completedTasks} detail="Completed work" />
      <StatCard label="Overdue tasks" value={page.summary.overdueTasks} detail="Open and past due" tone={page.summary.overdueTasks ? "danger" : "default"} />
    </section> : null}

    <SectionCard title="Action portfolio" badge={<StatusBadge tone={page ? "info" : "warning"}>{page ? `${page.total} actions` : "Unavailable"}</StatusBadge>}>
      {!page ? <UnavailableState title="CAT actions unavailable" description="No CAT action or task details are shown because an authorized database context could not be established." />
        : page.actions.length === 0 ? <EmptyState title="No matching CAT actions" description="No active, draft, or closed CAT actions match the current filters." />
        : <>
          <DataTable caption="CAT action portfolio" headers={["Action", "Cycle", "Tasks", "Open", "Completed", "Overdue", "Assigned", "Next due"]}>
            {page.actions.map((action) => <tr key={action.handle}>
              <td>
                <strong><Link href={`/cat-actions/${action.handle}`}>{action.name}</Link></strong>
                <div><StatusBadge tone={statusTone(action.status)}>{action.status}</StatusBadge></div>
              </td>
              <td>{action.contractCycleName ?? "No contract cycle"}</td>
              <td>{action.taskCount}</td>
              <td>{action.openTaskCount}</td>
              <td>{action.completedTaskCount} <span className="muted">({action.completionRate.toFixed(1)}%)</span></td>
              <td>{action.overdueTaskCount ? <StatusBadge tone="danger">{action.overdueTaskCount}</StatusBadge> : "0"}</td>
              <td>{action.assignedUserCount}</td>
              <td>{dateTime(action.nextDueAt)}</td>
            </tr>)}
          </DataTable>
          <Pagination
            label={`Showing up to ${page.pageSize} of ${page.total} actions`}
            nextHref={page.nextCursor ? href(page, page.nextCursor) : null}
          />
        </>}
    </SectionCard>
  </div></ProtectedPage>;
}
