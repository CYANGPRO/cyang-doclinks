import { acknowledgeNotification } from "@/lib/work-preferences";
import {
  authorizeWorkPreferenceMutation,
  workPreferenceFailure,
  workPreferenceJson,
} from "@/lib/work-preference-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const authorized = await authorizeWorkPreferenceMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ key }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await acknowledgeNotification(context, key);
    return workPreferenceJson(result);
  } catch (error) {
    return workPreferenceFailure(error);
  }
}
