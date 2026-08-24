import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActionReadinessSummary } from "@/components/ActionReadinessSummary";
import { CampaignBulkOperations } from "@/components/CampaignBulkOperations";
import { CampaignCatLinks } from "@/components/CampaignCatLinks";
import {
  CampaignDeleteButton,
  CampaignAssignmentForm,
  CampaignEditForm,
} from "@/components/CampaignMutations";
import {
  CampaignPopulationAddButton,
  CampaignPopulationRemoveButton,
} from "@/components/CampaignPopulationMutations";
import {
  AlertBanner,
  DataTable,
  DisclosureCard,
  EmptyState,
  PageHeader,
  Pagination,
  SectionCard,
  StatCard,
  StatusBadge,
  UnavailableState,
} from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getCampaignActionReadiness } from "@/lib/action-readiness-summary";
import { getPreviewUser } from "@/lib/authz.server";
import { getCampaignManagementOptions } from "@/lib/campaign-management";
import { listCampaignCatLinks } from "@/lib/campaign-cat-links";
import { getCampaignPopulationCandidates } from "@/lib/campaign-population-management";
import { getCampaignDetail, getCampaignOrganizerProgress, getCampaignPopulationPage } from "@/lib/campaigns";
import { getCatActionsPage, type CatActionPortfolioItem } from "@/lib/cat-actions";
import { hydrateCampaignDetailFromProtectedPii } from "@/lib/pii-protected-campaign-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function populationHref(campaignHandle: string, pageSize: number, cursor: string | null, assignment: string, workflow: string) {
  const query = new URLSearchParams({ limit: String(pageSize), assignment, workflow });
  if (cursor) query.set("cursor", cursor);
  return `/campaigns/${campaignHandle}?${query}`;
}

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function dueLabel(value: string | null) {
  if (!value) return "No due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Due date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(date);
}

function dateRange(startsOn: string | null, endsOn: string | null) {
  if (!startsOn && !endsOn) return "No campaign dates set";
  if (startsOn && endsOn) return `${startsOn} through ${endsOn}`;
  return startsOn ? `Starts ${startsOn}` : `Ends ${endsOn}`;
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((Math.min(value, total) / total) * 1000) / 10);
}

function handoffHref(action: CatActionPortfolioItem, campaignHandle: string) {
  const query = new URLSearchParams({ fromCampaign: campaignHandle });
  return `/cat-actions/${action.handle}?${query}`;
}

function campaignTimingAlert(status: string, endsOn: string | null) {
  if (status !== "active" || !endsOn) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return endsOn < today ? "The campaign end date has passed. Review what’s left, record final outcomes, and close the campaign when the work is done." : null;
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignHandle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ campaignHandle }, input] = await Promise.all([params, searchParams]);
  const hasCursor = typeof input.cursor === "string" && input.cursor.length > 0;
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageCampaigns")) redirect("/unauthorized");

  const candidateTerm = scalar(input.candidate_q).trim();
  const assignmentFilter = scalar(input.assignment);
  const workflowFilter = scalar(input.workflow);
  let campaign: Awaited<ReturnType<typeof getCampaignDetail>> = null;
  let population: Awaited<ReturnType<typeof getCampaignPopulationPage>> | null = null;
  let options: Awaited<ReturnType<typeof getCampaignManagementOptions>> | null = null;
  let organizerProgress: Awaited<ReturnType<typeof getCampaignOrganizerProgress>> = [];
  let readiness: Awaited<ReturnType<typeof getCampaignActionReadiness>> | null = null;
  let readinessUnavailable = false;
  let candidates: Awaited<ReturnType<typeof getCampaignPopulationCandidates>> | null = null;
  let candidateUnavailable = false;
  let catActionTargets: CatActionPortfolioItem[] = [];
  let durableCatLinks: Awaited<ReturnType<typeof listCampaignCatLinks>> = [];
  let handoffUnavailable = false;
  let unavailable = false;
  let protectedReadEnabled = false;

  try {
    const context = await resolveWorkspaceContext(user);
    campaign = await getCampaignDetail(context, campaignHandle);
    if (campaign) {
      [population, options, organizerProgress] = await Promise.all([
        getCampaignPopulationPage(context, campaignHandle, { cursor: input.cursor, pageSize: input.limit,
          assignment: assignmentFilter, workflow: workflowFilter }),
        getCampaignManagementOptions(context),
        getCampaignOrganizerProgress(context, campaignHandle),
      ]);
      try {
        readiness = await getCampaignActionReadiness(context, campaignHandle);
      } catch {
        readinessUnavailable = true;
      }
      if (campaign.status !== "draft" && can(user.role, "manageCatActions")) {
        try {
          const [targets, links] = await Promise.all([
            getCatActionsPage(context, { pageSize: 100 }),
            listCampaignCatLinks(context, campaignHandle),
          ]);
          catActionTargets = targets.actions.filter((action) => action.status !== "closed");
          durableCatLinks = links;
        } catch {
          handoffUnavailable = true;
        }
      }
      if (campaign.status === "draft" && candidateTerm) {
        try {
          candidates = await getCampaignPopulationCandidates(context, campaignHandle, candidateTerm);
        } catch {
          candidateUnavailable = true;
        }
      }
      const hydrated = await hydrateCampaignDetailFromProtectedPii(context.organizationId, campaignHandle, {
        population,
        options,
        candidates,
        organizerProgress,
      });
      population = hydrated.population;
      options = hydrated.options;
      candidates = hydrated.candidates;
      organizerProgress = hydrated.organizerProgress;
      protectedReadEnabled = isPiiProtectedReadEnabled();
    }
  } catch {
    unavailable = true;
  }

  if (!unavailable && !campaign) notFound();

  const assignmentRate = campaign ? percent(campaign.assigned, campaign.population) : 0;
  const contactRate = campaign ? percent(campaign.contacted, campaign.population) : 0;
  const completionRate = campaign ? percent(campaign.completed, campaign.population) : 0;
  const unassigned = campaign?.unassigned ?? 0;
  const notContacted = campaign ? Math.max(0, campaign.population - campaign.contacted) : 0;
  const timingAlert = campaign ? campaignTimingAlert(campaign.status, campaign.endsOn) : null;

  return <ProtectedPage permission="manageCampaigns"><div className="content route-campaign-detail-page record-workspace-page">
    <PageHeader
      eyebrow="Campaigns"
      title={campaign?.name ?? "Campaign"}
      description="Build the campaign list, assign people, follow contact and completion, and carry useful context into CAT Action planning."
      actions={<Link className="button secondary" href="/campaigns">Back to campaigns</Link>}
    />

    {unavailable || !campaign || !population || !options ? (
      <SectionCard>
        <UnavailableState title="Campaign unavailable" description="We couldn’t safely load this campaign and its protected member information." />
      </SectionCard>
    ) : <>
      {timingAlert ? <AlertBanner title="Campaign end date passed" tone="warning">{timingAlert}</AlertBanner> : null}

      <section className="metrics-grid" aria-label="Campaign summary">
        <StatCard label="Population" value={campaign.population} detail={campaign.status === "draft" ? "Draft list" : "Campaign list"} tone="brand" />
        <StatCard label="Assigned" value={campaign.assigned} detail={`${assignmentRate}% of population`} />
        <StatCard label="Contacted" value={campaign.contacted} detail={`${contactRate}% of population`} />
        <StatCard label="Completed" value={campaign.completed} detail={`${completionRate}% of population`} />
        <StatCard label="Unassigned" value={campaign.unassigned} detail="Needs an organizer" tone={campaign.unassigned > 0 ? "attention" : "default"} />
        <StatCard label="Overdue" value={campaign.overdue} detail="Open assignments past due" tone={campaign.overdue > 0 ? "attention" : "default"} />
        <StatCard label="Remaining" value={campaign.remaining} detail="Still not completed" tone="attention" />
      </section>

      <SectionCard
        title="Campaign operations"
        description="Build a server-derived draft population or assign a bounded group. Every bulk change requires a live count preview and a second confirmation."
      >
        <CampaignBulkOperations campaignHandle={campaign.handle} status={campaign.status} assignees={options.assignees} />
      </SectionCard>

      <SectionCard
        title="People in this campaign"
        description={`${population.total} ${population.total === 1 ? "person matches" : "people match"} the current filters. ${campaign.status === "draft"
          ? "People can still be removed from the draft if they have no campaign contact or completed assignment."
          : "The campaign list is frozen. Organizer assignments and due dates can still change while the campaign is active."}`}
        badge={protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
      >
        <form method="get" className="form-grid campaign-operation-filters">
          <div className="field"><label htmlFor="campaign-assignment-filter">Assignment</label><select id="campaign-assignment-filter" name="assignment" defaultValue={population.filters.assignment}><option value="all">All</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option></select></div>
          <div className="field"><label htmlFor="campaign-workflow-filter">Workflow</label><select id="campaign-workflow-filter" name="workflow" defaultValue={population.filters.workflow}><option value="all">All</option><option value="not_contacted">Not contacted</option><option value="contacted">Contacted</option><option value="completed">Completed</option><option value="overdue">Overdue</option></select></div>
          <div className="field"><label htmlFor="campaign-page-size">Rows</label><select id="campaign-page-size" name="limit" defaultValue={String(population.pageSize)}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></div>
          <div className="form-actions"><button className="button secondary" type="submit">Apply filters</button></div>
        </form>
        {population.people.length === 0 ? (
          <EmptyState title={campaign.population > 0 ? "No participants match these filters" : "No one in this campaign"} description={campaign.population > 0 ? "Change the assignment or workflow filters to see other participants." : campaign.status === "draft" ? "Use Campaign operations to build this draft population before activation." : "No active people are included in this campaign."} />
        ) : <>
          <DataTable caption={`${campaign.name} participants`} headers={["Person", "Department", "Workflow", "Assignment", "Organizer", "Due", "Actions"]}>
            {population.people.map((person) => <tr key={person.personHandle}>
              <td>
                <strong>{person.first_name} {person.last_name}</strong>
                <div><Link href={`/outreach/${person.personHandle}`}>Open outreach record</Link></div>
              </td>
              <td>{person.department || "Department unavailable"}</td>
              <td><StatusBadge tone={person.completed ? "ready" : person.overdue ? "warning" : person.contacted ? "info" : "neutral"}>{person.completed ? "Completed" : person.overdue ? "Overdue" : person.contacted ? "Contacted" : "Not contacted"}</StatusBadge></td>
              <td>
                <StatusBadge tone={person.assignment_status === "completed" ? "ready" : person.assignment_status ? "pending" : "neutral"}>
                  {person.assignment_status?.replaceAll("_", " ") ?? "Unassigned"}
                </StatusBadge>
              </td>
              <td>{person.assignee_name || "Unassigned"}</td>
              <td>{dueLabel(person.assignment_due_at)}</td>
              <td>
                <div className="grid">
                  {campaign.status !== "closed" && person.assignment_status !== "completed" ? (
                    <CampaignAssignmentForm
                      campaignHandle={campaign.handle}
                      personHandle={person.personHandle}
                      currentAssigneeName={person.assignee_name}
                      currentDueAt={person.assignment_due_at}
                      assignees={options.assignees}
                    />
                  ) : <span className="muted">Assignment read-only</span>}
                  {campaign.status === "draft" && person.assignment_status !== "completed" ? (
                    <CampaignPopulationRemoveButton
                      campaignHandle={campaign.handle}
                      personHandle={person.personHandle}
                      displayName={`${person.first_name} ${person.last_name}`}
                    />
                  ) : null}
                </div>
              </td>
            </tr>)}
          </DataTable>
          <Pagination
            label={`Showing up to ${population.pageSize} of ${population.total}`}
            historyBackFallbackHref={hasCursor ? populationHref(campaignHandle, population.pageSize, null, population.filters.assignment, population.filters.workflow) : null}
            nextHref={population.nextCursor ? populationHref(campaignHandle, population.pageSize, population.nextCursor, population.filters.assignment, population.filters.workflow) : null}
          />
        </>}
      </SectionCard>

      <DisclosureCard
        title="Campaign progress"
        description="These percentages come directly from the recorded campaign list and work. They are progress measures, not member scores or predictions."
        className="route-secondary-panel campaign-progress-panel"
      >
        <div className="metrics-grid">
          <StatCard label="Assignment coverage" value={`${assignmentRate}%`} detail={`${unassigned} person${unassigned === 1 ? "" : "s"} not assigned`} tone={unassigned > 0 ? "attention" : "default"} />
          <StatCard label="Contact coverage" value={`${contactRate}%`} detail={`${notContacted} person${notContacted === 1 ? "" : "s"} without recorded campaign contact`} tone={notContacted > 0 ? "attention" : "default"} />
          <StatCard label="Completion" value={`${completionRate}%`} detail={`${campaign.remaining} person${campaign.remaining === 1 ? "" : "s"} not completed`} />
        </div>
        <p className="muted">Real work doesn’t always happen in a perfect sequence. For example, someone may be contacted before a formal campaign assignment is entered. The recorded counts remain the source of truth.</p>
        {organizerProgress.length > 0 ? <DataTable caption="Progress by current organizer" headers={["Organizer", "Assigned", "Open", "Completed", "Overdue"]}>
          {organizerProgress.map((item) => <tr key={item.assigneeHandle}><td><strong>{item.assigneeName}</strong></td><td>{item.assigned}</td><td>{item.open}</td><td>{item.completed}</td><td>{item.overdue}</td></tr>)}
        </DataTable> : <p className="muted">No current organizer assignments are recorded.</p>}
      </DisclosureCard>

      <ActionReadinessSummary summary={readiness} unavailable={readinessUnavailable} subject="campaign" />

      {campaign.status !== "draft" ? <DisclosureCard
        title="Campaign-linked CAT Actions"
        description="Create a durable relationship to the CAT Actions that carry this campaign into action planning. This does not copy people, assignments, responses, or commitments."
        className="route-secondary-panel campaign-handoff-panel"
      >
        {handoffUnavailable ? <UnavailableState title="CAT Action handoff unavailable" description="We couldn’t load the CAT Actions you can use. This campaign has not changed." />
          : <CampaignCatLinks campaignHandle={campaign.handle} links={durableCatLinks} actions={catActionTargets.map((action) => ({ handle: action.handle, name: action.name, status: action.status }))} />}
        {catActionTargets.length ? <DataTable caption="Available CAT Actions" headers={["CAT Action", "Status", "Open tasks", "Overdue", "Open"]}>
          {catActionTargets.map((action) => <tr key={action.handle}>
            <td><strong>{action.name}</strong><div className="muted">{action.contractCycleName ?? "No contract cycle"}</div></td>
            <td><StatusBadge tone={action.status === "active" ? "ready" : "pending"}>{action.status}</StatusBadge></td>
            <td>{action.openTaskCount}</td><td>{action.overdueTaskCount}</td>
            <td><Link className="button secondary" href={handoffHref(action, campaign.handle)}>Open with campaign context</Link></td>
          </tr>)}
        </DataTable> : <EmptyState title="No open CAT Action" description="Create or reopen a CAT Action before carrying this campaign into task planning." />}
        <p className="muted">Links are organization-scoped, auditable, and remain available across sessions. The CAT Action still owns its tasks and restricted strategy content.</p>
      </DisclosureCard> : null}

      <DisclosureCard title="Campaign settings" description={`${dateRange(campaign.startsOn, campaign.endsOn)} · Current status: ${campaign.status}.`} className="route-secondary-panel record-settings-panel">
        {campaign.status === "closed" ? (
          <div className="grid">
            <p className="muted">This campaign is closed. Its main fields and participant assignments are read-only.</p>
          </div>
        ) : (
          <div className="grid">
            {campaign.status === "draft" ? <p className="muted">You can add or remove people while the campaign is still a draft. Once activated, the campaign list is frozen so its outreach history stays tied to the people who were actually included.</p> : null}
            <CampaignEditForm
              campaignHandle={campaign.handle}
              initialName={campaign.name}
              initialStatus={campaign.status}
              initialStartsOn={campaign.startsOn}
              initialEndsOn={campaign.endsOn}
            />
          </div>
        )}
        <div className="section-separator">
          <p className="muted">Deletion is available to 801 Administrators, Local Administrators, and System Owners. The campaign leaves operational views while its audit history is retained.</p>
          <CampaignDeleteButton campaignHandle={campaign.handle} campaignName={campaign.name} />
        </div>
      </DisclosureCard>

      {campaign.status === "draft" ? (
        <DisclosureCard
          title="Add people to this draft"
          description="Search active Local 801 employees who are not already in this draft. Contact details are not shown in these search results."
          badge={protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
          defaultOpen={Boolean(candidateTerm)}
          className="route-secondary-panel campaign-population-add-panel"
        >
          <form method="get" className="grid">
            <div className="field">
              <label htmlFor="candidate_q">Find a person</label>
              <input id="candidate_q" name="candidate_q" defaultValue={candidateTerm} maxLength={100} placeholder="Name, department, classification, or work location" />
            </div>
            <button className="button secondary" type="submit">Search</button>
          </form>

          {candidateUnavailable ? (
            <UnavailableState title="Search unavailable" description="We couldn’t complete the protected member search safely, so no results are shown." />
          ) : candidateTerm && candidates?.candidates.length === 0 ? (
            <EmptyState title="No available matches" description="No active person matching that search is available to add to this draft campaign." />
          ) : candidates && candidates.candidates.length > 0 ? (
            <DataTable caption="People available to add" headers={["Person", "Department", "Classification", "Work location", "Action"]}>
              {candidates.candidates.map((candidate) => <tr key={candidate.personHandle}>
                <td><strong>{candidate.displayName}</strong></td>
                <td>{candidate.department || "—"}</td>
                <td>{candidate.classification || "—"}</td>
                <td>{candidate.workLocation || "—"}</td>
                <td><CampaignPopulationAddButton campaignHandle={campaign.handle} personHandle={candidate.personHandle} /></td>
              </tr>)}
            </DataTable>
          ) : <p className="muted">Search to add people to the draft campaign.</p>}
        </DisclosureCard>
      ) : null}
    </>}
  </div></ProtectedPage>;
}
