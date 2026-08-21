import { removeCampaignPopulationMember } from "@/lib/campaign-population-management";
import {
  authorizeCampaignMutation,
  campaignJson,
  campaignMutationFailure,
} from "@/lib/campaign-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ campaignHandle: string; personHandle: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCampaignMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ campaignHandle, personHandle }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await removeCampaignPopulationMember(context, campaignHandle, personHandle);
    return campaignJson({ campaign: "ok", ...result });
  } catch (error) {
    return campaignMutationFailure(error);
  }
}
