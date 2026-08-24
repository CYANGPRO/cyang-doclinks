import { redirect } from "next/navigation";
import { ActionCatalogManager } from "@/components/ActionCatalogManager";
import { DataTable, EmptyState, PageHeader, SectionCard, StatusBadge } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { listEmployeeActionDefinitions } from "@/lib/employee-actions";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

const responseStates = ["Willing", "Considering", "Declined", "Completed"];

export default async function ActionReadinessCatalogPage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageActionCatalog")) redirect("/unauthorized");
  const context = await resolveWorkspaceContext(user);
  const actions = await listEmployeeActionDefinitions(context);

  return <ProtectedPage permission="manageActionCatalog"><div className="content action-catalog-page">
    <PageHeader eyebrow="Programs" title="Action Readiness catalog" description="Maintain the escalating actions CATs use to record a member’s current willingness, consideration, decline, or completion." />
    <SectionCard title="Action catalog" description="Actions are ordered from the lowest commitment to the highest. Earlier responses remain in history when a current response changes.">
      {actions.length === 0 ? <EmptyState title="No actions configured" description="Add the first organization-wide action below." /> : <DataTable caption="Action Readiness catalog" headers={["Order", "Action", "Available responses"]}>
        {actions.map((action, index) => <tr key={action.handle}>
          <td>{index + 1}</td>
          <td><strong>{action.label}</strong><div className="muted">Escalation level {action.engagementLevel}</div></td>
          <td><div className="page-actions compact-actions">{responseStates.map((state) => <StatusBadge key={state} tone={state === "Completed" || state === "Willing" ? "ready" : state === "Declined" ? "warning" : "pending"}>{state}</StatusBadge>)}</div></td>
        </tr>)}
      </DataTable>}
      <p className="muted">“Not recorded” means no current response exists. “Declines all actions” remains available on the member outreach record as a separate overall posture.</p>
    </SectionCard>
    <SectionCard title="Add a custom action" description="CATs, LCATs, Membership Data Managers, 801 Administrators, Local Administrators, and System Owners can extend this catalog.">
      <ActionCatalogManager />
    </SectionCard>
  </div></ProtectedPage>;
}
