import { createSavedWorkView } from "@/lib/work-preferences";
import {
  authorizeWorkPreferenceMutation,
  readWorkPreferenceJson,
  workPreferenceFailure,
  workPreferenceJson,
} from "@/lib/work-preference-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeWorkPreferenceMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [body, context] = await Promise.all([
      readWorkPreferenceJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const savedView = await createSavedWorkView(context, {
      label: body.label,
      destination: body.destination,
      queryParams: body.queryParams,
    });
    return workPreferenceJson({ savedView }, 201);
  } catch (error) {
    return workPreferenceFailure(error);
  }
}
