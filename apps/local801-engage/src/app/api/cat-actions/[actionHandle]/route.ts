import { deleteCatAction, updateCatAction } from "@/lib/cat-action-management";
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

export async function PATCH(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCatActionMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ actionHandle }, body, context] = await Promise.all([
      params,
      readCatActionJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await updateCatAction(context, {
      actionHandle,
      ...(Object.prototype.hasOwnProperty.call(body, "name") ? { name: body.name } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "status") ? { status: body.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "contractCycleHandle") ? { contractCycleHandle: body.contractCycleHandle } : {}),
    });
    return catActionJson({ action: "ok", ...result });
  } catch (error) {
    return catActionMutationFailure(error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const authorized = await authorizeCatActionMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ actionHandle }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await deleteCatAction(context, actionHandle);
    return catActionJson({ action: "ok", ...result });
  } catch (error) {
    return catActionMutationFailure(error);
  }
}
