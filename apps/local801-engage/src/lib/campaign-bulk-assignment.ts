import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { can } from "./access.ts";
import { writeAuditEvent } from "./audit.ts";
import { CampaignMutationError } from "./campaign-management.ts";
import { queryLocal801, withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/;
const MAX_FILTER_LENGTH = 80;
const CONFIRMATION_SECONDS = 10 * 60;
const MEMBERSHIP_STATUSES = new Set(["member", "nonmember", "unknown"]);
const WORKFLOW_STATES = new Set(["all", "not_contacted", "contacted", "not_completed"]);

export type CampaignAssignmentCriteria = {
  membershipStatus: "member" | "nonmember" | "unknown" | null;
  department: string;
  classification: string;
  workLocation: string;
  workflowState: "all" | "not_contacted" | "contacted" | "not_completed";
};

export type CampaignAssignmentPreview = {
  matched: number;
  wouldAssign: number;
  alreadyAssigned: number;
  confirmationToken: string;
  expiresAt: string;
};

type PreviewRow = {
  campaign_id: string;
  assignee_id: string;
  revision: string;
  matched_count: number | string;
  assign_count: number | string;
  assigned_count: number | string;
};

type Confirmation = {
  version: 1;
  organizationId: string;
  actorId: string;
  campaignHandle: string;
  assigneeHandle: string;
  criteriaHash: string;
  revision: string;
  wouldAssign: number;
  expiresAt: number;
};

type TransactionRunner = <T>(callback: (query: DatabaseQuery) => Promise<T>) => Promise<T>;

export type CampaignBulkAssignmentDependencies = {
  query?: DatabaseQuery;
  transaction?: TransactionRunner;
  audit?: typeof writeAuditEvent;
  tokenSecret?: string;
  now?: () => number;
};

function fail(code: string, message: string, status = 400): never {
  throw new CampaignMutationError(code, message, status);
}

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCampaigns")) fail("FORBIDDEN", "Bulk assignment is not authorized.", 403);
}

function handle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) fail("INVALID_HANDLE", `${label} is not available.`);
  return value;
}

function scalar(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_FILTER_LENGTH) : "";
}

function escapeLike(value: string) {
  return value ? `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : null;
}

function count(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function normalizeCampaignAssignmentCriteria(value: unknown): CampaignAssignmentCriteria {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const membershipStatus = scalar(input.membershipStatus);
  const workflowState = scalar(input.workflowState) || "all";
  if (membershipStatus && !MEMBERSHIP_STATUSES.has(membershipStatus)) fail("INVALID_CRITERIA", "Membership status is invalid.");
  if (!WORKFLOW_STATES.has(workflowState)) fail("INVALID_CRITERIA", "Workflow status is invalid.");
  return {
    membershipStatus: membershipStatus ? membershipStatus as CampaignAssignmentCriteria["membershipStatus"] : null,
    department: scalar(input.department),
    classification: scalar(input.classification),
    workLocation: scalar(input.workLocation),
    workflowState: workflowState as CampaignAssignmentCriteria["workflowState"],
  };
}

function criteriaHash(criteria: CampaignAssignmentCriteria) {
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

function secret(dependencies: CampaignBulkAssignmentDependencies) {
  const value = dependencies.tokenSecret ?? process.env.NEXTAUTH_SECRET ?? "";
  if (value.length < 32) fail("CONFIRMATION_UNAVAILABLE", "Assignment confirmation is unavailable.", 503);
  return value;
}

function sign(payload: Confirmation, tokenSecret: string) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", tokenSecret).update(encoded).digest("base64url")}`;
}

function verify(value: unknown, tokenSecret: string): Confirmation {
  if (typeof value !== "string" || value.length > 2_000) fail("INVALID_CONFIRMATION", "Assignment confirmation is invalid.", 409);
  const [encoded, supplied, extra] = value.split(".");
  if (!encoded || !supplied || extra) fail("INVALID_CONFIRMATION", "Assignment confirmation is invalid.", 409);
  const expected = createHmac("sha256", tokenSecret).update(encoded).digest();
  const actual = Buffer.from(supplied, "base64url");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    fail("INVALID_CONFIRMATION", "Assignment confirmation is invalid.", 409);
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Confirmation;
    if (parsed.version !== 1 || !HANDLE_RE.test(parsed.campaignHandle) || !HANDLE_RE.test(parsed.assigneeHandle)
      || !HANDLE_RE.test(parsed.criteriaHash) || !HANDLE_RE.test(parsed.revision)
      || !Number.isSafeInteger(parsed.wouldAssign) || !Number.isSafeInteger(parsed.expiresAt)) throw new Error("invalid");
    return parsed;
  } catch {
    fail("INVALID_CONFIRMATION", "Assignment confirmation is invalid.", 409);
  }
}

function previewSql() {
  return `
    /* campaign-bulk-assignment:preview */
    WITH selected_campaign AS (
      SELECT campaign.id
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid AND campaign.archived_at IS NULL
        AND campaign.status IN ('draft','active')
        AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    ), selected_assignee AS (
      SELECT app_user.id
      FROM local801.users app_user
      WHERE app_user.organization_id = $1::uuid AND app_user.deactivated_at IS NULL
        AND encode(public.digest('user:' || app_user.organization_id::text || ':' || app_user.id::text, 'sha256'), 'hex') = $3::text
        AND EXISTS (
          SELECT 1 FROM local801.workspace_user_roles user_role
          JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid
          WHERE user_role.user_id = app_user.id
            AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
        )
      LIMIT 1
    ), candidates AS (
      SELECT member.person_id, assignment.id AS assignment_id,
        COALESCE(contact.contacted, false) AS contacted,
        COALESCE(assignment.status = 'completed', false) AS completed
      FROM local801.outreach_campaign_population member
      CROSS JOIN selected_campaign campaign
      JOIN local801.people person ON person.organization_id = $1::uuid AND person.id = member.person_id AND person.archived_at IS NULL
      LEFT JOIN LATERAL (
        SELECT active_assignment.id, active_assignment.status
        FROM local801.engagement_assignments active_assignment
        WHERE active_assignment.organization_id = $1::uuid
          AND active_assignment.campaign_id = campaign.id
          AND active_assignment.person_id = member.person_id
          AND active_assignment.archived_at IS NULL
        ORDER BY active_assignment.created_at DESC, active_assignment.id DESC
        LIMIT 1
      ) assignment ON true
      LEFT JOIN LATERAL (
        SELECT true AS contacted
        FROM local801.engagement_events event
        WHERE event.organization_id = $1::uuid AND event.campaign_id = campaign.id
          AND event.person_id = member.person_id AND event.voided_at IS NULL
        LIMIT 1
      ) contact ON true
      WHERE member.organization_id = $1::uuid AND member.campaign_id = campaign.id
        AND ($4::text IS NULL OR person.membership_status = $4::text)
        AND ($5::text IS NULL OR person.department ILIKE $5::text ESCAPE '\\')
        AND ($6::text IS NULL OR lower(btrim(person.classification)) = lower(btrim($6::text)))
        AND ($7::text IS NULL OR person.work_location ILIKE $7::text ESCAPE '\\')
    ), filtered AS (
      SELECT * FROM candidates
      WHERE $8::text = 'all'
        OR ($8::text = 'not_contacted' AND NOT contacted)
        OR ($8::text = 'contacted' AND contacted)
        OR ($8::text = 'not_completed' AND NOT completed)
    )
    SELECT campaign.id::text AS campaign_id, assignee.id::text AS assignee_id,
      encode(public.digest(
        count(filtered.person_id)::text || ':' || count(filtered.assignment_id)::text || ':'
        || COALESCE(sum(hashtextextended(filtered.person_id::text || ':'
          || COALESCE(filtered.assignment_id::text, '-') || ':' || filtered.contacted::text
          || ':' || filtered.completed::text, 0)::numeric), 0)::text
        || ':' || assignee.id::text,
        'sha256'), 'hex') AS revision,
      count(filtered.person_id)::int AS matched_count,
      count(*) FILTER (WHERE filtered.person_id IS NOT NULL AND filtered.assignment_id IS NULL)::int AS assign_count,
      count(filtered.assignment_id)::int AS assigned_count
    FROM selected_campaign campaign CROSS JOIN selected_assignee assignee
    LEFT JOIN filtered ON true
    GROUP BY campaign.id, assignee.id
  `;
}

function parameters(context: WorkspaceContext, campaignHandle: string, assigneeHandle: string, criteria: CampaignAssignmentCriteria) {
  return [context.organizationId, campaignHandle, assigneeHandle, criteria.membershipStatus,
    escapeLike(criteria.department), criteria.classification || null, escapeLike(criteria.workLocation), criteria.workflowState];
}

async function livePreview(
  context: WorkspaceContext,
  campaignHandle: string,
  assigneeHandle: string,
  criteria: CampaignAssignmentCriteria,
  query: DatabaseQuery,
) {
  const [row] = await query<PreviewRow>(previewSql(), parameters(context, campaignHandle, assigneeHandle, criteria));
  if (!row?.campaign_id || !row.assignee_id || !HANDLE_RE.test(row.revision)) {
    fail("ASSIGNMENT_TARGET_NOT_AVAILABLE", "The campaign or organizer is no longer available.", 409);
  }
  return {
    campaignId: row.campaign_id,
    assigneeId: row.assignee_id,
    revision: row.revision,
    matched: count(row.matched_count),
    wouldAssign: count(row.assign_count),
    alreadyAssigned: count(row.assigned_count),
  };
}

export async function previewCampaignBulkAssignment(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  input: { assigneeHandle?: unknown; criteria?: unknown },
  dependencies: CampaignBulkAssignmentDependencies = {},
): Promise<CampaignAssignmentPreview> {
  requireAccess(context);
  const campaignHandle = handle(campaignHandleInput, "Campaign");
  const assigneeHandle = handle(input.assigneeHandle, "Organizer");
  const criteria = normalizeCampaignAssignmentCriteria(input.criteria);
  const live = await livePreview(context, campaignHandle, assigneeHandle, criteria, dependencies.query ?? queryLocal801);
  const now = (dependencies.now ?? Date.now)();
  const expiresAt = now + CONFIRMATION_SECONDS * 1_000;
  return {
    matched: live.matched,
    wouldAssign: live.wouldAssign,
    alreadyAssigned: live.alreadyAssigned,
    confirmationToken: sign({ version: 1, organizationId: context.organizationId, actorId: context.userId,
      campaignHandle, assigneeHandle, criteriaHash: criteriaHash(criteria), revision: live.revision,
      wouldAssign: live.wouldAssign, expiresAt }, secret(dependencies)),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function applyCampaignBulkAssignment(
  context: WorkspaceContext,
  campaignHandleInput: unknown,
  input: { assigneeHandle?: unknown; criteria?: unknown; confirmationToken?: unknown; dueAt?: unknown },
  dependencies: CampaignBulkAssignmentDependencies = {},
) {
  requireAccess(context);
  const campaignHandle = handle(campaignHandleInput, "Campaign");
  const assigneeHandle = handle(input.assigneeHandle, "Organizer");
  const criteria = normalizeCampaignAssignmentCriteria(input.criteria);
  const token = verify(input.confirmationToken, secret(dependencies));
  const now = (dependencies.now ?? Date.now)();
  if (token.expiresAt < now) fail("CONFIRMATION_EXPIRED", "The assignment preview expired. Preview it again.", 409);
  if (token.organizationId !== context.organizationId || token.actorId !== context.userId
    || token.campaignHandle !== campaignHandle || token.assigneeHandle !== assigneeHandle
    || token.criteriaHash !== criteriaHash(criteria)) {
    fail("CONFIRMATION_MISMATCH", "The assignment settings changed. Preview them again.", 409);
  }
  if (input.dueAt !== undefined && input.dueAt !== null && input.dueAt !== "") {
    fail("DUE_AT_NOT_SUPPORTED", "Bulk assignment does not change due dates. Set due dates on individual assignments.");
  }
  const dueAt = null;
  const transaction = dependencies.transaction ?? withLocal801Transaction;
  const audit = dependencies.audit ?? writeAuditEvent;
  return transaction(async (query) => {
    const [locked] = await query<{ campaign_id: string; assignee_id: string }>(`
      /* campaign-bulk-assignment:lock-campaign */
      SELECT campaign.id::text AS campaign_id, assignee.id::text AS assignee_id
      FROM local801.outreach_campaigns campaign
      JOIN local801.users assignee
        ON assignee.organization_id = $1::uuid AND assignee.deactivated_at IS NULL
       AND encode(public.digest('user:' || assignee.organization_id::text || ':' || assignee.id::text, 'sha256'), 'hex') = $5::text
       AND EXISTS (
         SELECT 1 FROM local801.workspace_user_roles assignee_user_role
         JOIN local801.workspace_roles assignee_role
           ON assignee_role.id = assignee_user_role.role_id AND assignee_role.organization_id = $1::uuid
         WHERE assignee_user_role.user_id = assignee.id
           AND assignee_role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
       )
      WHERE campaign.organization_id = $1::uuid AND campaign.archived_at IS NULL
        AND campaign.status IN ('draft','active')
        AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
        AND EXISTS (
          SELECT 1 FROM local801.users actor
          JOIN local801.workspace_user_roles user_role ON user_role.user_id = actor.id
          JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid
          WHERE actor.id = $3::uuid AND actor.organization_id = $1::uuid AND actor.deactivated_at IS NULL
            AND role.code = $4::text AND role.code IN ('system_owner','local_admin','cat_admin')
        )
      FOR UPDATE OF campaign, assignee
    `, [context.organizationId, campaignHandle, context.userId, context.role, assigneeHandle]);
    if (!locked?.campaign_id || !locked.assignee_id) fail("CAMPAIGN_NOT_AVAILABLE", "The campaign or organizer is no longer available.", 409);
    const live = await livePreview(context, campaignHandle, assigneeHandle, criteria, query);
    if (live.revision !== token.revision || live.wouldAssign !== token.wouldAssign) {
      fail("STALE_CONFIRMATION", "Campaign assignments changed. Preview them again.", 409);
    }
    const [changed] = await query<{ changed_count: number | string }>(`
      /* campaign-bulk-assignment:apply */
      WITH selected_campaign AS (
        SELECT id FROM local801.outreach_campaigns
        WHERE organization_id = $1::uuid AND archived_at IS NULL AND status IN ('draft','active')
          AND encode(public.digest('campaign:' || organization_id::text || ':' || id::text, 'sha256'), 'hex') = $2::text
      ), selected_assignee AS (
        SELECT app_user.id FROM local801.users app_user WHERE app_user.organization_id = $1::uuid
          AND app_user.deactivated_at IS NULL
          AND encode(public.digest('user:' || app_user.organization_id::text || ':' || app_user.id::text, 'sha256'), 'hex') = $3::text
          AND EXISTS (
            SELECT 1 FROM local801.workspace_user_roles user_role
            JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid
            WHERE user_role.user_id = app_user.id
              AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
          )
      ), candidates AS (
        SELECT member.person_id,
          COALESCE(contact.contacted, false) AS contacted,
          COALESCE(assignment.status = 'completed', false) AS completed
        FROM local801.outreach_campaign_population member CROSS JOIN selected_campaign campaign
        JOIN local801.people person ON person.organization_id = $1::uuid AND person.id = member.person_id AND person.archived_at IS NULL
        LEFT JOIN LATERAL (
          SELECT active_assignment.id, active_assignment.status
          FROM local801.engagement_assignments active_assignment
          WHERE active_assignment.organization_id = $1::uuid
            AND active_assignment.campaign_id = campaign.id
            AND active_assignment.person_id = member.person_id
            AND active_assignment.archived_at IS NULL
          ORDER BY active_assignment.created_at DESC, active_assignment.id DESC
          LIMIT 1
        ) assignment ON true
        LEFT JOIN LATERAL (
          SELECT true AS contacted
          FROM local801.engagement_events event
          WHERE event.organization_id = $1::uuid AND event.campaign_id = campaign.id
            AND event.person_id = member.person_id AND event.voided_at IS NULL
          LIMIT 1
        ) contact ON true
        WHERE member.organization_id = $1::uuid AND member.campaign_id = campaign.id AND assignment.id IS NULL
          AND ($4::text IS NULL OR person.membership_status = $4::text)
          AND ($5::text IS NULL OR person.department ILIKE $5::text ESCAPE '\\')
          AND ($6::text IS NULL OR lower(btrim(person.classification)) = lower(btrim($6::text)))
          AND ($7::text IS NULL OR person.work_location ILIKE $7::text ESCAPE '\\')
      ), filtered AS (
        SELECT * FROM candidates WHERE $8::text = 'all'
          OR ($8::text = 'not_contacted' AND NOT contacted)
          OR ($8::text = 'contacted' AND contacted)
          OR ($8::text = 'not_completed' AND NOT completed)
      ), inserted AS (
        INSERT INTO local801.engagement_assignments
          (organization_id, campaign_id, person_id, primary_user_id, assignment_type, status, due_at, created_by)
        SELECT $1::uuid, campaign.id, filtered.person_id, assignee.id, 'direct', 'open', $9::timestamptz, $10::uuid
        FROM filtered CROSS JOIN selected_campaign campaign CROSS JOIN selected_assignee assignee
        RETURNING id
      )
      SELECT count(*)::int AS changed_count FROM inserted
    `, [...parameters(context, campaignHandle, assigneeHandle, criteria), dueAt, context.userId]);
    const changedCount = count(changed?.changed_count);
    if (changedCount !== live.wouldAssign) fail("CONCURRENT_CAMPAIGN_CHANGE", "Assignments changed during the update.", 409);
    await audit({
      eventType: "record.update", actorId: context.userId, organizationId: context.organizationId,
      subjectType: "outreach_campaign", subjectId: live.campaignId,
      payload: { bulkAssignment: true, changedCount, matchedCount: live.matched,
        alreadyAssignedCount: live.alreadyAssigned, explicitAssignee: true, dueAtSet: Boolean(dueAt),
        membershipCriterion: Boolean(criteria.membershipStatus), departmentCriterion: Boolean(criteria.department),
        classificationCriterion: Boolean(criteria.classification), locationCriterion: Boolean(criteria.workLocation),
        workflowCriterion: criteria.workflowState },
    }, query);
    return { assigned: changedCount };
  });
}

export const __testing = { CONFIRMATION_SECONDS, criteriaHash, sign, verify };
