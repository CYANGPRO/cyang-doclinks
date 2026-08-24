import { removeDocumentRelationship } from "@/lib/document-metadata";
import { authorizeWorkspaceMutation, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(request: Request, { params }: { params: Promise<{ relationshipHandle: string }> }) {
  const authorized = await authorizeWorkspaceMutation(request, "manageDocuments");
  if ("response" in authorized) return authorized.response;
  try {
    const [{ relationshipHandle }, context] = await Promise.all([params, resolveWorkspaceContext(authorized.auth.user)]);
    return workspaceJson(await removeDocumentRelationship(context, relationshipHandle));
  } catch (error) { return workspaceMutationFailure(error, "The document relationship could not be removed safely."); }
}
