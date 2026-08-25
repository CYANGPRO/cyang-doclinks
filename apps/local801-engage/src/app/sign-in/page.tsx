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
          ? "Choose a role to see how CAT works for that user. Preview stays separate from Production and never connects to Production member records."
          : "CAT is a private workspace for approved Local 801 users. Sign in with the Microsoft account named in your invitation. Your CAT role determines what you can see and do."}
      />

      {preview ? <>
        <SectionCard
          title={switchingPreviewRole ? "Switch Preview role" : "Choose a Preview role"}
          description="Each option uses isolated Preview records and the same permissions as that role in CAT."
        >
          <PreviewRoleForm csrfToken={previewCsrfToken} currentRole={currentPreviewUser?.role ?? "local_admin"} nextPath={nextPath} switching={switchingPreviewRole} />
        </SectionCard>
      </> : productionRuntime ? <>
        <SignInErrorDialog initialProblem={authenticationProblem} />
        {resetRequested ? <AlertBanner title="Sign-in reset" tone="info">
          Your previous CAT session has been cleared. Continue below and choose the Microsoft account named in your Local 801 invitation.
        </AlertBanner> : null}
        {authenticationProblem ? <AlertBanner title={authenticationProblem.title} tone="danger">
          <p>{authenticationProblem.description}</p>
          <ol className="step-list">{authenticationProblem.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p><strong>Support reference:</strong> <code>{authenticationProblem.reference}</code></p>
        </AlertBanner> : null}
        <AlertBanner title="Approved accounts only" tone="warning">
          CAT does not offer public sign-up. Before you can get in, a Local 801 administrator must approve your account, activate it in CAT, and give it one role. You will also complete Microsoft MFA.
        </AlertBanner>
        <SectionCard
          title="Before you sign in"
          description="You need all four items below. Finishing the Microsoft password screen by itself does not open CAT."
          className="sign-in-access-card"
        >
          <ol className="sign-in-checklist">
            <li><strong>Invited Microsoft account</strong><span>Use the account named in your Local 801 invitation.</span></li>
            <li><strong>Active CAT account</strong><span>A Local 801 administrator must create and activate your CAT account.</span></li>
            <li><strong>One CAT role</strong><span>Your role controls the pages, people, and actions available to you.</span></li>
            <li><strong>Multi-factor authentication</strong><span>Complete the Microsoft verification prompt during sign-in.</span></li>
          </ol>
        </SectionCard>
        <SectionCard title="Sign in with Microsoft" description="Use the account named in your Local 801 invitation.">
          <ProductionSignInButton providerId={production.providerId} providerName={production.providerName} callbackUrl={nextPath} forceAccountSelection={resetRequested} />
          <p className="muted">If CAT sent you back here while you were working, your session may have expired or your access may have changed. Sign in again, then check the role shown in your account menu.</p>
        </SectionCard>
        <DisclosureCard title="Having trouble signing in?" description="Try these steps before contacting support">
          <ul className="sign-in-help-list">
            <li><strong>Access denied:</strong> ask an administrator to confirm that the same email is approved in Microsoft Entra and active in CAT with one role.</li>
            <li><strong>Returned here after MFA:</strong> reset sign-in and choose the account named in your invitation.</li>
            <li><strong>Sign-in expired:</strong> close older CAT sign-in tabs, allow required cookies, and start again here.</li>
            <li><strong>Wrong role:</strong> sign out and ask an administrator to review your CAT role. You cannot choose a Production role during sign-in.</li>
          </ul>
          <p className="muted">Never send anyone your password, MFA code, recovery code, client secret, or encryption key.</p>
        </DisclosureCard>
      </> : production.enabled ? (
        <SectionCard>
          <AlertBanner title="Sign-in is not open yet" tone="warning">CAT is online for final checks, but Production sign-in will stay closed until the required launch review is complete.</AlertBanner>
        </SectionCard>
      ) : (
        <SectionCard>
          <AlertBanner title="Sign-in is not ready" tone="warning">A CAT administrator still needs to finish the approved Microsoft sign-in setup.</AlertBanner>
        </SectionCard>
      )}
    </div>
  );
}
