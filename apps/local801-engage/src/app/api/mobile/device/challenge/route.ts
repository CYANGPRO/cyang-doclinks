import { issueMobileAttestationChallenge } from "@/lib/mobile-device-trust";
import { authorizeWorkspaceMutation, workspaceMutationFailure, workspaceJson } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export async function POST(request: Request) {
  const authorization = await authorizeWorkspaceMutation(request, "viewPersonalWorkspace");
  if ("response" in authorization) return authorization.response;
  try {
    const context = await resolveWorkspaceContext(authorization.auth.user);
    return workspaceJson(await issueMobileAttestationChallenge(context), 201);
  } catch (error) {
    return workspaceMutationFailure(error, "A native device-verification challenge could not be created.");
  }
}
