import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  CampaignArchiveButton,
  CampaignAssignmentForm,
  CampaignEditForm,
} from "@/components/CampaignMutations";
import {
  CampaignPopulationAddButton,
  CampaignPopulationRemoveButton,
} from "@/components/CampaignPopulationMutations";
import {
  DataTable,
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
import { getPreviewUser } from "@/lib/authz.server";
import { getCampaignManagementOptions } from "@/lib/campaign-management";
import { getCampaignPopulationCandidates } from "@/lib/campaign-population-management";
import { getCampaignDetail, getCampaignPopulationPage } from "@/lib/campaigns";
import { hydrateCampaignDetailFromProtectedPii } from "@/lib/pii-protected-campaign-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function populationHref(campaignHandle: string, pageSize: number, cursor: string) {
  const query = new URLSearchParams({ limit: String(pageSize), cursor });
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

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignHandle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ campaignHandle }, input] = await Promise.all([params, searchParams]);
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageCampaigns")) redirect("/unauthorized");

  const candidateTerm = scalar(input.candidate_q).trim();
  let campaign: Awaited<ReturnType<typeof getCampaignDetail>> = null;
  let population: Awaited<ReturnType<typeof getCampaignPopulationPage>> | null = null;
  let options: Awaited<ReturnType<typeof getCampaignManagementOptions>> | null = null;
  let candidates: Awaited<ReturnType<typeof getCampaignPopulationCandidates>> | null = null;
  let candidateUnavailable = false;
  let unavailable = false;
  let protectedReadEnabled = false;

  try {
    const context = await resolveWorkspaceContext(user);
    campaign = await getCampaignDetail(context, campaignHandle);
    if (campaign) {
      [population, options] = await Promise.all([
        getCampaignPopulationPage(context, campaignHandle, { cursor: input.cursor, pageSize: input.limit }),
        getCampaignManagementOptions(context),
      ]);
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
      });
      population = hydrated.population;
      options = hydrated.options;
      candidates = hydrated.candidates;
      protectedReadEnabled = isPiiProtectedReadEnabled();
    }
  } catch {
    unavailable = true;
  }

  if (!unavailable && !campaign) notFound();

  return <ProtectedPage permission="manageCampaigns"><div className="content">
    <PageHeader
      eyebrow="Organizing"
      title={campaign?.name ?? "Campaign"}
      description="Manage the campaign lifecycle, build the draft population, and assign participants to CAT organizers through audited controls."
      actions={<Link className="button secondary" href="/campaigns">Back to campaigns</Link>}
    />

    {unavailable || !campaign || !population || !options ? (
      <SectionCard>
        <UnavailableState title="Campaign unavailable" description="Campaign data is withheld because an authorized database and protected-PII context could not be established." />
      </SectionCard>
    ) : <>
      <section className="metrics-grid" aria-label="Campaign summary">
        <StatCard label="Population" value={campaign.population} detail={campaign.status === "draft" ? "Draft population" : "Frozen campaign population"} tone="brand" />
        <StatCard label="Assigned" value={campaign.assigned} detail="Distinct participants assigned" />
        <StatCard label="Contacted" value={campaign.contacted} detail="Distinct participants with engagement" />
        <StatCard label="Completed" value={campaign.completed} detail={`${campaign.completionPercentage}% of population`} />
        <StatCard label="Remaining" value={campaign.remaining} detail="Population minus completed" tone="attention" />
      </section>

      <SectionCard
        title="Campaign settings"
        description={dateRange(campaign.startsOn, campaign.endsOn)}
        badge={<StatusBadge tone={campaign.status === "active" ? "ready" : campaign.status === "closed" ? "neutral" : "pending"}>{campaign.status}</StatusBadge>}
      >
        {campaign.status === "closed" ? (
          <div className="grid">
            <p className="muted">This campaign is closed. Operational fields and participant assignments are read-only; archive it when the record no longer belongs in active campaign views.</p>
            <CampaignArchiveButton campaignHandle={campaign.handle} campaignName={campaign.name} />
          </div>
        ) : (
          <div className="grid">
            {campaign.status === "draft" ? <p className="muted">Add or remove participants before activation. Activating the campaign freezes its population so later outreach history remains tied to the population that was actually launched.</p> : null}
            <CampaignEditForm
              campaignHandle={campaign.handle}
              initialName={campaign.name}
              initialStatus={campaign.status}
              initialStartsOn={campaign.startsOn}
              initialEndsOn={campaign.endsOn}
            />
          </div>
        )}
      </SectionCard>

      {campaign.status === "draft" ? (
        <SectionCard
          title="Build campaign population"
          description="Search active Local 801 employees who are not already in this draft campaign. Results are bounded and exclude contact details."
          badge={<StatusBadge tone="preview">{protectedReadEnabled ? "Protected PII · Draft only" : "Draft only"}</StatusBadge>}
        >
          <form method="get" className="grid">
            <div className="field">
              <label htmlFor="candidate_q">Find employee</label>
              <input id="candidate_q" name="candidate_q" defaultValue={candidateTerm} maxLength={100} placeholder="Name, department, classification, or work location" />
            </div>
            <button className="button secondary" type="submit">Search employees</button>
          </form>

          {candidateUnavailable ? (
            <UnavailableState title="Candidate search unavailable" description="No candidate results are shown because the authorized search could not be completed safely." />
          ) : candidateTerm && candidates?.candidates.length === 0 ? (
            <EmptyState title="No available matches" description="No active employee matching that search is available to add to this draft campaign." />
          ) : candidates && candidates.candidates.length > 0 ? (
            <DataTable caption="Employees available to add" headers={["Employee", "Department", "Classification", "Work location", "Action"]}>
              {candidates.candidates.map((candidate) => <tr key={candidate.personHandle}>
                <td><strong>{candidate.displayName}</strong></td>
                <td>{candidate.department || "—"}</td>
                <td>{candidate.classification || "—"}</td>
                <td>{candidate.workLocation || "—"}</td>
                <td><CampaignPopulationAddButton campaignHandle={campaign.handle} personHandle={candidate.personHandle} /></td>
              </tr>)}
            </DataTable>
          ) : <p className="muted">Search to add people to the draft population.</p>}
        </SectionCard>
      ) : null}

      <SectionCard
        title="Participants"
        description={campaign.status === "draft"
          ? "Draft participants can still be removed if they have no campaign engagement or completed assignment."
          : "The population is frozen. Organizer ownership and due dates can change while the campaign remains active."}
        badge={<StatusBadge tone="info">{protectedReadEnabled ? `Protected PII · ${population.total} total` : `${population.total} total`}</StatusBadge>}
      >
        {population.people.length === 0 ? (
          <EmptyState title="No campaign participants" description={campaign.status === "draft" ? "Use the population search above to add employees before activation." : "No active people are included in this campaign population."} />
        ) : <>
          <DataTable caption={`${campaign.name} participants`} headers={["Person", "Department", "Assignment", "Organizer", "Due", "Actions"]}>
            {population.people.map((person) => <tr key={person.personHandle}>
              <td>
                <strong>{person.first_name} {person.last_name}</strong>
                <div><Link href={`/outreach/${person.personHandle}`}>Open employee</Link></div>
              </td>
              <td>{person.department || "Department unavailable"}</td>
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
            nextHref={population.nextCursor ? populationHref(campaignHandle, population.pageSize, population.nextCursor) : null}
          />
        </>}
      </SectionCard>
    </>}
  </div></ProtectedPage>;
}
