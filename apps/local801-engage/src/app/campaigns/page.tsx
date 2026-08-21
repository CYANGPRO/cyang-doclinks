import Link from "next/link";
import { redirect } from "next/navigation";
import { CampaignCreateForm } from "@/components/CampaignMutations";
import { DataTable, EmptyState, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getCampaignsPage } from "@/lib/campaigns";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function dateRange(startsOn: string | null, endsOn: string | null) {
  if (!startsOn && !endsOn) return "No dates set";
  if (startsOn && endsOn) return `${startsOn} → ${endsOn}`;
  return startsOn ? `Starts ${startsOn}` : `Ends ${endsOn}`;
}

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageCampaigns")) redirect("/unauthorized");
  const input = await searchParams;
  let page: Awaited<ReturnType<typeof getCampaignsPage>> | null = null;
  try {
    const context = await resolveWorkspaceContext(user);
    page = await getCampaignsPage(context, { cursor: input.cursor, pageSize: input.limit });
  } catch {
    // Fail closed. Do not replace unavailable campaign data with synthetic placeholders.
  }

  return <ProtectedPage permission="manageCampaigns"><div className="content">
    <PageHeader
      eyebrow="Organizing"
      title="Campaigns"
      description="Create and manage outreach campaigns, then assign campaign participants to CAT organizers through audited operational controls."
    />
    <SectionCard title="Create campaign" description="Start in draft while you prepare the population, or activate immediately for a synthetic Preview test." badge={<StatusBadge tone="preview">Preview mutation</StatusBadge>}>
      <CampaignCreateForm />
    </SectionCard>
    <SectionCard title="Campaign portfolio" badge={<StatusBadge tone="info">Aggregate SQL</StatusBadge>}>
      {!page ? <UnavailableState title="Campaigns unavailable" description="No synthetic campaign is presented as live." /> : page.campaigns.length === 0 ? <EmptyState title="No campaigns" description="Create a draft campaign to begin the organizing workflow." /> : <>
        <DataTable caption="Campaign summaries" headers={["Campaign", "Status", "Dates", "Population", "Assigned", "Contacted", "Completed", "Remaining"]}>
          {page.campaigns.map((campaign) => <tr key={campaign.handle}>
            <td><strong><Link href={`/campaigns/${campaign.handle}`}>{campaign.name}</Link></strong></td>
            <td><StatusBadge tone={campaign.status === "active" ? "ready" : campaign.status === "closed" ? "neutral" : "pending"}>{campaign.status}</StatusBadge></td>
            <td>{dateRange(campaign.startsOn, campaign.endsOn)}</td>
            <td>{campaign.population}</td>
            <td>{campaign.assigned}</td>
            <td>{campaign.contacted}</td>
            <td>{campaign.completed} <span className="muted">({campaign.completionPercentage}%)</span></td>
            <td>{campaign.remaining}</td>
          </tr>)}
        </DataTable>
        <Pagination
          label={`Showing up to ${page.pageSize} campaigns`}
          nextHref={page.nextCursor ? `/campaigns?limit=${page.pageSize}&cursor=${encodeURIComponent(page.nextCursor)}` : null}
        />
      </>}
    </SectionCard>
  </div></ProtectedPage>;
}
