import { updateCampaignAssignment } from "@/lib/campaign-management";
import {
  authorizeCampaignMutation,
  campaignJson,
  campaignMutationFailure,
  readCampaignJson,
} from "@/lib/campaign-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ campaignHandle: string; personHandle: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCampaignMutation(request, "assignCampaignMembers");
  if ("response" in authorized) return authorized.response;
  try {
    const [{ campaignHandle, personHandle }, body, context] = await Promise.all([
      params,
      readCampaignJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await updateCampaignAssignment(context, {
      campaignHandle,
      personHandle,
      ...(Object.prototype.hasOwnProperty.call(body, "assigneeHandle") ? { assigneeHandle: body.assigneeHandle } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "dueAt") ? { dueAt: body.dueAt } : {}),
    });
    return campaignJson({ campaign: "ok", ...result });
  } catch (error) {
    return campaignMutationFailure(error);
  }
}
