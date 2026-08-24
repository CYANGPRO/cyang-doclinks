import { sendGenericPushToCurrentUser } from "@/lib/push-notifications";
import { authorizeWorkspaceMutation, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeWorkspaceMutation(request, "viewPersonalWorkspace");
  if ("response" in authorized) return authorized.response;
  try { return workspaceJson(await sendGenericPushToCurrentUser(await resolveWorkspaceContext(authorized.auth.user))); }
  catch (error) { return workspaceMutationFailure(error, "The test notification could not be delivered safely."); }
}
