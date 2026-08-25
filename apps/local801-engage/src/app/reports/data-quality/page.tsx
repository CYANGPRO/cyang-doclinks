import Link from "next/link";
import { redirect } from "next/navigation";
import { DisclosureCard, PageHeader, SectionCard, StatCard, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getDataQualitySummary, type DataQualitySummary } from "@/lib/data-quality";
import { enforceAuthenticatedRateLimit } from "@/lib/rate-limit";
import { recordReportAccess, reportFailureDiagnostic } from "@/lib/report-access";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

const emptySummary = (): DataQualitySummary => ({
  flaggedPeople: 0,
  missingIdentifier: 0,
  missingWorkEmail: 0,
  missingDepartment: 0,
  missingClassification: 0,
  missingWorkLocation: 0,
  unknownMembership: 0,
  notInLatestRoster: 0,
  latestRosterAvailable: false,
});

export default async function DataQualityReportPage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "viewReports")) redirect("/unauthorized");
  let summary = emptySummary();
  let unavailable = false;
  try {
    const context = await resolveWorkspaceContext(user);
    const limit = await enforceAuthenticatedRateLimit({ organizationId: context.organizationId, userId: context.userId, policy: "download_export" });
    if (!limit.ok) throw new Error("Report rate limit denied.");
    summary = await getDataQualitySummary(context);
    await recordReportAccess(context, "data-quality");
  } catch (error) {
    console.error("[local801-report-safe-failure]", JSON.stringify(reportFailureDiagnostic(error, "data-quality")));
    unavailable = true;
  }
  const canManage = can(user.role, "manageImports");

  return <ProtectedPage permission="viewReports"><div className="content route-data-quality-report-page reports-workspace-page">
    <PageHeader eyebrow="Reports" title="Data quality report" description="Review totals for common data problems. This report does not show names, emails, identifiers, or person-level rows." actions={<><Link className="button secondary" href="/reports?view=overview">Back to reports</Link>{canManage ? <Link className="button" href="/membership/data-quality">Open data quality queue</Link> : null}</>} />
    {unavailable ? <SectionCard><UnavailableState title="Data quality report unavailable" description="CAT could not verify access to the report data, so no totals are shown. Reference: REPORTS_UNAVAILABLE." action={<Link className="button secondary" href="/reports/data-quality">Try again</Link>} /></SectionCard> : <>
      <div className="metrics-grid" aria-label="Aggregate data quality indicators">
        <StatCard label="People needing review" value={summary.flaggedPeople.toLocaleString()} detail="Distinct active people with one or more explicit issue categories." />
        <StatCard label="Missing employee/member ID" value={summary.missingIdentifier.toLocaleString()} detail="No employee or member identifier record." />
        <StatCard label="Missing work email" value={summary.missingWorkEmail.toLocaleString()} detail="No active work-email contact method." />
        <StatCard label="Missing department" value={summary.missingDepartment.toLocaleString()} detail="Department is blank or missing." />
        <StatCard label="Missing classification" value={summary.missingClassification.toLocaleString()} detail="Classification is blank or missing." />
        <StatCard label="Missing work location" value={summary.missingWorkLocation.toLocaleString()} detail="Work location is blank or missing." />
        <StatCard label="Membership status review" value={summary.unknownMembership.toLocaleString()} detail="Status is not a recognized member/nonmember state." />
        <StatCard label="Latest roster gaps" value={summary.latestRosterAvailable ? summary.notInLatestRoster.toLocaleString() : "—"} detail={summary.latestRosterAvailable ? "Active records absent from the latest approved snapshot; no drop or separation is inferred." : "No approved snapshot is available for comparison."} />
      </div>
      <DisclosureCard title="How CAT calculates these totals" description="This report counts data problems without revealing who is affected." className="route-secondary-panel report-reference-panel">
        <p>CAT checks whether a protected employee record exists, whether required work fields are filled in, and whether the person appears in the latest approved roster. It does not guess membership intent or employment status from names or partial matches.</p>
      </DisclosureCard>
      <DisclosureCard title="How to correct the records" description="Use the review queue for individual issues and Data Imports for approved source-file changes." className="route-secondary-panel report-reference-panel">
        <p>{canManage ? <>Open the <Link href="/membership/data-quality">data quality queue</Link> to find the affected records. Use <Link href="/imports">Data Imports</Link> when the approved source file needs to be corrected so the change is validated, reviewed, protected, and audited.</> : <>Your role can see totals but not the person-level issue list. Membership and Data Imports roles handle those corrections.</>}</p>
      </DisclosureCard>
    </>}
  </div></ProtectedPage>;
}
