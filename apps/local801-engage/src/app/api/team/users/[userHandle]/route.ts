import { changeTeamMemberRole, preflightTeamMemberRemoval, removeTeamMemberFromCat, resolveTeamMemberOnboardingTarget, resolveTeamMemberRemovalTarget, revokeTeamMemberSessions, setTeamMemberActive, TeamAccessError } from "@/lib/team-access";
import { deleteTeamMemberFromEntra, onboardTeamMemberWithEntra } from "@/lib/entra-user-onboarding";
import { authorizeTeamMutation, readTeamJson, teamJson, teamMutationFailure } from "@/lib/team-mutation-http";
import { writeSecuritySignal } from "@/lib/security-signal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ userHandle: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  const authorized = await authorizeTeamMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ userHandle }, body] = await Promise.all([
      params,
      readTeamJson(request),
    ]);
    const context = authorized.context;
    const action = typeof body.action === "string" ? body.action : "";
    let result: Record<string, unknown>;
    if (action === "role") result = await changeTeamMemberRole(context, userHandle, body.role);
    else if (action === "deactivate") result = await setTeamMemberActive(context, userHandle, false);
    else if (action === "reactivate") result = await setTeamMemberActive(context, userHandle, true);
    else if (action === "revoke_sessions") result = await revokeTeamMemberSessions(context, userHandle);
    else if (action === "retry_onboarding") {
      const target = await resolveTeamMemberOnboardingTarget(context, userHandle);
      result = await onboardTeamMemberWithEntra(target);
    }
    else if (action === "remove_account") {
      const target = await resolveTeamMemberRemovalTarget(context, userHandle);
      await preflightTeamMemberRemoval(context, target);
      const entra = await deleteTeamMemberFromEntra(target.providerUserId);
      const cat = await removeTeamMemberFromCat(context, target);
      result = { ...entra, ...cat };
    }
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
