import { redirect } from "next/navigation";
import { ActionCatalogManager, ActionResponseEditor } from "@/components/ActionCatalogManager";
import { DataTable, EmptyState, PageHeader, SectionCard, StatusBadge } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { listEmployeeActionDefinitions } from "@/lib/employee-actions";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export default async function ActionReadinessCatalogPage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageActionCatalog")) redirect("/unauthorized");
  const context = await resolveWorkspaceContext(user);
  const actions = await listEmployeeActionDefinitions(context);

  return <ProtectedPage permission="manageActionCatalog"><div className="content action-catalog-page">
    <PageHeader eyebrow="Programs" title="Action Readiness catalog" description="Manage the actions CATs can discuss with members and record each member’s current response." />
    <SectionCard title="Action catalog" description="Actions are ordered from the lowest commitment to the highest. Earlier responses remain in history when a current response changes.">
      {actions.length === 0 ? <EmptyState title="No actions configured" description="Add the first organization-wide action below." /> : <DataTable caption="Action Readiness catalog" headers={["Order", "Action", "Available responses"]}>
        {actions.map((action, index) => <tr key={action.handle}>
          <td>{index + 1}</td>
          <td><strong>{action.label}</strong><div className="muted">Commitment level {action.engagementLevel}</div></td>
          <td><div className="page-actions compact-actions">{action.responseOptions.filter((option) => option.enabled).map((option) => <StatusBadge key={option.value} tone={option.value === "completed" || option.value === "willing" ? "ready" : option.value === "declined" ? "warning" : "pending"}>{option.label}</StatusBadge>)}</div><ActionResponseEditor action={action} /></td>
        </tr>)}
      </DataTable>}
      <p className="muted">“Not recorded” means no response has been entered yet. Use “Declines all actions” on the outreach record when that describes the member’s overall response.</p>
    </SectionCard>
    <SectionCard title="Add a custom action" description="CATs, LCATs, Membership Data Managers, 801 Administrators, Local Administrators, and System Owners can extend this catalog.">
      <ActionCatalogManager />
    </SectionCard>
  </div></ProtectedPage>;
}
