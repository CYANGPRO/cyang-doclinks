import { roleLabels, type Role } from "@/lib/access";
import { AlertBanner, PageHeader, SectionCard, StatusBadge } from "@/components/DesignSystem";
import { ProductionSignInButton } from "@/components/ProductionSignInButton";
import { previewAuthEnabled } from "@/lib/preview-auth-policy";
import { getProductionAuthConfig } from "@/lib/production-auth";

const previewRoles: Role[] = [
  "system_owner",
  "local_admin",
  "membership_data_manager",
  "cat_admin",
  "cat_lead",
  "cat_member",
  "report_viewer",
];

export default function SignInPage({ searchParams }: { searchParams?: Promise<{ next?: string }> }) {
  void searchParams;
  const preview = previewAuthEnabled();
  const production = getProductionAuthConfig();

  return (
    <main className="content" style={{ maxWidth: 760 }}>
      <PageHeader
        eyebrow={preview ? "Private operational preview" : "Private Local 801 workspace"}
        title="Sign in to Local 801 Engage"
        description={preview
          ? "Use a synthetic role session to verify the workspace. This test mechanism is separate from production authentication."
          : "Sign in through the configured organization identity provider. Local 801 revalidates your active account, MFA assurance, role, and session version on the server."}
      />

      {preview ? <>
        <AlertBanner title="Synthetic Preview" tone="preview">No real member data. Preview role cookies are test state and are never accepted as production authentication.</AlertBanner>
        <SectionCard title="Choose a preview role" badge={<StatusBadge tone="preview">Synthetic only</StatusBadge>}>
          <form className="grid" action="/api/auth/preview" method="post">
            <div className="field">
              <label htmlFor="role">Role</label>
              <select id="role" name="role" defaultValue="local_admin">
                {previewRoles.map((role) => <option value={role} key={role}>{roleLabels[role]}</option>)}
              </select>
            </div>
            <button className="button" type="submit">Continue</button>
          </form>
        </SectionCard>
      </> : production.enabled ? <>
        <AlertBanner title="MFA required">The configured identity provider must return a verified email and the required MFA assurance claim. Browser-supplied roles are ignored.</AlertBanner>
        <SectionCard title="Organization sign-in" badge={<StatusBadge tone="ready">OIDC + MFA</StatusBadge>}>
          <ProductionSignInButton providerId={production.providerId} providerName={production.providerName} />
          <p className="muted">Access is granted only to an active Local 801 user already provisioned in the application database.</p>
        </SectionCard>
      </> : (
        <SectionCard>
          <AlertBanner title="Authentication not configured" tone="warning">Production authentication is disabled. An administrator must configure the approved OIDC provider before this workspace can accept production sign-ins.</AlertBanner>
        </SectionCard>
      )}
    </main>
  );
}
