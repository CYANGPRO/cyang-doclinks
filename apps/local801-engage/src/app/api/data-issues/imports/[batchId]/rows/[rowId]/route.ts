import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { ImportDataIssueError, resolveImportDataIssue } from "@/lib/import-data-issues";
import {
  authorizeWorkspaceMutation,
  readWorkspaceJson,
  workspaceJson,
  workspaceMutationFailure,
} from "@/lib/workspace-mutation-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ batchId: string; rowId: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  if (!operationalRuntimeEnabled()) return workspaceJson({ error: "NOT_FOUND" }, 404);
  const authorized = await authorizeWorkspaceMutation(request, "manageImports");
  if ("response" in authorized) return authorized.response;
  try {
    const [{ batchId, rowId }, body] = await Promise.all([params, readWorkspaceJson(request, 4_096)]);
    const result = await resolveImportDataIssue(authorized.context, {
      batchId,
      rowId,
      action: body.action,
      personHandle: body.personHandle,
    });
    return workspaceJson({ resolution: "ok", ...result });
  } catch (error) {
    if (error instanceof ImportDataIssueError) return workspaceJson({ error: error.code, message: error.message }, error.status);
    return workspaceMutationFailure(error, "The import issue could not be updated safely.");
  }
}
