import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ContactCorrectionForm } from "@/components/ContactCorrectionForm";
import { AlertBanner, DisclosureCard, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { ContactCorrectionError, getVisibleContactActions, type VisibleContactActions } from "@/lib/contact-corrections";
import { fieldContextFromOutreachReturnPath, fieldPersonHref, fieldQueueHref, member360Href, normalizeFieldModeContext, outreachReturnPath } from "@/lib/field-mode";
import { getOutreachWorkspace, OutreachAccessError, type OutreachWorkspace } from "@/lib/outreach";
import { hydrateOutreachWorkspaceFromProtectedPii } from "@/lib/pii-protected-outreach-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type Params = Promise<{ handle: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function smsHref(phone: string) {
  return `sms:${phone.replace(/[^+\d]/g, "")}`;
}
function telHref(phone: string) {
  return `tel:${phone.replace(/[^+\d]/g, "")}`;
}

export default async function OutreachContactPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");
  const [{ handle }, parameters] = await Promise.all([params, searchParams]);
  const fieldContext = normalizeFieldModeContext(parameters);
  const returnHref = fieldContext.enabled ? fieldQueueHref(fieldContext) : outreachReturnPath(parameters.returnTo);
  const fieldHref = fieldPersonHref(handle, fieldContext.enabled ? fieldContext : fieldContextFromOutreachReturnPath(returnHref));
  const memberHref = member360Href(handle, returnHref);

  let workspace: OutreachWorkspace | null = null;
  let contacts: VisibleContactActions = { workEmail: null, phone: null };
  let unavailable = false;
  try {
    const context = await resolveWorkspaceContext(user);
    const [legacyWorkspace, visibleContacts] = await Promise.all([
      getOutreachWorkspace(context, handle),
      getVisibleContactActions(context, handle),
    ]);
    workspace = await hydrateOutreachWorkspaceFromProtectedPii(context.organizationId, context.userId, legacyWorkspace);
    contacts = visibleContacts;
  } catch (error) {
    if (error instanceof OutreachAccessError || (error instanceof ContactCorrectionError && error.status === 404)) notFound();
    unavailable = true;
  }

  if (unavailable || !workspace) {
    return <ProtectedPage permission="recordEngagement"><div className="content member360-contact-page member360-contact-unavailable-page">
      <PageHeader eyebrow="Member outreach · Contact" title="Contact information unavailable" description="We couldn’t load the protected contact details for this person." actions={<Link className="button secondary" href={memberHref}>Back to outreach record</Link>} />
      <SectionCard><UnavailableState title="Contact info unavailable" description="We couldn’t verify your access to this protected contact information, so nothing is shown in its place." /></SectionCard>
    </div></ProtectedPage>;
  }

  return <ProtectedPage permission="recordEngagement"><div className="content member360-contact-page">
    <PageHeader
      eyebrow="Member outreach · Contact"
      title={`${workspace.displayName} · Contact`}
      description="Call, text, or email using the contact details available to you. If something is wrong, send a correction to Membership Data for review."
      actions={<div className="page-actions member360-contact-header-actions"><Link className="button secondary member360-contact-return-action" href={memberHref}>Back to outreach record</Link><Link className="button secondary member360-contact-field-action" href={fieldHref}>Field view</Link></div>}
    />
    <SectionCard className="member360-contact-primary-actions" title="Available contact methods" badge={<StatusBadge tone="info">Protected PII</StatusBadge>}>
      <div className="review-summary">
        <div><strong>Work email</strong><div>{contacts.workEmail ? <a href={`mailto:${contacts.workEmail}`}>{contacts.workEmail}</a> : "Not available to you"}</div></div>
        <div><strong>Phone</strong><div>{contacts.phone ?? "Not available to you"}</div></div>
      </div>
      {contacts.phone ? <div className="page-actions member360-contact-actions"><a className="button member360-contact-call-action" href={telHref(contacts.phone)}>Call</a><a className="button secondary member360-contact-text-action" href={smsHref(contacts.phone)}>Text</a></div> : null}
      {contacts.workEmail ? <div className="page-actions member360-contact-actions"><a className="button secondary member360-contact-email-action" href={`mailto:${contacts.workEmail}`}>Email</a></div> : null}
    </SectionCard>

    <DisclosureCard className="member360-contact-privacy" title="Contact privacy and availability" description="Details are limited to your access and are not saved for offline use.">
      <AlertBanner title="Protected contact info" tone="preview">You’ll only see contact details available to you for this person. They are not saved for offline use.</AlertBanner>
    </DisclosureCard>

    <DisclosureCard className="member360-contact-correction" title="Report incorrect contact info" description="Send a correction to Membership Data for approval; the official record does not change immediately.">
      <ContactCorrectionForm employeeHandle={handle} />
    </DisclosureCard>
  </div></ProtectedPage>;
}
