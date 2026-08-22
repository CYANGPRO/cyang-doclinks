import { changeTeamMemberRole, revokeTeamMemberSessions, setTeamMemberActive, TeamAccessError } from "@/lib/team-access";
import { authorizeTeamMutation, readTeamJson, teamJson, teamMutationFailure } from "@/lib/team-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { writeSecuritySignal } from "@/lib/security-signal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ userHandle: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  const authorized = await authorizeTeamMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ userHandle }, body, context] = await Promise.all([
      params,
      readTeamJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const action = typeof body.action === "string" ? body.action : "";
    let result: Record<string, unknown>;
    if (action === "role") result = await changeTeamMemberRole(context, userHandle, body.role);
    else if (action === "deactivate") result = await setTeamMemberActive(context, userHandle, false);
    else if (action === "reactivate") result = await setTeamMemberActive(context, userHandle, true);
    else if (action === "revoke_sessions") result = await revokeTeamMemberSessions(context, userHandle);
    else throw new TeamAccessError("INVALID_ACTION", "The requested team access action is invalid.", 400);
    writeSecuritySignal("warn", "administrative_change", {
      outcome: "success", operation: `team.${action}`, actorId: context.userId,
      organizationId: context.organizationId, subjectId: userHandle,
    });
    return teamJson({ teamAccess: "ok", ...result });
  } catch (error) {
    return teamMutationFailure(error);
  }
}
