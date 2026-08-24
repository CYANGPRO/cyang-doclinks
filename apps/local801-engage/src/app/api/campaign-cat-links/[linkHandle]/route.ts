import { unlinkCampaignCatAction } from "@/lib/campaign-cat-links";
import { authorizeWorkspaceMutation, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(request: Request, { params }: { params: Promise<{ linkHandle: string }> }) {
  const authorized = await authorizeWorkspaceMutation(request, "manageCampaigns");
  if ("response" in authorized) return authorized.response;
  try {
    const [{ linkHandle }, context] = await Promise.all([params, resolveWorkspaceContext(authorized.auth.user)]);
    return workspaceJson(await unlinkCampaignCatAction(context, linkHandle));
  } catch (error) {
    return workspaceMutationFailure(error, "The campaign relationship could not be removed safely.");
  }
}
