import { roleLabels, type Role } from "@/lib/access";
import { AlertBanner, PageHeader, SectionCard, StatusBadge } from "@/components/DesignSystem";
import { ProductionSignInButton } from "@/components/ProductionSignInButton";
import { previewAuthEnabled } from "@/lib/preview-auth-policy";
import { getProductionAuthConfig } from "@/lib/production-auth";
import { productionAuthRuntimeEnabled } from "@/lib/production-launch-policy";

const previewRoles: Role[] = [
  "system_owner",
  "local_admin",
  "membership_data_manager",
  "cat_admin",
  "cat_lead",
  "cat_member",
  "report_viewer",
];

const authenticationErrors: Readonly<Record<string, string>> = Object.freeze({
  AccessDenied: "Microsoft Entra ID authenticated the account, but Local 801 could not authorize it. Confirm that the account is active, provisioned, and completed the required MFA challenge.",
  Configuration: "Organization sign-in is temporarily unavailable because its server configuration could not be validated.",
  OAuthSignin: "Local 801 could not start Microsoft Entra sign-in. Please try again.",
  OAuthCallback: "Microsoft Entra sign-in did not complete successfully. Please try again and complete the MFA challenge.",
  OAuthCreateAccount: "This workspace does not create accounts during sign-in. Ask an administrator to provision the account first.",
  OAuthAccountNotLinked: "The Microsoft Entra identity is not linked to an active Local 801 account.",
  Callback: "Microsoft Entra sign-in did not complete successfully. Please try again.",
  Default: "Organization sign-in did not complete. Please try again; if the problem continues, contact the system administrator.",
});

function authenticationErrorMessage(error: string | string[] | undefined) {
  const code = Array.isArray(error) ? error[0] : error;
  if (!code) return null;
  return authenticationErrors[code] ?? authenticationErrors.Default;
}

export default async function SignInPage({ searchParams }: {
  searchParams?: Promise<{ error?: string | string[]; next?: string | string[] }>;
}) {
  const parameters = searchParams ? await searchParams : {};
  const preview = previewAuthEnabled();
  const production = getProductionAuthConfig();
  const productionRuntime = productionAuthRuntimeEnabled();
  const authenticationError = authenticationErrorMessage(parameters.error);

  return (
    <main className="content" style={{ maxWidth: 760 }}>
      <PageHeader
        eyebrow={preview ? "Private operational preview" : "Private Local 801 workspace"}
        title="Sign in to Local 801 Engage"
        description={preview
          ? "Use a synthetic role session to verify the workspace. This test mechanism is separate from production authentication."
          : "Sign in through the configured organization identity provider. Local 801 revalidates your active account, MFA assurance, role, and session version on the server."}
      />

      {authenticationError ? (
        <AlertBanner title="Sign-in unsuccessful" tone="danger">{authenticationError}</AlertBanner>
      ) : null}

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
      </> : production.enabled && productionRuntime ? <>
        <AlertBanner title="MFA required">The configured identity provider must return a verified email and the required MFA assurance claim. Browser-supplied roles are ignored.</AlertBanner>
        <SectionCard title="Organization sign-in" badge={<StatusBadge tone="ready">OIDC + MFA</StatusBadge>}>
          <ProductionSignInButton providerId={production.providerId} providerName={production.providerName} />
          <p className="muted">Access is granted only to an active Local 801 user already provisioned in the application database.</p>
        </SectionCard>
      </> : production.enabled ? (
        <SectionCard>
          <AlertBanner title="Production access is currently closed" tone="warning">The organization sign-in provider is configured, but the production launch gate is disabled. No Entra sign-in request was started.</AlertBanner>
        </SectionCard>
      ) : (
        <SectionCard>
          <AlertBanner title="Authentication not configured" tone="warning">Production authentication is disabled. An administrator must configure the approved OIDC provider before this workspace can accept production sign-ins.</AlertBanner>
        </SectionCard>
      )}
    </main>
  );
}
