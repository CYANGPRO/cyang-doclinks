import { createCatActionTask } from "@/lib/cat-action-management";
import {
  authorizeCatActionMutation,
  catActionJson,
  catActionMutationFailure,
  readCatActionJson,
} from "@/lib/cat-action-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ actionHandle: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCatActionMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ actionHandle }, body, context] = await Promise.all([
      params,
      readCatActionJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await createCatActionTask(context, {
      actionHandle,
      title: body.title,
      ...(Object.prototype.hasOwnProperty.call(body, "assigneeHandle") ? { assigneeHandle: body.assigneeHandle } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "dueAt") ? { dueAt: body.dueAt } : {}),
    });
    return catActionJson({ task: "ok", ...result }, 201);
  } catch (error) {
    return catActionMutationFailure(error);
  }
}
