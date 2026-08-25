import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DataTable, DisclosureCard, EmptyState, MembershipStatusDisplay, PageHeader, SectionCard, StatCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { EngagementRecorder } from "@/components/EngagementRecorder";
import { FollowupCompleteButton } from "@/components/FollowupCompleteButton";
import { OutreachAssignmentControl } from "@/components/OutreachAssignmentControl";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDate, formatCatDateTime } from "@/lib/date-format";
import { getEngagementFormOptions } from "@/lib/engagement-recording";
import { getMember360ConnectedContext, type Member360ConnectedContext } from "@/lib/member360";
import { getOutreachWorkspace, OutreachAccessError, type OutreachWorkspace } from "@/lib/outreach";
import { getOutreachAssignmentOptions } from "@/lib/outreach-assignment";
import { getPersonLifecycle, type PersonLifecycleEvent } from "@/lib/person-lifecycle";
import { hydrateEngagementFormOptionsFromProtectedPii, hydrateOutreachAssigneeOptionsFromProtectedPii, hydrateOutreachWorkspaceFromProtectedPii } from "@/lib/pii-protected-outreach-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { member360ContactHref, member360FieldHref, outreachReturnPath } from "@/lib/field-mode";

type Params = Promise<{ handle: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function dateTime(value: string) {
  return formatCatDateTime(value);
}

function responseLabel(value: string) {
  if (value === "willing") return "Willing";
  if (value === "considering") return "Considering";
  if (value === "declined") return "Declined";
  if (value === "completed") return "Completed";
  return value;
}

function methodLabel(value: string) {
  return value.replaceAll("_", " ");
}

function outcomeLabel(value: string) {
  return value.replaceAll("_", " ");
}

function lifecycleLabel(event: PersonLifecycleEvent) {
  const type = event.eventType.replaceAll("_", " ");
  return `${event.kind === "membership" ? "Membership" : "Employment"}: ${type}`;
}

function lifecycleContext(event: PersonLifecycleEvent) {
  if (event.kind === "membership") return "Membership history";
  const details = [event.department, event.workLocation].filter(Boolean);
  return details.length ? details.join(" · ") : "Employment history";
}

function noteVisibilityLabel(value: string | null) {
  switch (value) {
    case "writer_only": return "Only writer";
    case "assigned_scope": return "Assigned outreach team";
    case "cat_members": return "All CATs";
    case "cat_leads": return "LCATs and administrators";
    case "administrators": return "Administrators only";
    default: return null;
  }
}

function contextStatusTone(status: string) {
  if (status === "active" || status === "completed" || status === "complete") return "ready" as const;
  if (status === "closed") return "neutral" as const;
  return "pending" as const;
}

function safeLoadCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{2,64}$/.test(error.code)) {
    return error.code;
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{1,63}$/.test(error.name) ? error.name : "OUTREACH_LOAD_FAILED";
}

export default async function OutreachEmployeePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const [{ handle }, parameters] = await Promise.all([params, searchParams]);
  const returnHref = outreachReturnPath(parameters.returnTo);
  const returnLabel = returnHref === "/outreach" ? "Back to my list" : "Back to filtered list";
  let workspace: OutreachWorkspace | null = null;
  let formOptions: Awaited<ReturnType<typeof getEngagementFormOptions>> | null = null;
  let assignmentOptions: Awaited<ReturnType<typeof getOutreachAssignmentOptions>> = [];
  let lifecycle: PersonLifecycleEvent[] = [];
  let lifecycleUnavailable = false;
  let connected: Member360ConnectedContext | null = null;
  let connectedUnavailable = false;
  let unavailable = false;
  let unavailableCode = "OUTREACH_LOAD_FAILED";
  let protectedReadEnabled = false;
  try {
    const context = await resolveWorkspaceContext(user);
    const [core, lifecycleResult, connectedResult] = await Promise.all([
      Promise.all([
        getOutreachWorkspace(context, handle),
        getEngagementFormOptions(context, handle),
        can(user.role, "assignOutreach") ? getOutreachAssignmentOptions(context) : Promise.resolve([]),
      ]),
      getPersonLifecycle(context, handle)
        .then((value) => ({ value, unavailable: false }))
        .catch(() => ({ value: [] as PersonLifecycleEvent[], unavailable: true })),
      getMember360ConnectedContext(context, handle)
        .then((value) => ({ value, unavailable: false }))
        .catch(() => ({ value: null, unavailable: true })),
    ]);
    const [legacyWorkspace, legacyFormOptions, rawAssignmentOptions] = core;
    lifecycle = lifecycleResult.value;
    lifecycleUnavailable = lifecycleResult.unavailable;
    connected = connectedResult.value;
    connectedUnavailable = connectedResult.unavailable;
    [workspace, formOptions, assignmentOptions] = await Promise.all([
      hydrateOutreachWorkspaceFromProtectedPii(context.organizationId, context.userId, legacyWorkspace),
      hydrateEngagementFormOptionsFromProtectedPii(context.organizationId, legacyFormOptions),
      can(user.role, "assignOutreach")
        ? hydrateOutreachAssigneeOptionsFromProtectedPii(context.organizationId, rawAssignmentOptions)
        : Promise.resolve([]),
    ]);
    protectedReadEnabled = isPiiProtectedReadEnabled();
  } catch (error) {
    if (error instanceof OutreachAccessError) notFound();
    unavailableCode = safeLoadCode(error);
    console.error("[outreach-workspace] load-failed", { code: unavailableCode, role: user.role });
    unavailable = true;
  }

  if (!workspace || !formOptions) {
    return <ProtectedPage permission="recordEngagement"><div className="content member360-page member360-unavailable-page">
      <PageHeader eyebrow="Member outreach" title="Outreach record unavailable" description="The person-level outreach record could not be opened." actions={<Link className="button secondary" href={returnHref}>{returnLabel}</Link>} />
      <SectionCard><UnavailableState title="Outreach record unavailable" description={unavailable ? `We couldn’t load the protected member information. Reference: ${unavailableCode}.` : "This person is not part of the work currently assigned to you."} /></SectionCard>
    </div></ProtectedPage>;
  }

  const posture = workspace.actionReadiness.posture === "declines_all" ? "Declines all actions"
    : workspace.actionReadiness.posture === "open_to_actions" ? "Open to actions"
    : "Not recorded";
  const organizationWide = user.role === "system_owner" || user.role === "local_admin" || user.role === "cat_admin" || user.role === "cat_lead";
  const overdueFollowups = workspace.followups.filter((item) => item.overdue).length;
  const activeCampaigns = connected?.campaigns.filter((item) => item.status === "active").length ?? 0;
  const missingCoreFields = [
    !workspace.workEmail ? "Work email" : null,
    !workspace.department ? "Department" : null,
    !workspace.classification ? "Classification" : null,
    !workspace.workLocation ? "Work location" : null,
  ].filter((value): value is string => Boolean(value));

  return <ProtectedPage permission="recordEngagement"><div className="content member360-page">
    <PageHeader eyebrow="Member outreach" title={workspace.displayName} description="Review this person’s work details, assignments, recorded conversations, follow-ups, campaign participation, and action responses." actions={<div className="page-actions member360-header-actions">
      <a className="button member360-header-record-action" href="#record-conversation">Record conversation</a>
      <Link className="button secondary member360-header-contact-action" href={member360ContactHref(workspace.handle, returnHref)}>Contact info</Link>
      <Link className="button secondary member360-header-field-action" href={member360FieldHref(workspace.handle, returnHref)}>Open field view</Link>
      <Link className="button tertiary member360-header-return-action" href={returnHref}>{returnLabel}</Link>
    </div>} />

    <nav className="member360-sticky-actions member360-mobile-actions" aria-label="Outreach record quick actions">
      <a className="button member360-mobile-record-action" href="#record-conversation">Record</a>
      <Link className="button secondary member360-mobile-return-action" href={returnHref}>{returnLabel}</Link>
    </nav>

    <SectionCard className="member360-summary" title="Membership and assignment details" description={<MembershipStatusDisplay status={workspace.membershipStatus} />} badge={protectedReadEnabled ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}>
      <div className="review-summary">
        <div><strong>Department</strong><div>{workspace.department || "Not recorded"}{workspace.section ? ` · ${workspace.section}` : ""}</div></div>
        <div><strong>Classification</strong><div>{workspace.classification || "Not recorded"}</div></div>
        <div><strong>Section name</strong><div>{workspace.section || workspace.workLocation || "Not recorded"}</div></div>
        <div><strong>Your role</strong><div>{workspace.assignmentRelationship === "primary" ? "Primary organizer" : workspace.assignmentRelationship === "backup" ? "Backup organizer" : "View only"} · {workspace.activeAssignmentCount} active</div></div>
        <div><strong>Campaigns</strong><div>{workspace.campaignNames.length ? workspace.campaignNames.join(", ") : "No active campaign assignment"}</div></div>
        <div><strong>Work email</strong><div>{workspace.workEmail ? <a href={`mailto:${workspace.workEmail}`}>{workspace.workEmail}</a> : "Not recorded"}</div></div>
      </div>
    </SectionCard>

    {can(user.role, "assignOutreach") ? <DisclosureCard title="Manage outreach assignment" description="Choose the primary LCAT or CAT responsible for this member, or delete the current direct assignment. Campaign assignments, follow-ups, conversations, and audit history remain unchanged." className="route-secondary-panel member360-assignment-panel">
      <OutreachAssignmentControl
        memberHandle={workspace.handle}
        memberName={workspace.displayName}
        assignees={assignmentOptions}
        canDelete={workspace.activeDirectAssignmentCount > 0}
        returnHref={returnHref}
      />
    </DisclosureCard> : null}

    <SectionCard className="member360-open-work" title="Current outreach work" description="Counts of active assignments, open follow-ups, active campaigns, and action responses recorded for this person. These are not performance scores.">
      <section className="metrics-grid" aria-label="Open work summary">
        <StatCard label="Active assignments" value={workspace.activeAssignmentCount} detail="Current assignments" tone={workspace.activeAssignmentCount ? "brand" : "default"} />
        <StatCard label="Open follow-ups" value={workspace.followups.length} detail={`${overdueFollowups} overdue`} tone={overdueFollowups ? "attention" : "default"} />
        <StatCard label="Active campaigns" value={activeCampaigns} detail="Current campaign involvement" />
        <StatCard label="Action responses" value={connected?.scopedReadiness.length ?? 0} detail="Campaign and CAT Action responses" />
      </section>
    </SectionCard>

    <SectionCard className="member360-primary-recorder" id="record-conversation" title="Record a conversation" description="Save what happened, update action readiness, and add a follow-up if you need one.">
      <EngagementRecorder
        employeeHandle={workspace.handle}
        assignments={formOptions.assignments}
        assignees={formOptions.assignees}
        actionDefinitions={formOptions.actionDefinitions}
        currentActions={workspace.actionReadiness.actions}
        organizationWide={organizationWide}
      />
    </SectionCard>

    <DisclosureCard className="member360-data-availability" title="What we have on file" description="Check which core details are available. Missing information is flagged; nothing is guessed.">
      {missingCoreFields.length === 0 ? <StatusBadge tone="ready">Core details available</StatusBadge>
        : <div><StatusBadge tone="warning">{missingCoreFields.length} field{missingCoreFields.length === 1 ? "" : "s"} not recorded</StatusBadge><p className="muted">Not recorded: {missingCoreFields.join(", ")}. Use the approved roster or import correction process instead of guessing or editing protected identity information here.</p></div>}
    </DisclosureCard>

    <DisclosureCard className="member360-campaign-history" title="Campaigns" description="View current and closed campaign participation. This does not change campaign membership.">
      {connectedUnavailable ? <UnavailableState title="Campaigns unavailable" description="The rest of the outreach record is available, but CAT could not load the campaign information." />
        : !connected || connected.campaigns.length === 0 ? <EmptyState title="No campaign history" description="This person is not currently recorded in a campaign population or assignment history." />
        : <DataTable caption={`${workspace.displayName} campaign participation`} headers={["Campaign", "Campaign status", "Assignment", "Due"]}>
          {connected.campaigns.map((campaign) => <tr key={campaign.handle}>
            <td>{can(user.role, "manageCampaigns") ? <Link href={`/campaigns/${campaign.handle}`}><strong>{campaign.name}</strong></Link> : <strong>{campaign.name}</strong>}</td>
            <td><StatusBadge tone={contextStatusTone(campaign.status)}>{campaign.status}</StatusBadge></td>
            <td>{campaign.assignmentStatus?.replaceAll("_", " ") ?? "Population only"}</td>
            <td>{campaign.assignmentDueAt ? dateTime(campaign.assignmentDueAt) : "Not set"}</td>
          </tr>)}
        </DataTable>}
    </DisclosureCard>

    <DisclosureCard className="member360-scoped-readiness" title="Campaign & action readiness" description="These responses belong to the campaign or CAT Action shown. CAT does not reuse them as a commitment to different work.">
      {connectedUnavailable ? <UnavailableState title="Campaign and action responses unavailable" description="General action readiness is still available below, but CAT could not load the campaign and CAT Action details." />
        : !connected || connected.scopedReadiness.length === 0 ? <EmptyState title="No campaign-specific responses" description="There are no current campaign- or CAT Action-specific responses for this person." />
        : <DataTable caption={`${workspace.displayName} scoped Action Readiness`} headers={["Context", "Action", "Response", "Updated"]}>
          {connected.scopedReadiness.map((item, index) => <tr key={`${item.scope}:${item.parentHandle ?? item.parentName}:${item.actionLabel}:${index}`}>
            <td>{item.parentHandle && item.scope === "campaign" && can(user.role, "manageCampaigns") ? <Link href={`/campaigns/${item.parentHandle}`}><strong>{item.parentName}</strong></Link>
              : item.parentHandle && item.scope === "cat_action" && can(user.role, "manageCatActions") ? <Link href={`/cat-actions/${item.parentHandle}`}><strong>{item.parentName}</strong></Link>
                : <strong>{item.parentName}</strong>}<div className="muted">{item.scope.replaceAll("_", " ")} · {item.parentStatus}</div></td>
            <td>{item.actionLabel}</td>
            <td><StatusBadge tone={item.response === "willing" || item.response === "completed" ? "ready" : item.response === "declined" ? "warning" : "pending"}>{responseLabel(item.response)}</StatusBadge></td>
            <td>{dateTime(item.updatedAt)}</td>
          </tr>)}
        </DataTable>}
    </DisclosureCard>

    <DisclosureCard className="member360-lifecycle-history" title="Membership & employment history" description="See recorded changes with their effective dates instead of trying to infer the past from today’s profile.">
      {lifecycleUnavailable ? <UnavailableState title="History unavailable" description="The rest of the outreach record is available, but CAT could not load the membership and employment history." />
        : lifecycle.length === 0 ? <EmptyState title="No history recorded" description="No membership or employment events are recorded for this person yet." />
        : <DataTable caption={`${workspace.displayName} employment and membership history`} headers={["Effective date", "Event", "Context"]}>
          {lifecycle.map((event, index) => <tr key={`${event.effectiveDate}:${event.kind}:${event.eventType}:${index}`}>
            <td>{formatCatDate(event.effectiveDate)}</td>
            <td><strong>{lifecycleLabel(event)}</strong></td>
            <td>{lifecycleContext(event)}</td>
          </tr>)}
        </DataTable>}
    </DisclosureCard>

    <DisclosureCard className="member360-action-readiness" title="Organizing responses" description={`Current response pattern: ${posture}. View recorded willingness, consideration, decline, and completion history.`}>
      {workspace.actionReadiness.actions.length === 0 ? <EmptyState title="No action readiness yet" description="No current willingness, consideration, decline, or completed action is recorded for this person." />
        : <div className="stack">{workspace.actionReadiness.actions.map((action) => <article className="section-card" key={action.handle}>
          <div className="section-heading"><div><h3>{action.label}</h3><p>Commitment level {action.engagementLevel} · {action.scope.replaceAll("_", " ")}</p></div><StatusBadge tone={action.response === "willing" || action.response === "completed" ? "ready" : action.response === "declined" ? "warning" : "pending"}>{responseLabel(action.response)}</StatusBadge></div>
          <p className="muted">Updated {dateTime(action.lastUpdatedAt)} · {action.responseHistoryCount} recorded response{action.responseHistoryCount === 1 ? "" : "s"}</p>
        </article>)}</div>}
    </DisclosureCard>

    <section className="member360-followups-anchor" id="open-followups" aria-label="Open follow-ups">
    <DisclosureCard className="member360-open-followups" title="Open follow-ups" description={`${workspace.followups.length} ${workspace.followups.length === 1 ? "follow-up is" : "follow-ups are"} currently open for this person.`} defaultOpen={overdueFollowups > 0}>
      {workspace.followups.length === 0 ? <EmptyState title="No open follow-ups" description="There is nothing waiting for follow-up right now." />
        : <div className="stack">{workspace.followups.map((item) => <div className="review-summary" key={item.handle}>
          <div><strong>Due</strong><div>{dateTime(item.dueAt)}</div></div>
          <div><strong>Assigned to</strong><div>{item.assignee || "Unassigned"}</div></div>
          <div><strong>Status</strong><div><StatusBadge tone={item.overdue ? "danger" : "pending"}>{item.overdue ? "Overdue" : "Open"}</StatusBadge></div></div>
          <div><strong>Action</strong><div><FollowupCompleteButton employeeHandle={workspace.handle} followupHandle={item.handle} personName={workspace.displayName} /></div></div>
        </div>)}</div>}
    </DisclosureCard>
    </section>

    <DisclosureCard className="member360-conversation-history" title="Recent conversations" description="View the latest 10 recorded contacts. Notes follow your role and assignment access.">
      {workspace.recentEngagements.length === 0 ? <EmptyState title="No conversations recorded" description="There are no recorded contacts for this person yet." />
        : <div className="stack">{workspace.recentEngagements.map((event, index) => <div className="review-summary" key={`${event.occurredAt}-${index}`}>
          <div><strong>When</strong><div>{dateTime(event.occurredAt)}</div></div>
          <div><strong>Method</strong><div>{methodLabel(event.contactMethod)}</div></div>
          <div><strong>Outcome</strong><div>{outcomeLabel(event.outcome)}</div></div>
          {event.note ? <div className="full-span"><strong>Note</strong><div>{event.note}</div>{event.noteVisibility ? <small className="muted">Visible to: {noteVisibilityLabel(event.noteVisibility)}</small> : null}</div> : null}
        </div>)}</div>}
    </DisclosureCard>
  </div></ProtectedPage>;
}
