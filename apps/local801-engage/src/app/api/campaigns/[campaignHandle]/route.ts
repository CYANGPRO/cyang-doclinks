import { archiveCampaign, updateCampaign } from "@/lib/campaign-management";
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

export async function PATCH(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCampaignMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ campaignHandle }, body, context] = await Promise.all([
      params,
      readCampaignJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await updateCampaign(context, {
      campaignHandle,
      ...(Object.prototype.hasOwnProperty.call(body, "name") ? { name: body.name } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "status") ? { status: body.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "startsOn") ? { startsOn: body.startsOn } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "endsOn") ? { endsOn: body.endsOn } : {}),
    });
    return campaignJson({ campaign: "ok", ...result });
  } catch (error) {
    return campaignMutationFailure(error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCampaignMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ campaignHandle }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await archiveCampaign(context, campaignHandle);
    return campaignJson({ campaign: "ok", ...result });
  } catch (error) {
    return campaignMutationFailure(error);
  }
}
