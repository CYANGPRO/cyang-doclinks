import { disablePushSubscription, savePushSubscription } from "@/lib/push-notifications";
import { authorizeWorkspaceMutation, readWorkspaceJson, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request) {
  const authorized = await authorizeWorkspaceMutation(request, "viewPersonalWorkspace");
  if ("response" in authorized) return authorized.response;
  try {
    const [body, context] = await Promise.all([readWorkspaceJson(request), resolveWorkspaceContext(authorized.auth.user)]);
    return workspaceJson(await savePushSubscription(context, body.subscription));
  } catch (error) { return workspaceMutationFailure(error, "The push subscription could not be saved safely."); }
}

export async function DELETE(request: Request) {
  const authorized = await authorizeWorkspaceMutation(request, "viewPersonalWorkspace");
  if ("response" in authorized) return authorized.response;
  try {
    const [body, context] = await Promise.all([readWorkspaceJson(request), resolveWorkspaceContext(authorized.auth.user)]);
    return workspaceJson(await disablePushSubscription(context, body.subscription));
  } catch (error) { return workspaceMutationFailure(error, "The push subscription could not be disabled safely."); }
}
