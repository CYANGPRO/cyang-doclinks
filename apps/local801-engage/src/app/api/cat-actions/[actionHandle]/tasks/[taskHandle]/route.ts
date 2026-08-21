import { updateCatActionTask } from "@/lib/cat-action-management";
import {
  authorizeCatActionMutation,
  catActionJson,
  catActionMutationFailure,
  readCatActionJson,
} from "@/lib/cat-action-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ actionHandle: string; taskHandle: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCatActionMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ actionHandle, taskHandle }, body, context] = await Promise.all([
      params,
      readCatActionJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await updateCatActionTask(context, {
      actionHandle,
      taskHandle,
      ...(Object.prototype.hasOwnProperty.call(body, "title") ? { title: body.title } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "status") ? { status: body.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "assigneeHandle") ? { assigneeHandle: body.assigneeHandle } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "dueAt") ? { dueAt: body.dueAt } : {}),
    });
    return catActionJson({ task: "ok", ...result });
  } catch (error) {
    return catActionMutationFailure(error);
  }
}
