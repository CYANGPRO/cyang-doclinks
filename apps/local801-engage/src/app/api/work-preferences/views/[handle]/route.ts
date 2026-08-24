import { deleteSavedWorkView } from "@/lib/work-preferences";
import {
  authorizeWorkPreferenceMutation,
  workPreferenceFailure,
  workPreferenceJson,
} from "@/lib/work-preference-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(request: Request, { params }: { params: Promise<{ handle: string }> }) {
  const authorized = await authorizeWorkPreferenceMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ handle }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await deleteSavedWorkView(context, handle);
    return workPreferenceJson(result);
  } catch (error) {
    return workPreferenceFailure(error);
  }
}
