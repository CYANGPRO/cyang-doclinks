import Link from "next/link";
import { redirect } from "next/navigation";
import { ContactCorrectionReviewControls } from "@/components/ContactCorrectionReviewControls";
import { AlertBanner, DataTable, EmptyState, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDateTime } from "@/lib/date-format";
import { contactCorrectionFailureDiagnostic, listContactCorrectionsForReview, type ContactCorrectionReviewItem } from "@/lib/contact-corrections";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

const fieldLabels: Record<string, string> = {
  work_email: "Work email",
  personal_email: "Personal email",
  phone: "Phone",
  mailing_address: "Mailing address",
};

function formatDate(value: string) {
  return formatCatDateTime(value);
}

function PersonName({ item, canOpenMember }: { item: ContactCorrectionReviewItem; canOpenMember: boolean }) {
  return canOpenMember
    ? <Link className="contact-update-person-link" href={`/outreach/${item.personHandle}`}>{item.displayName}</Link>
    : <strong>{item.displayName}</strong>;
}

export default async function ContactCorrectionsPage() {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageImports")) redirect("/unauthorized");
  const canOpenMember = can(user.role, "recordEngagement");

  let items: ContactCorrectionReviewItem[] = [];
  let hasMore = false;
  let unavailable = false;
  try {
    const context = await resolveWorkspaceContext(user);
    const page = await listContactCorrectionsForReview(context);
    items = page.items;
    hasMore = page.hasMore;
  } catch (error) {
    console.error("[local801-contact-correction-safe-failure]", JSON.stringify(contactCorrectionFailureDiagnostic(error)));
    unavailable = true;
  }

  return <ProtectedPage permission="manageImports"><div className="content contact-corrections-page">
    <PageHeader
      eyebrow="Members"
      title="Contact updates"
      description="Review contact information organizers flagged before it changes the member record."
      actions={<div className="page-actions contact-corrections-header-actions"><Link className="button secondary" href="/membership/data-quality">Data quality</Link><Link className="button secondary" href="/imports">Data imports</Link></div>}
    />
    {unavailable ? <UnavailableState title="Contact updates are unavailable" description="We couldn’t safely load the protected review queue, so proposed values are not shown. Reference: CONTACT_UPDATES_UNAVAILABLE." action={<Link className="button secondary" href="/membership/contact-corrections">Try again</Link>} /> :
      <SectionCard className="contact-corrections-review-queue" title="Contact updates waiting for review" description={items.length ? `${items.length}${hasMore ? "+" : ""} proposed ${items.length === 1 && !hasMore ? "update requires" : "updates require"} an approval or rejection decision.` : "No proposed contact changes currently require a decision."} badge={<StatusBadge tone="info">Protected PII</StatusBadge>}>
        {items.length === 0 ? <EmptyState title="No contact updates waiting" description="New updates submitted by organizers will appear here." /> : <>
          {hasMore ? <AlertBanner title="More updates are waiting" tone="warning">This bounded view shows the oldest 50 updates. Review these items and the next waiting updates will appear automatically.</AlertBanner> : null}
          <div className="contact-updates-desktop">
            <DataTable caption="Contact updates waiting for review" headers={["Person", "Contact field", "Current value", "Proposed value", "Submitted", "Action"]}>
              {items.map((item) => <tr key={item.handle}>
                <td><PersonName item={item} canOpenMember={canOpenMember} />{canOpenMember ? <div className="muted contact-update-member-hint">Open outreach record</div> : null}</td>
                <td>{fieldLabels[item.field] ?? item.field}</td>
                <td className="contact-update-value">{item.currentValue ?? <span className="muted">Not on file</span>}</td>
                <td className="contact-update-value"><strong>{item.proposedValue}</strong></td>
                <td>{formatDate(item.submittedAt)}</td>
                <td><ContactCorrectionReviewControls correctionHandle={item.handle} revision={item.revision} /></td>
              </tr>)}
            </DataTable>
          </div>
          <div className="contact-updates-mobile" aria-label="Contact updates waiting for review">
            {items.map((item) => <article className="contact-update-mobile-row" key={item.handle}>
              <div className="contact-update-mobile-heading">
                <h3><PersonName item={item} canOpenMember={canOpenMember} /></h3>
                <span className="muted">{formatDate(item.submittedAt)}</span>
              </div>
              <div className="contact-update-mobile-field"><strong>{fieldLabels[item.field] ?? item.field}</strong></div>
              <dl className="contact-update-comparison">
                <div><dt>Current</dt><dd>{item.currentValue ?? "Not on file"}</dd></div>
                <div><dt>Proposed</dt><dd><strong>{item.proposedValue}</strong></dd></div>
              </dl>
              <ContactCorrectionReviewControls correctionHandle={item.handle} revision={item.revision} />
            </article>)}
          </div>
        </>}
      </SectionCard>}
  </div></ProtectedPage>;
}
