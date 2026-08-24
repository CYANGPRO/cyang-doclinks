import { saveNativePushToken } from "@/lib/mobile-device-trust";
import { authorizeWorkspaceMutation, readWorkspaceJson, workspaceMutationFailure, workspaceJson } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export async function PUT(request: Request) {
  const authorization = await authorizeWorkspaceMutation(request, "viewPersonalWorkspace");
  if ("response" in authorization) return authorization.response;
  try {
    const body = await readWorkspaceJson(request);
    const context = await resolveWorkspaceContext(authorization.auth.user);
    return workspaceJson(await saveNativePushToken(context, body));
  } catch (error) {
    return workspaceMutationFailure(error, "Native notification registration could not be stored safely.");
  }
}
