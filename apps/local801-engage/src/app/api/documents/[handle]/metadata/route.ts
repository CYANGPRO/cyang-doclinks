import { addDocumentRelationship, setDocumentTags } from "@/lib/document-metadata";
import { authorizeWorkspaceMutation, readWorkspaceJson, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ handle: string }> }) {
  const authorized = await authorizeWorkspaceMutation(request, "manageDocuments");
  if ("response" in authorized) return authorized.response;
  try {
    const [{ handle }, body, context] = await Promise.all([params, readWorkspaceJson(request), resolveWorkspaceContext(authorized.auth.user)]);
    if (body.action === "set_tags") return workspaceJson(await setDocumentTags(context, { documentHandle: handle, tags: body.tags }));
    if (body.action === "add_relationship") return workspaceJson(await addDocumentRelationship(context, {
      documentHandle: handle, targetKind: body.targetKind, targetHandle: body.targetHandle, relationshipType: body.relationshipType,
    }));
    return workspaceJson({ error: "INVALID_ACTION", message: "The document metadata action is invalid." }, 400);
  } catch (error) { return workspaceMutationFailure(error, "The document metadata could not be saved safely."); }
}
