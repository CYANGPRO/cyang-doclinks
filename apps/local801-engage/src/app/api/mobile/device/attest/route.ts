import { registerAttestedMobileDevice } from "@/lib/mobile-device-trust";
import { authorizeWorkspaceMutation, readWorkspaceJson, workspaceMutationFailure, workspaceJson } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export async function POST(request: Request) {
  const authorization = await authorizeWorkspaceMutation(request, "viewPersonalWorkspace");
  if ("response" in authorization) return authorization.response;
  try {
    // App Attest and Play Integrity evidence can be larger than ordinary mutation payloads.
    // The dedicated ceiling stays bounded and far below the document-upload limit.
    const body = await readWorkspaceJson(request, 98_304);
    const context = await resolveWorkspaceContext(authorization.auth.user);
    return workspaceJson(await registerAttestedMobileDevice(context, body));
  } catch (error) {
    return workspaceMutationFailure(error, "This native application or device could not be verified.");
  }
}
