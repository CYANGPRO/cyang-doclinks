import { changeTeamMemberRole, revokeTeamMemberSessions, setTeamMemberActive, TeamAccessError } from "@/lib/team-access";
import { authorizeTeamMutation, readTeamJson, teamJson, teamMutationFailure } from "@/lib/team-mutation-http";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

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
    if (action === "role") return teamJson({ teamAccess: "ok", ...(await changeTeamMemberRole(context, userHandle, body.role)) });
    if (action === "deactivate") return teamJson({ teamAccess: "ok", ...(await setTeamMemberActive(context, userHandle, false)) });
    if (action === "reactivate") return teamJson({ teamAccess: "ok", ...(await setTeamMemberActive(context, userHandle, true)) });
    if (action === "revoke_sessions") return teamJson({ teamAccess: "ok", ...(await revokeTeamMemberSessions(context, userHandle)) });
    throw new TeamAccessError("INVALID_ACTION", "The requested team access action is invalid.", 400);
  } catch (error) {
    return teamMutationFailure(error);
  }
}
