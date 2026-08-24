import { provisionTeamMember } from "@/lib/team-access";
import { EntraOnboardingError, getEntraProvisioningConfig, onboardTeamMemberWithEntra } from "@/lib/entra-user-onboarding";
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
    const provisioning = getEntraProvisioningConfig();
    if (!provisioning.enabled) {
      throw new EntraOnboardingError("ENTRA_PROVISIONING_DISABLED", "Automated Microsoft Entra onboarding is not enabled.");
    }
    const created = await provisionTeamMember(context, {
      email: body.email,
      displayName: body.displayName,
      role: body.role,
    });
    writeSecuritySignal("warn", "administrative_change", {
      outcome: "success", operation: "team.provision", actorId: context.userId,
      organizationId: context.organizationId,
    });
    try {
      const onboarding = await onboardTeamMemberWithEntra({
        organizationId: context.organizationId,
        userId: created.userId,
        email: created.email,
        displayName: created.displayName,
        role: created.role,
      });
      return teamJson({ teamAccess: "ok", created: true, ...onboarding }, 201);
    } catch (error) {
      if (error instanceof EntraOnboardingError) {
        return teamJson({ teamAccess: "partial", created: true, onboarding: "failed", message: error.message }, 202);
      }
      throw error;
    }
  } catch (error) {
    return teamMutationFailure(error);
  }
}
