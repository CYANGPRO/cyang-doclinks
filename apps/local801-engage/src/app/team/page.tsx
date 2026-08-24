import { redirect } from "next/navigation";
import { DataTable, DisclosureCard, EmptyState, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { ProvisionTeamMemberForm, TeamMemberControls } from "@/components/TeamAccessControls";
import { can, navForRole, roleLabels, type Permission, type Role } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { hydrateTeamAccessPageFromProtectedPii, isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { getTeamAccessPage, teamReadSafeCode } from "@/lib/team-access";
import { writeSecuritySignal } from "@/lib/security-signal";
import { resolveWorkspaceContext, type WorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

const permissionLabels: Record<Permission, string> = {
  manageUsers: "Manage Team & Access",
  manageImports: "Manage membership and imports",
  approveImports: "Approve import review",
  assignNewHires: "Assign new hires to CAT organizers",
  assignOutreach: "Assign member outreach to CAT organizers",
  manageActionCatalog: "Manage the Action Readiness catalog",
  manageCampaigns: "Manage campaigns",
  manageCatActions: "Manage CAT actions",
  manageDocuments: "Manage document metadata and deletion",
  uploadDocuments: "Upload documents",
  approveDocuments: "Approve documents",
  shareDocumentsWithEveryone: "Share documents with everyone",
  viewDocuments: "View authorized documents",
  viewLocalAdminDocuments: "View local-admin documents",
  viewCatMemberDocuments: "View CAT-member documents",
  generateReports: "Generate managed reports",
  viewPersonLevelReports: "View person-level reports",
  viewReports: "View reports",
  viewDirectory: "View directory",
  viewTeamScope: "View CAT team scope",
  recordEngagement: "Record conversations and follow-ups",
  viewPersonalWorkspace: "View notifications and saved views",
  exportRoster: "Export roster data",
  viewRestrictedStrategy: "View restricted CAT strategy",
};

const roleOrder = Object.keys(roleLabels) as Role[];
const permissionOrder = Object.keys(permissionLabels) as Permission[];

function displayTimestamp(value: string | null) {
  if (!value) return "Not yet";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function areasForRole(role: Role) {
  return navForRole(role).map((item) => item.label).join(", ");
}

function capabilitiesForRole(role: Role) {
  return permissionOrder.filter((permission) => can(role, permission)).map((permission) => permissionLabels[permission]).join(", ");
}

function onboardingLabel(status: Awaited<ReturnType<typeof getTeamAccessPage>>["members"][number]["onboardingStatus"]) {
  return {
    pending: "Invitation queued",
    processing: "Onboarding in progress",
    invited: "Invitation sent",
    ready: "Entra access assigned",
    failed: "Onboarding needs attention",
    not_managed: "Invitation not yet sent",
  }[status];
}

function onboardingTone(status: Awaited<ReturnType<typeof getTeamAccessPage>>["members"][number]["onboardingStatus"]) {
  if (status === "ready") return "ready" as const;
  if (status === "failed") return "danger" as const;
  if (status === "not_managed") return "warning" as const;
  return "pending" as const;
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
      <div className="content route-team-page queue-first-page">
        <PageHeader
          eyebrow="Administration"
          title="Team & Access"
          description="Add Local 801 users, choose their roles, and manage access when responsibilities change."
        />

        <SectionCard
          title="Current users"
          description="Review CAT authorization, Microsoft Entra invitation status, assigned roles, and recent sign-in activity. Adding a user now creates the CAT account, grants access to the Entra enterprise application, and sends the onboarding email in one workflow. Changing a role or deactivating an account signs that user out of existing CAT sessions."
          badge={page && protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
        >
          {!page || !context ? (
            <UnavailableState title="Users unavailable" description="We couldn’t safely load the current user list. Try again after the service is restored." />
          ) : page.members.length === 0 ? (
            <EmptyState title="No users yet" description="Add the first authorized user with the panel below." />
          ) : (
            <DataTable caption="Engaging Local 801 users" headers={["User", "Role", "Status", "Sign-in & MFA", "Access controls"]}>
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
                      <StatusBadge tone={onboardingTone(member.onboardingStatus)}>{onboardingLabel(member.onboardingStatus)}</StatusBadge>
                    </td>
                    <td>
                      <StatusBadge tone={member.identityLinked ? "ready" : "pending"}>{member.identityLinked ? "Identity linked" : "Awaiting first sign-in"}</StatusBadge>
                      <div className="stat-detail">Last sign-in: {displayTimestamp(member.lastAuthenticatedAt)}</div>
                      <div className="stat-detail">Last MFA: {displayTimestamp(member.lastMfaAt)}</div>
                    </td>
                    <td>
                      {isSelf ? (
                        <span className="stat-detail">Ask another administrator to change your access.</span>
                      ) : protectedPeer ? (
                        <span className="stat-detail">System Owner required.</span>
                      ) : (
                        <TeamMemberControls handle={member.handle} currentRole={member.role} active={member.active} roles={page.assignableRoles} displayName={member.displayName} onboardingStatus={member.onboardingStatus} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </SectionCard>

        <DisclosureCard
          title="Add a user"
          description="Enter the user once. CAT creates their role-limited account, grants the matching Entra enterprise-application access, and sends a personalized Microsoft invitation with sign-in, MFA, privacy, acceptable-use, and support instructions. CAT never creates or emails a password."
          className="route-secondary-panel create-record-panel"
        >
          {!page ? (
            <UnavailableState title="Team access unavailable" description="New users can’t be added until the authorization service is available." />
          ) : (
            <ProvisionTeamMemberForm roles={page.assignableRoles} />
          )}
        </DisclosureCard>

        <DisclosureCard
          title="What each role can do"
          description="Compare the pages and permitted actions assigned to each Local 801 role before granting access."
          className="route-secondary-panel reference-panel"
        >
          <DataTable caption="Local 801 roles and capabilities" headers={["Role", "Application areas", "Key capabilities"]}>
            {roleOrder.map((role) => <tr key={role}>
              <td><strong>{roleLabels[role]}</strong></td>
              <td>{areasForRole(role)}</td>
              <td>{capabilitiesForRole(role) || "Navigation-only access"}</td>
            </tr>)}
          </DataTable>
        </DisclosureCard>
      </div>
    </ProtectedPage>
  );
}
