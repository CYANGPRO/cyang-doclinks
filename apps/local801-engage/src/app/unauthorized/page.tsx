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
  const description = !user
    ? "Sign in to continue. After authentication, you’ll return to the requested Local 801 page when your role allows it."
    : isPreview
      ? `You’re using ${roleLabel} access. Choose an available area or switch synthetic Preview roles.`
      : `You’re using ${roleLabel} access. Choose an area available to your production account.`;

  return (
    <div className="content">
      <PageHeader eyebrow="Access restricted" title="This page isn’t available for your role" description={description} />
      <SectionCard>
        <UnavailableState
          title="No protected information was shown"
          description="Your current permissions were checked before this page could load."
          action={<div className="page-actions">
            {user ? <Link className="button" href={recoveryHref}>{recoveryLabel}</Link> : <Link className="button" href={signInHref}>Sign in</Link>}
            {isPreview && user ? <Link className="button secondary" href={signInHref}>Switch Preview role</Link> : null}
          </div>}
        />
      </SectionCard>
      <DisclosureCard title="Why you saw this" description="Access is limited by your current Local 801 role">
        <p className="muted">Direct links do not bypass role checks. {isPreview ? "In synthetic Preview, you can switch to another role and safely return to the requested page." : "Production roles are assigned inside CAT and cannot be selected at sign-in. If you expected access, use the account and session menu to sign out, or contact a Local 801 administrator to review your production role."}</p>
        <p className="muted">An administrator should change the role only when the person’s approved duties require it. Signing in with another account is not a substitute for correct access assignment.</p>
      </DisclosureCard>
    </div>
  );
}
