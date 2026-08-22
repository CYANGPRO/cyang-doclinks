import { provisionTeamMember } from "@/lib/team-access";
import { authorizeTeamMutation, readTeamJson, teamJson, teamMutationFailure } from "@/lib/team-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { writeSecuritySignal } from "@/lib/security-signal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeTeamMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [body, context] = await Promise.all([
      readTeamJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await provisionTeamMember(context, {
      email: body.email,
      displayName: body.displayName,
      role: body.role,
    });
    writeSecuritySignal("warn", "administrative_change", {
      outcome: "success", operation: "team.provision", actorId: context.userId,
      organizationId: context.organizationId,
    });
    return teamJson({ teamAccess: "ok", ...result }, 201);
  } catch (error) {
    return teamMutationFailure(error);
  }
}
