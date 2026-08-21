import { createCatAction } from "@/lib/cat-action-management";
import {
  authorizeCatActionMutation,
  catActionJson,
  catActionMutationFailure,
  readCatActionJson,
} from "@/lib/cat-action-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeCatActionMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [body, context] = await Promise.all([
      readCatActionJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await createCatAction(context, {
      name: body.name,
      ...(Object.prototype.hasOwnProperty.call(body, "status") ? { status: body.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "contractCycleHandle") ? { contractCycleHandle: body.contractCycleHandle } : {}),
    });
    return catActionJson({ action: "ok", ...result }, 201);
  } catch (error) {
    return catActionMutationFailure(error);
  }
}
