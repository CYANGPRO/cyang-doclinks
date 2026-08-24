import { linkCampaignToCatAction } from "@/lib/campaign-cat-links";
import { authorizeWorkspaceMutation, readWorkspaceJson, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ campaignHandle: string }> }) {
  const authorized = await authorizeWorkspaceMutation(request, "manageCampaigns");
  if ("response" in authorized) return authorized.response;
  try {
    const [{ campaignHandle }, body, context] = await Promise.all([
      params, readWorkspaceJson(request), resolveWorkspaceContext(authorized.auth.user),
    ]);
    return workspaceJson(await linkCampaignToCatAction(context, { campaignHandle, actionHandle: body.actionHandle }));
  } catch (error) {
    return workspaceMutationFailure(error, "The campaign relationship could not be saved safely.");
  }
}
