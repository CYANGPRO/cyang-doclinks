import Link from "next/link";
import { redirect } from "next/navigation";
import { CampaignCreateForm } from "@/components/CampaignMutations";
import { DataTable, EmptyState, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getCampaignsPage } from "@/lib/campaigns";
import { formatCatDate } from "@/lib/date-format";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function dateRange(startsOn: string | null, endsOn: string | null) {
  if (!startsOn && !endsOn) return "No dates set";
  if (startsOn && endsOn) return `${formatCatDate(startsOn)} → ${formatCatDate(endsOn)}`;
  return startsOn ? `Starts ${formatCatDate(startsOn)}` : `Ends ${formatCatDate(endsOn)}`;
}

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "viewCampaigns")) redirect("/unauthorized");
  const canManageCampaign = can(user.role, "manageCampaigns");
  const input = await searchParams;
  const hasCursor = typeof input.cursor === "string" && input.cursor.length > 0;
  let page: Awaited<ReturnType<typeof getCampaignsPage>> | null = null;
  try {
    const context = await resolveWorkspaceContext(user);
    page = await getCampaignsPage(context, { cursor: input.cursor, pageSize: input.limit });
  } catch {
    // Fail closed. Do not replace unavailable campaign data with placeholder records.
  }

  return <ProtectedPage permission="viewCampaigns"><div className="content route-campaigns-page queue-first-page">
    <PageHeader
      eyebrow="Programs"
      title="Campaigns"
      description="Open a campaign to search its participants, manage assignments within your role, and track contact and completion."
    />
    {canManageCampaign ? <SectionCard id="create-campaign" title="Create campaign" description="Start in draft while you prepare the population." badge={<StatusBadge tone="ready">Audited operation</StatusBadge>}>
      <CampaignCreateForm />
    </SectionCard> : null}
    <SectionCard title="Campaign portfolio" badge={<StatusBadge tone="info">Aggregate SQL</StatusBadge>}>
      {!page ? <UnavailableState title="Campaigns unavailable" description="We couldn’t load the campaign list, so CAT is not showing incomplete results." action={<Link className="button secondary" href="/campaigns">Try again</Link>} /> : page.campaigns.length === 0 ? <EmptyState title="No campaigns yet" description={canManageCampaign ? "Create a draft when you are ready to build a participant list and assign the work." : "An administrator has not created a campaign yet."} action={canManageCampaign ? <a className="button" href="#create-campaign">Create first campaign</a> : undefined} /> : <>
        <DataTable caption="Campaign summaries" headers={["Campaign", "Status", "Dates", "Population", "Contacted", "Completed"]}>
          {page.campaigns.map((campaign) => <tr key={campaign.handle}>
            <td><strong><Link href={`/campaigns/${campaign.handle}`}>{campaign.name}</Link></strong></td>
            <td><StatusBadge tone={campaign.status === "active" ? "ready" : campaign.status === "closed" ? "neutral" : "pending"}>{campaign.status}</StatusBadge></td>
            <td>{dateRange(campaign.startsOn, campaign.endsOn)}</td>
            <td>{campaign.population}</td>
            <td>{campaign.contacted}</td>
            <td>{campaign.completed} <span className="muted">({campaign.completionPercentage}% · {campaign.remaining} remaining)</span></td>
          </tr>)}
        </DataTable>
        <Pagination
          label={`Showing up to ${page.pageSize} campaigns`}
          historyBackFallbackHref={hasCursor ? `/campaigns?limit=${page.pageSize}` : null}
          nextHref={page.nextCursor ? `/campaigns?limit=${page.pageSize}&cursor=${encodeURIComponent(page.nextCursor)}` : null}
        />
      </>}
    </SectionCard>
  </div></ProtectedPage>;
}
