import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { ProvisionTeamMemberForm, TeamMemberControls } from "@/components/TeamAccessControls";
import { can, roleLabels } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { hydrateTeamAccessPageFromProtectedPii, isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { getTeamAccessPage, teamReadSafeCode } from "@/lib/team-access";
import { writeSecuritySignal } from "@/lib/security-signal";
import { resolveWorkspaceContext, type WorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

function displayTimestamp(value: string | null) {
  if (!value) return "Not yet";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function reportTeamReadFailure(operation: "context" | "list" | "protected_pii", error: unknown) {
  writeSecuritySignal("error", "authorization.denied", {
    component: "team_access",
    operation,
    outcome: "error",
    safeCode: teamReadSafeCode(error),
  });
}

export default async function TeamPage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageUsers")) redirect("/unauthorized");

  let context: WorkspaceContext | null = null;
  let page: Awaited<ReturnType<typeof getTeamAccessPage>> | null = null;
  let protectedReadEnabled = false;
  try {
    context = await resolveWorkspaceContext(user);
  } catch (error) {
    reportTeamReadFailure("context", error);
  }
  if (context) {
    try {
      page = await getTeamAccessPage(context);
    } catch (error) {
      reportTeamReadFailure("list", error);
    }
  }
  if (context && page) {
    try {
      page = await hydrateTeamAccessPageFromProtectedPii(context.organizationId, page);
      protectedReadEnabled = isPiiProtectedReadEnabled();
    } catch (error) {
      page = null;
      reportTeamReadFailure("protected_pii", error);
    }
  }

  return (
    <ProtectedPage permission="manageUsers">
      <div className="content">
        <PageHeader
          eyebrow="Administration"
          title="Team & Access"
          description="Provision Local 801 application users, assign one authorized role, deactivate access, and revoke active sessions. Identity and MFA are supplied by the configured production OIDC provider."
        />

        <SectionCard
          title="Provision user"
          description="Provisioning creates application authorization only. No local password, recovery secret, or TOTP seed is stored by Local 801 Engage."
          badge={<StatusBadge tone="info">OIDC identity</StatusBadge>}
        >
          {!page ? (
            <UnavailableState title="Team access unavailable" description="User provisioning is disabled until the authorization database is available." />
          ) : (
            <ProvisionTeamMemberForm roles={page.assignableRoles} />
          )}
        </SectionCard>

        <SectionCard
          title="Workspace users"
          description="Role and account-state changes revoke existing application sessions. Local Administrators cannot modify peer administrators or System Owners."
          badge={<StatusBadge tone={page ? "ready" : "warning"}>{page ? (protectedReadEnabled ? "Protected PII" : "Database-backed") : "Unavailable"}</StatusBadge>}
        >
          {!page || !context ? (
            <UnavailableState title="Workspace users unavailable" description="No internal authentication, database, or PII error details are shown. Try again after the service is restored." />
          ) : page.members.length === 0 ? (
            <EmptyState title="No workspace users" description="Provision the first authorized user above." />
          ) : (
            <DataTable caption="Local 801 workspace users" headers={["User", "Role", "Status", "Identity & MFA", "Access controls"]}>
              {page.members.map((member) => {
                const isSelf = member.email.toLowerCase() === context.email.toLowerCase();
                const protectedPeer = user.role === "local_admin" && (member.role === "system_owner" || member.role === "local_admin");
                return (
                  <tr key={member.handle}>
                    <td><strong>{member.displayName}</strong><br /><span className="stat-detail">{member.email}</span></td>
                    <td>{roleLabels[member.role]}</td>
                    <td>
                      <StatusBadge tone={member.active ? "ready" : "blocked"}>{member.active ? "Active" : "Deactivated"}</StatusBadge>
                      <div className="stat-detail">Invited: {displayTimestamp(member.invitedAt)}</div>
                    </td>
                    <td>
                      <StatusBadge tone={member.identityLinked ? "ready" : "pending"}>{member.identityLinked ? "Identity linked" : "Awaiting first sign-in"}</StatusBadge>
                      <div className="stat-detail">Last sign-in: {displayTimestamp(member.lastAuthenticatedAt)}</div>
                      <div className="stat-detail">Last MFA: {displayTimestamp(member.lastMfaAt)}</div>
                    </td>
                    <td>
                      {isSelf ? (
                        <span className="stat-detail">Use another administrator for changes to your own access.</span>
                      ) : protectedPeer ? (
                        <span className="stat-detail">System Owner required.</span>
                      ) : (
                        <TeamMemberControls handle={member.handle} currentRole={member.role} active={member.active} roles={page.assignableRoles} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </SectionCard>
      </div>
    </ProtectedPage>
  );
}
