import { previewCampaignPopulationChange } from "@/lib/campaign-bulk-population";
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
    const preview = await previewCampaignPopulationChange(context, campaignHandle, {
      operation: body.operation,
      criteria: body.criteria,
    });
    return campaignJson({ campaign: "ok", preview });
  } catch (error) {
    return campaignMutationFailure(error);
  }
}
