import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertBanner, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { EngagementRecorder } from "@/components/EngagementRecorder";
import { FieldConnectionStatus } from "@/components/FieldConnectionStatus";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDateTime } from "@/lib/date-format";
import { getEngagementFormOptions } from "@/lib/engagement-recording";
import { fieldContactHref, fieldQueueHref, member360Href, normalizeFieldModeContext } from "@/lib/field-mode";
import { getOutreachWorkspace, OutreachAccessError, type OutreachWorkspace } from "@/lib/outreach";
import { hydrateEngagementFormOptionsFromProtectedPii, hydrateOutreachWorkspaceFromProtectedPii } from "@/lib/pii-protected-outreach-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type Params = Promise<{ handle: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function dateTime(value: string) {
  return formatCatDateTime(value);
}

export default async function FieldOutreachPersonPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const [{ handle }, parameters] = await Promise.all([params, searchParams]);
  const requestedFieldContext = normalizeFieldModeContext({ ...parameters, field: "1" });
  const organizationWide = user.role === "system_owner" || user.role === "local_admin" || user.role === "cat_admin" || user.role === "cat_lead";
  const fieldContext = {
    ...requestedFieldContext,
    scope: organizationWide ? requestedFieldContext.scope : "assigned" as const,
  };
  const returnHref = fieldQueueHref(fieldContext);
  let workspace: OutreachWorkspace | null = null;
  let formOptions: Awaited<ReturnType<typeof getEngagementFormOptions>> | null = null;
  let unavailable = false;
  let protectedReadEnabled = false;

  try {
    const context = await resolveWorkspaceContext(user);
    const [legacyWorkspace, legacyFormOptions] = await Promise.all([
      getOutreachWorkspace(context, handle),
      getEngagementFormOptions(context, handle),
    ]);
    [workspace, formOptions] = await Promise.all([
      hydrateOutreachWorkspaceFromProtectedPii(context.organizationId, context.userId, legacyWorkspace),
      hydrateEngagementFormOptionsFromProtectedPii(context.organizationId, legacyFormOptions),
    ]);
    protectedReadEnabled = isPiiProtectedReadEnabled();
  } catch (error) {
    if (error instanceof OutreachAccessError) notFound();
    unavailable = true;
  }

  if (!workspace || !formOptions) {
    return <ProtectedPage permission="recordEngagement"><div className="content member360-field-page member360-field-unavailable-page">
      <PageHeader eyebrow="Member outreach · Field view" title="Outreach record unavailable" description="We couldn’t load this person for field work." actions={<Link className="button secondary" href={returnHref}>Back to my list</Link>} />
      <FieldConnectionStatus />
      <SectionCard><UnavailableState title="Member unavailable" description={unavailable ? "We couldn’t load the protected member information. Reconnect, then return to your list." : "This person is no longer part of the work currently assigned to you."} /></SectionCard>
    </div></ProtectedPage>;
  }

  const overdueFollowups = workspace.followups.filter((item) => item.overdue).length;
  const posture = workspace.actionReadiness.posture === "declines_all"
    ? "Declines all actions"
    : workspace.actionReadiness.posture === "open_to_actions"
      ? "Open to actions"
      : "Not recorded";

  return <ProtectedPage permission="recordEngagement"><div className="content field-mode-content member360-field-page">
    <PageHeader
      eyebrow="Member outreach · Field view"
      title={workspace.displayName}
      description="Record what happened, update action readiness if needed, add a follow-up, then return to the refreshed list for the next person."
      actions={<div className="page-actions member360-field-header-actions">
        <Link className="button member360-field-return-action" href={returnHref}>Back to my list</Link>
        <Link className="button secondary member360-field-contact-action" href={fieldContactHref(workspace.handle, fieldContext)}>Contact info</Link>
        <Link className="button secondary member360-field-full-action" href={member360Href(workspace.handle, returnHref)}>Full outreach record</Link>
      </div>}
    />

    <nav className="member360-sticky-actions member360-field-mobile-actions" aria-label="Field view quick actions">
      <a className="button member360-field-mobile-record-action" href="#record-field-conversation">Record</a>
      <Link className="button secondary member360-field-mobile-return-action" href={returnHref}>Back to my list</Link>
    </nav>

    <FieldConnectionStatus />
    <AlertBanner title="Field view stays online" tone="preview">
      This page needs a network connection. Member details, form entries, notes, and responses are not saved for offline use. Your list refreshes when you return to it.
    </AlertBanner>

    <SectionCard className="member360-field-summary" title="Contact and assignment details" description={`Membership status: ${workspace.membershipStatus}`} badge={protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}>
      <div className="review-summary">
        <div><strong>Classification</strong><div>{workspace.classification || "Not recorded"}</div></div>
        <div><strong>Department</strong><div>{workspace.department || "Not recorded"}</div></div>
        <div><strong>Section name</strong><div>{workspace.section || workspace.workLocation || "Not recorded"}</div></div>
        <div><strong>Your role</strong><div>{workspace.assignmentRelationship === "primary" ? "Primary organizer" : workspace.assignmentRelationship === "backup" ? "Backup organizer" : "View only"}</div></div>
        <div><strong>Follow-ups</strong><div>{workspace.followups.length ? `${workspace.followups.length} open · ${overdueFollowups} overdue` : "No open follow-up"}</div></div>
        <div><strong>Action readiness</strong><div>{posture}</div></div>
        <div><strong>Campaigns</strong><div>{workspace.campaignNames.length ? workspace.campaignNames.join(", ") : "No active campaign assignment"}</div></div>
        <div><strong>Work email</strong><div>{workspace.workEmail ? <a href={`mailto:${workspace.workEmail}`}>{workspace.workEmail}</a> : "Not recorded"}</div></div>
      </div>
      {workspace.followups.length ? <div className="stack compact-stack">
        {workspace.followups.slice(0, 3).map((item) => <p className="muted" key={item.handle}>{item.overdue ? "Overdue" : "Follow-up"} · {dateTime(item.dueAt)} · {item.assignee || "Unassigned"}</p>)}
      </div> : null}
    </SectionCard>

    <SectionCard className="member360-field-primary-recorder" id="record-field-conversation" title="Record what happened" description="Save the conversation, any action-readiness update, and an optional follow-up while the details are fresh.">
      <EngagementRecorder
        employeeHandle={workspace.handle}
        assignments={formOptions.assignments}
        assignees={formOptions.assignees}
        actionDefinitions={formOptions.actionDefinitions}
        currentActions={workspace.actionReadiness.actions}
        organizationWide={organizationWide}
      />
      <div className="field-next-actions">
        <p className="muted">When you’re done, go back to your list. The next person is chosen from the latest assignments, due dates, and contact history—not from a saved copy of the queue.</p>
        <Link className="button" href={returnHref}>Done · back to my list</Link>
      </div>
    </SectionCard>
  </div></ProtectedPage>;
}
