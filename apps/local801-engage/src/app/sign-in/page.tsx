import Image from "next/image";
import { redirect } from "next/navigation";
import { AlertBanner, DisclosureCard, PageHeader, SectionCard } from "@/components/DesignSystem";
import { ProductionSignInButton } from "@/components/ProductionSignInButton";
import { PreviewRoleForm } from "@/components/PreviewRoleForm";
import { SignInErrorDialog } from "@/components/SignInErrorDialog";
import { previewAuthEnabled } from "@/lib/preview-auth-policy";
import { getProductionAuthConfig } from "@/lib/production-auth";
import { productionAuthRuntimeEnabled } from "@/lib/production-launch-policy";
import { safeReturnPath } from "@/lib/safe-return-path";
import { authenticationProblemFor } from "@/lib/user-facing-errors";
import { getPolicyAcknowledgementUser, getPreviewUser } from "@/lib/authz.server";
import { issuePreviewCsrfToken } from "@/lib/preview-csrf";

export default async function SignInPage({ searchParams }: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const input = await searchParams;
  const nextPath = safeReturnPath(input?.next);
  const resetRequested = (Array.isArray(input?.reset) ? input.reset[0] : input?.reset) === "1";
  const authenticationProblem = authenticationProblemFor(input?.error);
  const preview = previewAuthEnabled();
  const production = getProductionAuthConfig();
  const productionRuntime = production.enabled && productionAuthRuntimeEnabled();
  const pendingPolicyUser = preview ? null : await getPolicyAcknowledgementUser();
  if (pendingPolicyUser) redirect(`/privacy?next=${encodeURIComponent(nextPath)}`);
  const currentPreviewUser = preview ? await getPreviewUser() : null;
  const switchingPreviewRole = Boolean(currentPreviewUser);
  const previewCsrfToken = preview ? issuePreviewCsrfToken(nextPath) : "";

  return (
    <div className="content sign-in-content">
      <div className="sign-in-brand">
        <Image alt="MAPE" height={771} loading="eager" sizes="180px" src="/brand/mape-logo.png" width={920} />
        <span>Engaging Local 801</span>
      </div>
      <PageHeader
        eyebrow={preview ? "Private preview" : "Local 801 workspace"}
        title={preview ? "Choose how you want to explore" : "Sign in to Engaging Local 801"}
        description={preview
          ? "Select a synthetic role. This changes what the Preview shows and never connects to production data. It does not create an account, change production access, or connect to production member records."
          : "This is a private, approval-only workspace. Signing in verifies your identity; your assigned Local 801 role determines which pages, records, and actions you can use."}
      />

      {preview ? <>
        <SectionCard
          title={switchingPreviewRole ? "Switch Preview role" : "Choose a Preview role"}
          description="Each option uses synthetic example.test records and the same server-enforced permissions as the corresponding role."
        >
          <PreviewRoleForm csrfToken={previewCsrfToken} currentRole={currentPreviewUser?.role ?? "local_admin"} nextPath={nextPath} switching={switchingPreviewRole} />
        </SectionCard>
      </> : productionRuntime ? <>
        <SignInErrorDialog initialProblem={authenticationProblem} />
        {resetRequested ? <AlertBanner title="Sign-in reset" tone="info">
          The previous CAT session was cleared. Continue below and choose the exact Microsoft account named in your Local 801 invitation.
        </AlertBanner> : null}
        {authenticationProblem ? <AlertBanner title={authenticationProblem.title} tone="danger">
          <p>{authenticationProblem.description}</p>
          <ol className="step-list">{authenticationProblem.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p><strong>Support reference:</strong> <code>{authenticationProblem.reference}</code></p>
        </AlertBanner> : null}
        <AlertBanner title="Approved accounts only" tone="warning">
          There is no public registration or automatic access. Microsoft sign-in succeeds only after a Local 801 administrator has approved the account, activated it in CAT, and assigned exactly one role. MFA is also required.
        </AlertBanner>
        <SectionCard
          title="Before you sign in"
          description="All four checks must pass. Completing the Microsoft password screen alone does not grant CAT access."
          className="sign-in-access-card"
        >
          <ol className="sign-in-checklist">
            <li><strong>Approved identity</strong><span>Use the exact Microsoft account invited to the Local 801 Entra application.</span></li>
            <li><strong>Active CAT account</strong><span>Your account must already exist in Engaging Local 801 and must not be deactivated.</span></li>
            <li><strong>One assigned role</strong><span>Your role is stored and enforced by CAT. A browser or Microsoft token cannot choose or elevate it.</span></li>
            <li><strong>Multi-factor authentication</strong><span>Complete the MFA prompt so Microsoft can provide the required assurance.</span></li>
          </ol>
        </SectionCard>
        <SectionCard title="Organization sign-in" description="Use the approved account for your assigned Local 801 role.">
          <ProductionSignInButton providerId={production.providerId} providerName={production.providerName} callbackUrl={nextPath} forceAccountSelection={resetRequested} />
          <p className="muted">If you arrived here while already working, your session may have expired or an administrator may have changed your access. Start a new sign-in and verify the current role shown in the account menu.</p>
        </SectionCard>
        <DisclosureCard title="Having trouble signing in?" description="Common causes and safe recovery steps">
          <ul className="sign-in-help-list">
            <li><strong>Access denied:</strong> confirm the account is assigned in Entra and provisioned in CAT with one role.</li>
            <li><strong>Returned to this page after MFA:</strong> use the exact invited account, then ask an administrator to confirm its active CAT role.</li>
            <li><strong>Callback or expired attempt:</strong> close older sign-in tabs, allow required cookies, and start again here.</li>
            <li><strong>Unexpected role:</strong> sign out and ask an administrator to review the CAT role. Roles cannot be selected during Production sign-in.</li>
          </ul>
          <p className="muted">Never send anyone your password, MFA code, recovery code, client secret, or encryption key.</p>
        </DisclosureCard>
      </> : production.enabled ? (
        <SectionCard>
          <AlertBanner title="Sign-in is not open yet" tone="warning">This deployment is active for launch verification, but organization sign-in remains locked until the approved Production readiness checks pass.</AlertBanner>
        </SectionCard>
      ) : (
        <SectionCard>
          <AlertBanner title="Sign-in is not configured" tone="warning">Production sign-in is turned off until an administrator configures the approved OIDC provider.</AlertBanner>
        </SectionCard>
      )}
    </div>
  );
}
