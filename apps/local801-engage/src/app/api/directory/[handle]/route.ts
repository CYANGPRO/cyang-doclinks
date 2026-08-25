import { archiveEmployeeRecord, EmployeeRecordError } from "@/lib/employee-record-management";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { authorizeWorkspaceMutation, workspaceJson, workspaceMutationFailure } from "@/lib/workspace-mutation-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ handle: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  if (!operationalRuntimeEnabled()) return workspaceJson({ error: "NOT_FOUND" }, 404);
  const authorized = await authorizeWorkspaceMutation(request, "deleteEmployees");
  if ("response" in authorized) return authorized.response;
  try {
    const { handle } = await params;
    const result = await archiveEmployeeRecord(authorized.context, handle);
    return workspaceJson(result);
  } catch (error) {
    if (error instanceof EmployeeRecordError) return workspaceJson({ error: error.code, message: error.message }, error.status);
    return workspaceMutationFailure(error, "The employee could not be removed safely.");
  }
}
