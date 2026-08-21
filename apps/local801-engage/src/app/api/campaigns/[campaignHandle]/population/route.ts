import { addCampaignPopulationMember } from "@/lib/campaign-population-management";
import {
  authorizeCampaignMutation,
  campaignJson,
  campaignMutationFailure,
  readCampaignJson,
} from "@/lib/campaign-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ campaignHandle: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCampaignMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ campaignHandle }, body, context] = await Promise.all([
      params,
      readCampaignJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await addCampaignPopulationMember(context, campaignHandle, body.personHandle);
    return campaignJson({ campaign: "ok", ...result }, 201);
  } catch (error) {
    return campaignMutationFailure(error);
  }
}
