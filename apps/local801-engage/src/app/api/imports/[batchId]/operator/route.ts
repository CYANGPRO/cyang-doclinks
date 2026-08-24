import { cancelImportProcessing, requeueImportProcessing } from "@/lib/import-operator-controls";
import { startQueuedImportWorkflow } from "@/lib/import-workflow-starter";
import { authorizeWorkspaceMutation, readWorkspaceJson, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const authorized = await authorizeWorkspaceMutation(request, "manageImports", "import");
  if ("response" in authorized) return authorized.response;
  try {
    const [{ batchId }, body, context] = await Promise.all([params, readWorkspaceJson(request), resolveWorkspaceContext(authorized.auth.user)]);
    if (body.action === "cancel") return workspaceJson(await cancelImportProcessing(context, { batchId, reason: body.reason }), 202);
    if (body.action === "requeue") {
      await requeueImportProcessing(context, batchId);
      const started = await startQueuedImportWorkflow(context.organizationId, batchId);
      return workspaceJson({ requeued: true, workflowRunId: started.workflowRunId }, 202);
    }
    return workspaceJson({ error: "INVALID_ACTION", message: "The import operator action is invalid." }, 400);
  } catch (error) { return workspaceMutationFailure(error, "The import operator action could not be completed safely."); }
}
