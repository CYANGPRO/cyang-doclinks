import { dispatchGenericWorkPush } from "@/lib/push-notifications";
import { authorizeWorkspaceMutation, readWorkspaceJson, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeWorkspaceMutation(request, "viewPersonalWorkspace");
  if ("response" in authorized) return authorized.response;
  try {
    const [body, context] = await Promise.all([readWorkspaceJson(request), resolveWorkspaceContext(authorized.auth.user)]);
    return workspaceJson(await dispatchGenericWorkPush(context, body.digest));
  } catch (error) { return workspaceMutationFailure(error, "The generic work notification could not be dispatched safely."); }
}
