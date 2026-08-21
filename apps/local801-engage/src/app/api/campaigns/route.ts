import { createCampaign } from "@/lib/campaign-management";
import {
  authorizeCampaignMutation,
  campaignJson,
  campaignMutationFailure,
  readCampaignJson,
} from "@/lib/campaign-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeCampaignMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [body, context] = await Promise.all([
      readCampaignJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await createCampaign(context, {
      name: body.name,
      ...(Object.prototype.hasOwnProperty.call(body, "status") ? { status: body.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "startsOn") ? { startsOn: body.startsOn } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "endsOn") ? { endsOn: body.endsOn } : {}),
    });
    return campaignJson({ campaign: "ok", ...result }, 201);
  } catch (error) {
    return campaignMutationFailure(error);
  }
}
