import Link from "next/link";
import { DisclosureCard, PageHeader, SectionCard, UnavailableState } from "@/components/DesignSystem";
import { roleLabels } from "@/lib/access";
import { getPreviewUser, previewAuthEnabled } from "@/lib/authz.server";
import { safeReturnPath } from "@/lib/safe-return-path";

export default async function UnauthorizedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getPreviewUser();
  const input = await searchParams;
  const requestedDestination = safeReturnPath(input.next);
  const isPreview = previewAuthEnabled() && user?.authentication !== "production";
  const roleLabel = user ? roleLabels[user.role] : "your current role";
  const recoveryHref = user?.role === "report_viewer" ? "/reports" : "/";
  const recoveryLabel = user?.role === "report_viewer" ? "Go to reports" : "Go home";
  const signInHref = `/sign-in?next=${encodeURIComponent(requestedDestination)}`;
  const title = user ? "This page isn’t available for your role" : "Sign in to open this page";
  const description = !user
    ? "Sign in to continue. After authentication, you’ll return to the requested Local 801 page when your role allows it."
    : isPreview
      ? `You’re using ${roleLabel} access. Choose an available area or switch Preview roles.`
      : `You’re using ${roleLabel} access. Choose an area available to your production account.`;

  return (
    <div className="content">
      <PageHeader eyebrow="Access restricted" title={title} description={description} />
      <SectionCard>
        <UnavailableState
          title={user ? "CAT stopped before showing the page" : "CAT needs to verify your account first"}
          description={user ? "Your current role was checked before any protected information could load." : "Sign in, and CAT will check whether your account and role can open this page."}
          action={<div className="page-actions">
            {user ? <Link className="button" href={recoveryHref}>{recoveryLabel}</Link> : <Link className="button" href={signInHref}>Sign in</Link>}
            {isPreview && user ? <Link className="button secondary" href={signInHref}>Switch Preview role</Link> : null}
          </div>}
        />
      </SectionCard>
      <DisclosureCard title="Why you saw this" description="A link cannot give you access that your CAT role does not include">
        <p className="muted">{isPreview ? "In Preview, you can switch to another role and return to the requested page." : "Production roles are assigned inside CAT and cannot be selected at sign-in. If you expected access, sign out from the account menu or ask a Local 801 administrator to review your role."}</p>
        <p className="muted">An administrator should change the role only when the person’s approved duties require it. Signing in with another account is not a substitute for correct access assignment.</p>
      </DisclosureCard>
    </div>
  );
}
