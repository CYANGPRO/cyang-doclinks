import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { EngagementRecorder } from "@/components/EngagementRecorder";
import { FollowupCompleteButton } from "@/components/FollowupCompleteButton";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getEngagementFormOptions } from "@/lib/engagement-recording";
import { getOutreachWorkspace, OutreachAccessError, type OutreachWorkspace } from "@/lib/outreach";
import { hydrateEngagementFormOptionsFromProtectedPii, hydrateOutreachWorkspaceFromProtectedPii } from "@/lib/pii-protected-outreach-read";
import { isPiiProtectedReadEnabled } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

type Params = Promise<{ handle: string }>;

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
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

function noteVisibilityLabel(value: string | null) {
  switch (value) {
    case "writer_only": return "Only writer";
    case "assigned_scope": return "Assigned outreach team";
    case "cat_members": return "All CAT members";
    case "cat_leads": return "CAT leads and administrators";
    case "administrators": return "Administrators only";
    default: return null;
  }
}

export default async function OutreachEmployeePage({ params }: { params: Params }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "recordEngagement")) redirect("/unauthorized");

  const { handle } = await params;
  let workspace: OutreachWorkspace | null = null;
  let formOptions: Awaited<ReturnType<typeof getEngagementFormOptions>> | null = null;
  let unavailable = false;
  let protectedReadEnabled = false;
  try {
    const context = await resolveWorkspaceContext(user);
    const legacyWorkspace = await getOutreachWorkspace(context, handle);
    const legacyFormOptions = await getEngagementFormOptions(context, handle);
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
    return <ProtectedPage permission="recordEngagement"><div className="content">
      <PageHeader eyebrow="Daily organizing" title="Employee workspace" description="Secure employee engagement workspace." actions={<Link className="button secondary" href="/outreach">Back to outreach</Link>} />
      <SectionCard><UnavailableState title="Employee workspace unavailable" description={unavailable ? "The authorized employee and protected-PII context could not be loaded." : "The employee is not available in your current assignment scope."} /></SectionCard>
    </div></ProtectedPage>;
  }

  const posture = workspace.actionReadiness.posture === "declines_all" ? "Declines all actions"
    : workspace.actionReadiness.posture === "open_to_actions" ? "Open to actions"
    : "Not recorded";
  const organizationWide = user.role === "system_owner" || user.role === "local_admin" || user.role === "cat_admin";

  return <ProtectedPage permission="recordEngagement"><div className="content">
    <PageHeader eyebrow="Daily organizing" title={workspace.displayName} description="Record conversations, create follow-ups, and maintain the employee's cumulative Action Readiness profile." actions={<Link className="button secondary" href="/outreach">Back to outreach</Link>} />

    <SectionCard title="Employee" badge={<StatusBadge tone="info">{protectedReadEnabled ? `Protected PII · ${workspace.membershipStatus}` : workspace.membershipStatus}</StatusBadge>}>
      <div className="review-summary">
        <div><strong>Department</strong><div>{workspace.department || "Unavailable"}{workspace.section ? ` · ${workspace.section}` : ""}</div></div>
        <div><strong>Classification</strong><div>{workspace.classification || "Unavailable"}</div></div>
        <div><strong>Work location</strong><div>{workspace.workLocation || "Unavailable"}</div></div>
        <div><strong>Assignment</strong><div>{workspace.assignmentRelationship === "primary" ? "Primary organizer" : workspace.assignmentRelationship === "backup" ? "Backup organizer" : "Authorized view"} · {workspace.activeAssignmentCount} active</div></div>
        <div><strong>Campaigns</strong><div>{workspace.campaignNames.length ? workspace.campaignNames.join(", ") : "No active campaign assignment"}</div></div>
        <div><strong>Work email</strong><div>{workspace.workEmail ? <a href={`mailto:${workspace.workEmail}`}>{workspace.workEmail}</a> : "Unavailable"}</div></div>
      </div>
    </SectionCard>

    <SectionCard title="Engagement recorder" description="Operational updates are authorized and audited on the server.">
      <EngagementRecorder
        employeeHandle={workspace.handle}
        assignments={formOptions.assignments}
        assignees={formOptions.assignees}
        actionDefinitions={formOptions.actionDefinitions}
        currentActions={workspace.actionReadiness.actions}
        organizationWide={organizationWide}
      />
    </SectionCard>

    <SectionCard title="Action Readiness" badge={<StatusBadge tone={workspace.actionReadiness.posture === "declines_all" ? "warning" : "info"}>{posture}</StatusBadge>} description="Current running action profile. Historical responses are preserved when the current state changes.">
      {workspace.actionReadiness.actions.length === 0 ? <EmptyState title="No action readiness recorded" description="No current willingness, consideration, decline, or completed action is recorded for this employee." />
        : <div className="stack">{workspace.actionReadiness.actions.map((action) => <article className="section-card" key={action.handle}>
          <div className="section-heading"><div><h3>{action.label}</h3><p>Engagement level {action.engagementLevel} · {action.scope.replaceAll("_", " ")}</p></div><StatusBadge tone={action.response === "willing" || action.response === "completed" ? "ready" : action.response === "declined" ? "warning" : "pending"}>{responseLabel(action.response)}</StatusBadge></div>
          <p className="muted">Updated {dateTime(action.lastUpdatedAt)} · {action.responseHistoryCount} recorded response{action.responseHistoryCount === 1 ? "" : "s"}</p>
        </article>)}</div>}
    </SectionCard>

    <SectionCard title="Open follow-ups" badge={<StatusBadge tone={workspace.followups.some((item) => item.overdue) ? "warning" : "info"}>{workspace.followups.length} open</StatusBadge>}>
      {workspace.followups.length === 0 ? <EmptyState title="No open follow-ups" description="There is no outstanding follow-up for this employee." />
        : <div className="stack">{workspace.followups.map((item) => <div className="review-summary" key={item.handle}>
          <div><strong>Due</strong><div>{dateTime(item.dueAt)}</div></div>
          <div><strong>Assigned to</strong><div>{item.assignee || "Unassigned"}</div></div>
          <div><strong>Status</strong><div><StatusBadge tone={item.overdue ? "danger" : "pending"}>{item.overdue ? "Overdue" : "Open"}</StatusBadge></div></div>
          <div><strong>Action</strong><div><FollowupCompleteButton employeeHandle={workspace.handle} followupHandle={item.handle} /></div></div>
        </div>)}</div>}
    </SectionCard>

    <SectionCard title="Recent engagement" description="Latest 10 non-voided engagement records. Narrative notes display only when the signed-in role and assignment scope allow them.">
      {workspace.recentEngagements.length === 0 ? <EmptyState title="No engagement recorded" description="No non-voided engagement has been recorded for this employee." />
        : <div className="stack">{workspace.recentEngagements.map((event, index) => <div className="review-summary" key={`${event.occurredAt}-${index}`}>
          <div><strong>When</strong><div>{dateTime(event.occurredAt)}</div></div>
          <div><strong>Method</strong><div>{methodLabel(event.contactMethod)}</div></div>
          <div><strong>Outcome</strong><div>{outcomeLabel(event.outcome)}</div></div>
          {event.note ? <div style={{ gridColumn: "1 / -1" }}><strong>Narrative note</strong><div>{event.note}</div>{event.noteVisibility ? <small className="muted">Visibility: {noteVisibilityLabel(event.noteVisibility)}</small> : null}</div> : null}
        </div>)}</div>}
    </SectionCard>
  </div></ProtectedPage>;
}
