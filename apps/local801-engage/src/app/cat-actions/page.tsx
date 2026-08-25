import Link from "next/link";
import { redirect } from "next/navigation";
import {
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
import { CatActionCreateForm } from "@/components/CatActionMutations";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getCatActionManagementOptions } from "@/lib/cat-action-management";
import { getCatActionsPage, type CatActionPortfolioPage } from "@/lib/cat-actions";
import { formatCatDateTime } from "@/lib/date-format";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function statusTone(status: string): StatusTone {
  if (status === "active") return "ready";
  if (status === "draft") return "pending";
  if (status === "closed") return "neutral";
  return "warning";
}

function dateTime(value: string | null) {
  return formatCatDateTime(value, "No open deadline");
}

function href(page: CatActionPortfolioPage, cursor: string | null) {
  const query = new URLSearchParams({ limit: String(page.pageSize) });
  if (cursor) query.set("cursor", cursor);
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
  const hasCursor = typeof input.cursor === "string" && input.cursor.length > 0;
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
    // Fail closed. No placeholder CAT action data or mutation options are substituted.
  }

  return <ProtectedPage permission="manageCatActions"><div className="content route-cat-actions-page queue-first-page">
    <PageHeader
      eyebrow="Programs"
      title="CAT Actions"
      description="Plan CAT work, assign tasks, and keep an eye on due dates and completion."
    />

    <DisclosureCard
      title="Filter CAT Actions"
      description="Search by action or contract cycle and narrow the list by status."
      defaultOpen={Boolean(page?.term || page?.status)}
      className="route-secondary-panel queue-filter-panel"
    >
      <form action="/cat-actions" method="get">
        <FilterBar>
          <div className="field">
            <label htmlFor="cat-action-search">Search</label>
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
            <label htmlFor="cat-action-limit">Results per page</label>
            <select id="cat-action-limit" name="limit" defaultValue={String(page?.pageSize ?? 25)}>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
          <button className="button" type="submit">Apply filters</button>
        </FilterBar>
      </form>
    </DisclosureCard>

    {page ? <section className="metrics-grid" aria-label="CAT Action summary">
      <StatCard label="Actions" value={page.total} detail="Current filters" tone="brand" />
      <StatCard label="Active" value={page.summary.activeActions} detail="Active CAT Actions" />
      <StatCard label="Open tasks" value={page.summary.openTasks} detail="Still to do" tone="attention" />
      <StatCard label="Completed tasks" value={page.summary.completedTasks} detail="Finished work" />
      <StatCard label="Overdue tasks" value={page.summary.overdueTasks} detail="Open and past due" tone={page.summary.overdueTasks ? "danger" : "default"} />
    </section> : null}

    <SectionCard title="CAT Action work records" description={page ? `${page.total} ${page.total === 1 ? "action matches" : "actions match"} the current filters.` : "The action list could not be loaded safely."}>
      {!page ? <UnavailableState title="CAT Actions unavailable" description="We couldn’t load CAT Action or task details safely." action={<Link className="button secondary" href="/cat-actions">Try again</Link>} />
        : page.actions.length === 0 ? <EmptyState title={page.term || page.status ? "No matching CAT Actions" : "No CAT Actions yet"} description={page.term || page.status ? "No CAT Actions match the filters you chose." : "Create the first CAT Action to start assigning and tracking work."} action={page.term || page.status ? <Link className="button secondary" href="/cat-actions">Clear filters</Link> : <a className="button" href="#create-cat-action">Create first CAT Action</a>} />
        : <>
          <DataTable caption="CAT Actions" headers={["Action", "Cycle", "Workload", "Completed", "Next due"]}>
            {page.actions.map((action) => <tr key={action.handle}>
              <td>
                <strong><Link href={`/cat-actions/${action.handle}`}>{action.name}</Link></strong>
                <div><StatusBadge tone={statusTone(action.status)}>{action.status}</StatusBadge></div>
              </td>
              <td>{action.contractCycleName ?? "No contract cycle"}</td>
              <td>
                <strong>{action.openTaskCount} open</strong>
                <div className="muted">{action.taskCount} total · {action.assignedUserCount} assigned</div>
                {action.overdueTaskCount ? <div><StatusBadge tone="danger">{action.overdueTaskCount} overdue</StatusBadge></div> : null}
              </td>
              <td>{action.completedTaskCount} <span className="muted">({action.completionRate.toFixed(1)}%)</span></td>
              <td>{dateTime(action.nextDueAt)}</td>
            </tr>)}
          </DataTable>
          <Pagination
            label={`Showing up to ${page.pageSize} of ${page.total} actions`}
            historyBackFallbackHref={hasCursor ? href(page, null) : null}
            nextHref={page.nextCursor ? href(page, page.nextCursor) : null}
          />
        </>}
    </SectionCard>

    <div id="create-cat-action">
      <DisclosureCard title="Create a CAT Action" description="Create the work record here; restricted strategy stays in its protected area." className="route-secondary-panel create-record-panel">
        {options ? <CatActionCreateForm cycles={options.contractCycles} />
          : <UnavailableState title="Action creation unavailable" description="We couldn’t load the options needed to create a CAT Action." />}
      </DisclosureCard>
    </div>
  </div></ProtectedPage>;
}
