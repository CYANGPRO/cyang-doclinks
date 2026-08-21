import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { can, type Role } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { encryptEnvelope } from "./encryption.ts";
import {
  listEmployeeActionDefinitions,
  recordEmployeeActionPosture,
  recordEmployeeActionResponse,
  type EmployeeActionDefinition,
} from "./employee-actions.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const CONTACT_METHODS = ["in_person", "phone", "text", "email", "video_call", "other"] as const;
export const ENGAGEMENT_OUTCOMES = [
  "contacted",
  "no_answer",
  "left_message",
  "declined_conversation",
  "wrong_contact",
  "not_available",
] as const;
export const NOTE_VISIBILITIES = ["writer_only", "assigned_scope", "cat_members", "cat_leads", "administrators"] as const;

export type ContactMethod = (typeof CONTACT_METHODS)[number];
export type EngagementOutcome = (typeof ENGAGEMENT_OUTCOMES)[number];
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

export type EngagementAssignmentOption = {
  handle: string;
  label: string;
  relationship: "primary" | "backup" | "authorized";
};

export type EngagementAssigneeOption = {
  handle: string;
  label: string;
  current: boolean;
};

export type EngagementFormOptions = {
  assignments: EngagementAssignmentOption[];
  assignees: EngagementAssigneeOption[];
  actionDefinitions: EmployeeActionDefinition[];
};

export type EngagementWriteDependencies = {
  query?: DatabaseQuery;
  runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
  encrypt?: typeof encryptEnvelope;
  now?: () => Date;
};

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "cat_admin"]);
const MAX_NOTE_CHARS = 2000;
const MAX_BACKDATE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
const MAX_FOLLOWUP_MS = 366 * 24 * 60 * 60 * 1000;

export class EngagementWriteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "EngagementWriteError";
    this.code = code;
    this.status = status;
  }
}

function opaqueHandle(kind: string, organizationId: string, id: string) {
  return createHash("sha256").update(`${kind}:${organizationId}:${id}`).digest("hex");
}

function requireHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new EngagementWriteError("INVALID_HANDLE", `${label} is not available.`, 400);
  }
  return value.toLowerCase();
}

function normalizeEnum<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value === "string" && values.includes(value)) return value as T[number];
  throw new EngagementWriteError("INVALID_INPUT", `${label} is invalid.`, 400);
}

function normalizeOccurredAt(value: unknown, now: Date) {
  if (value == null || value === "") return now.toISOString();
  if (typeof value !== "string") throw new EngagementWriteError("INVALID_INPUT", "Engagement time is invalid.", 400);
  const parsed = new Date(value);
  const timestamp = parsed.getTime();
  if (Number.isNaN(timestamp)) throw new EngagementWriteError("INVALID_INPUT", "Engagement time is invalid.", 400);
  if (timestamp > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new EngagementWriteError("INVALID_INPUT", "Engagement time cannot be in the future.", 400);
  }
  if (timestamp < now.getTime() - MAX_BACKDATE_MS) {
    throw new EngagementWriteError("INVALID_INPUT", "Engagement time is too far in the past for direct entry.", 400);
  }
  return parsed.toISOString();
}

function normalizeNote(input: unknown): { text: string; visibility: NoteVisibility } | null {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new EngagementWriteError("INVALID_INPUT", "Narrative note is invalid.", 400);
  const note = input as { text?: unknown; visibility?: unknown };
  if (typeof note.text !== "string") throw new EngagementWriteError("INVALID_INPUT", "Narrative note is invalid.", 400);
  const text = note.text.trim();
  if (!text) return null;
  if (text.length > MAX_NOTE_CHARS || /\u0000/.test(text)) {
    throw new EngagementWriteError("INVALID_INPUT", `Narrative note must be ${MAX_NOTE_CHARS} characters or fewer.`, 400);
  }
  const visibility = note.visibility == null || note.visibility === ""
    ? "assigned_scope"
    : normalizeEnum(note.visibility, NOTE_VISIBILITIES, "Narrative note visibility");
  return { text, visibility };
}

function normalizeFollowup(input: unknown, occurredAt: string, now: Date) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new EngagementWriteError("INVALID_INPUT", "Follow-up is invalid.", 400);
  const followup = input as { dueAt?: unknown; assigneeHandle?: unknown };
  if (typeof followup.dueAt !== "string" || !followup.dueAt.trim()) {
    throw new EngagementWriteError("INVALID_INPUT", "Follow-up due time is required.", 400);
  }
  const due = new Date(followup.dueAt);
  if (Number.isNaN(due.getTime())) throw new EngagementWriteError("INVALID_INPUT", "Follow-up due time is invalid.", 400);
  if (due.getTime() <= new Date(occurredAt).getTime()) {
    throw new EngagementWriteError("INVALID_INPUT", "Follow-up must be due after the engagement.", 400);
  }
  if (due.getTime() > now.getTime() + MAX_FOLLOWUP_MS) {
    throw new EngagementWriteError("INVALID_INPUT", "Follow-up due time is too far in the future.", 400);
  }
  return {
    dueAt: due.toISOString(),
    assigneeHandle: followup.assigneeHandle == null || followup.assigneeHandle === ""
      ? null
      : requireHandle(followup.assigneeHandle, "Follow-up assignee"),
  };
}

async function resolvePersonId(context: WorkspaceContext, personHandleInput: unknown, query: DatabaseQuery) {
  if (!can(context.role, "recordEngagement")) throw new EngagementWriteError("FORBIDDEN", "Engagement access is not authorized.", 403);
  const handle = requireHandle(personHandleInput, "Employee");
  const [row] = await query<{ id: string }>(`
    /* engagement-recording:resolve-person */
    SELECT person.id
    FROM local801.people person
    WHERE person.organization_id = $1::uuid
      AND person.archived_at IS NULL
      AND encode(digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
      AND (
        $4::text IN ('system_owner','local_admin','cat_admin')
        OR EXISTS (
          SELECT 1
          FROM local801.engagement_assignments assignment
          WHERE assignment.organization_id = $1::uuid
            AND assignment.person_id = person.id
            AND assignment.archived_at IS NULL
            AND assignment.status = 'open'
            AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
        )
      )
    LIMIT 1
  `, [context.organizationId, context.userId, handle, context.role]);
  if (!row?.id) throw new EngagementWriteError("NOT_FOUND", "Employee is not available in your current outreach scope.", 404);
  return row.id;
}

async function resolveAssignment(
  context: WorkspaceContext,
  personId: string,
  assignmentHandleInput: unknown,
  query: DatabaseQuery,
): Promise<{ id: string; campaignId: string | null } | null> {
  if (assignmentHandleInput == null || assignmentHandleInput === "") {
    if (organizationWideRoles.has(context.role)) return null;
    throw new EngagementWriteError("ASSIGNMENT_REQUIRED", "Select a current outreach assignment for this engagement.", 400);
  }
  const handle = requireHandle(assignmentHandleInput, "Outreach assignment");
  const [row] = await query<{ id: string; campaign_id: string | null }>(`
    /* engagement-recording:resolve-assignment */
    SELECT assignment.id, assignment.campaign_id
    FROM local801.engagement_assignments assignment
    WHERE assignment.organization_id = $1::uuid
      AND assignment.person_id = $2::uuid
      AND assignment.archived_at IS NULL
      AND assignment.status = 'open'
      AND encode(digest('assignment:' || $1::text || ':' || assignment.id::text, 'sha256'), 'hex') = $4::text
      AND (
        $5::text IN ('system_owner','local_admin','cat_admin')
        OR assignment.primary_user_id = $3::uuid
        OR assignment.backup_user_id = $3::uuid
      )
    LIMIT 1
  `, [context.organizationId, personId, context.userId, handle, context.role]);
  if (!row) throw new EngagementWriteError("INVALID_ASSIGNMENT", "Outreach assignment is no longer available.", 409);
  return { id: row.id, campaignId: row.campaign_id };
}

async function resolveAssigneeId(
  context: WorkspaceContext,
  assigneeHandle: string | null,
  query: DatabaseQuery,
) {
  if (!assigneeHandle) return context.userId;
  const [row] = await query<{ id: string }>(`
    /* engagement-recording:resolve-assignee */
    SELECT DISTINCT app_user.id
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
     AND role.organization_id = $1::uuid
    WHERE app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
      AND encode(digest('user:' || $1::text || ':' || app_user.id::text, 'sha256'), 'hex') = $3::text
      AND ($4::text <> 'cat_member' OR app_user.id = $2::uuid)
    LIMIT 1
  `, [context.organizationId, context.userId, assigneeHandle, context.role]);
  if (!row?.id) throw new EngagementWriteError("INVALID_ASSIGNEE", "Follow-up assignee is not available.", 400);
  return row.id;
}

async function resolveEngagementEventId(
  context: WorkspaceContext,
  personId: string,
  engagementHandleInput: unknown,
  query: DatabaseQuery,
) {
  if (engagementHandleInput == null || engagementHandleInput === "") return null;
  const handle = requireHandle(engagementHandleInput, "Engagement");
  const [row] = await query<{ id: string }>(`
    /* engagement-recording:resolve-event-handle */
    SELECT event.id
    FROM local801.engagement_events event
    WHERE event.organization_id = $1::uuid
      AND event.person_id = $2::uuid
      AND event.voided_at IS NULL
      AND encode(digest('engagement:' || $1::text || ':' || event.id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, personId, handle]);
  if (!row?.id) throw new EngagementWriteError("INVALID_ENGAGEMENT", "Engagement context is no longer available.", 409);
  return row.id;
}

export async function getEngagementFormOptions(
  context: WorkspaceContext,
  personHandle: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<EngagementFormOptions> {
  const personId = await resolvePersonId(context, personHandle, query);
  const [assignmentRows, assigneeRows, actionDefinitions] = await Promise.all([
    query<{ id: string; campaign_name: string | null; is_primary: boolean; is_backup: boolean }>(`
      /* engagement-recording:assignment-options */
      SELECT
        assignment.id,
        campaign.name AS campaign_name,
        (assignment.primary_user_id = $3::uuid) AS is_primary,
        (assignment.backup_user_id = $3::uuid) AS is_backup
      FROM local801.engagement_assignments assignment
      LEFT JOIN local801.outreach_campaigns campaign
        ON campaign.id = assignment.campaign_id
       AND campaign.organization_id = $1::uuid
       AND campaign.status <> 'archived'
      WHERE assignment.organization_id = $1::uuid
        AND assignment.person_id = $2::uuid
        AND assignment.archived_at IS NULL
        AND assignment.status = 'open'
        AND (
          $4::text IN ('system_owner','local_admin','cat_admin')
          OR assignment.primary_user_id = $3::uuid
          OR assignment.backup_user_id = $3::uuid
        )
      ORDER BY assignment.due_at NULLS LAST, assignment.created_at ASC, assignment.id ASC
      LIMIT 25
    `, [context.organizationId, personId, context.userId, context.role]),
    query<{ id: string; display_name: string }>(`
      /* engagement-recording:assignee-options */
      SELECT DISTINCT app_user.id, app_user.display_name
      FROM local801.users app_user
      JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
      JOIN local801.workspace_roles role
        ON role.id = user_role.role_id
       AND role.organization_id = $1::uuid
      WHERE app_user.organization_id = $1::uuid
        AND app_user.deactivated_at IS NULL
        AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
        AND ($3::text <> 'cat_member' OR app_user.id = $2::uuid)
      ORDER BY app_user.display_name ASC, app_user.id ASC
      LIMIT 100
    `, [context.organizationId, context.userId, context.role]),
    listEmployeeActionDefinitions(context, query),
  ]);

  return {
    assignments: assignmentRows.map((row) => ({
      handle: opaqueHandle("assignment", context.organizationId, row.id),
      label: row.campaign_name || "General outreach assignment",
      relationship: row.is_primary ? "primary" : row.is_backup ? "backup" : "authorized",
    })),
    assignees: assigneeRows.map((row) => ({
      handle: opaqueHandle("user", context.organizationId, row.id),
      label: row.display_name,
      current: row.id === context.userId,
    })),
    actionDefinitions,
  };
}

export async function recordEngagement(
  context: WorkspaceContext,
  input: {
    personHandle: unknown;
    assignmentHandle?: unknown;
    contactMethod: unknown;
    outcome: unknown;
    occurredAt?: unknown;
    note?: unknown;
    followup?: unknown;
  },
  dependencies: EngagementWriteDependencies = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const encrypt = dependencies.encrypt ?? encryptEnvelope;
  const now = (dependencies.now ?? (() => new Date()))();

  const personId = await resolvePersonId(context, input.personHandle, query);
  const assignment = await resolveAssignment(context, personId, input.assignmentHandle, query);
  const contactMethod = normalizeEnum(input.contactMethod, CONTACT_METHODS, "Contact method");
  const outcome = normalizeEnum(input.outcome, ENGAGEMENT_OUTCOMES, "Engagement outcome");
  const occurredAt = normalizeOccurredAt(input.occurredAt, now);
  const note = normalizeNote(input.note);
  const followup = normalizeFollowup(input.followup, occurredAt, now);
  const assigneeId = followup ? await resolveAssigneeId(context, followup.assigneeHandle, query) : null;
  const eventId = randomUUID();
  const followupId = followup ? randomUUID() : null;
  const noteId = note ? randomUUID() : null;

  let encryptedNote: ReturnType<typeof encryptEnvelope> | null = null;
  let noteHash: string | null = null;
  if (note) {
    encryptedNote = encrypt(Buffer.from(note.text, "utf8"));
    noteHash = createHash("sha256").update(encryptedNote.payload).digest("hex");
  }

  const statements: DatabaseStatement[] = [{
    sql: `
      /* engagement-recording:insert-event */
      WITH inserted AS (
        INSERT INTO local801.engagement_events
          (id, organization_id, assignment_id, campaign_id, person_id, recorded_by,
           contact_method, outcome, note_visibility, note_hash, occurred_at)
        SELECT
          $2::uuid, $1::uuid, assignment.id, assignment.campaign_id, person.id, actor.id,
          $6::text, $7::text, $8::text, $9::text, $10::timestamptz
        FROM local801.people person
        JOIN local801.users actor
          ON actor.id = $4::uuid
         AND actor.organization_id = $1::uuid
         AND actor.deactivated_at IS NULL
        LEFT JOIN local801.engagement_assignments assignment
          ON assignment.id = $3::uuid
         AND assignment.organization_id = $1::uuid
         AND assignment.person_id = person.id
         AND assignment.archived_at IS NULL
         AND assignment.status = 'open'
        WHERE person.id = $5::uuid
          AND person.organization_id = $1::uuid
          AND person.archived_at IS NULL
          AND (
            $11::text IN ('system_owner','local_admin','cat_admin')
            OR (
              assignment.id IS NOT NULL
              AND (assignment.primary_user_id = actor.id OR assignment.backup_user_id = actor.id)
            )
          )
          AND ($3::uuid IS NULL OR assignment.id IS NOT NULL)
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS event_created
      FROM inserted
    `,
    parameters: [
      context.organizationId,
      eventId,
      assignment?.id ?? null,
      context.userId,
      personId,
      contactMethod,
      outcome,
      note?.visibility ?? "assigned_scope",
      noteHash,
      occurredAt,
      context.role,
    ],
  }];

  if (note && encryptedNote && noteId) {
    statements.push({
      sql: `
        /* engagement-recording:insert-encrypted-note */
        WITH inserted AS (
          INSERT INTO local801.engagement_notes
            (id, organization_id, engagement_event_id, encrypted_payload,
             encryption_key_version, encryption_format_version, visibility, created_by)
          SELECT $2::uuid, $1::uuid, event.id, $4::text, $5::text, $6::integer, $7::text, actor.id
          FROM local801.engagement_events event
          JOIN local801.users actor
            ON actor.id = $8::uuid
           AND actor.organization_id = $1::uuid
           AND actor.deactivated_at IS NULL
          WHERE event.id = $3::uuid
            AND event.organization_id = $1::uuid
            AND event.recorded_by = actor.id
          RETURNING id
        )
        SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS note_created
        FROM inserted
      `,
      parameters: [
        context.organizationId,
        noteId,
        eventId,
        encryptedNote.payload.toString("utf8"),
        encryptedNote.keyVersion,
        encryptedNote.formatVersion,
        note.visibility,
        context.userId,
      ],
    });
  }

  if (followup && followupId && assigneeId) {
    statements.push({
      sql: `
        /* engagement-recording:insert-followup */
        WITH inserted AS (
          INSERT INTO local801.engagement_followups
            (id, organization_id, engagement_event_id, person_id, assigned_to, due_at, status)
          SELECT $2::uuid, $1::uuid, event.id, event.person_id, assignee.id, $5::timestamptz, 'open'
          FROM local801.engagement_events event
          JOIN local801.users assignee
            ON assignee.id = $4::uuid
           AND assignee.organization_id = $1::uuid
           AND assignee.deactivated_at IS NULL
          WHERE event.id = $3::uuid
            AND event.organization_id = $1::uuid
            AND event.recorded_by = $6::uuid
            AND EXISTS (
              SELECT 1
              FROM local801.workspace_user_roles assignee_role
              JOIN local801.workspace_roles role
                ON role.id = assignee_role.role_id
               AND role.organization_id = $1::uuid
              WHERE assignee_role.user_id = assignee.id
                AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
            )
            AND ($7::text <> 'cat_member' OR assignee.id = $6::uuid)
          RETURNING id
        )
        SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS followup_created
        FROM inserted
      `,
      parameters: [context.organizationId, followupId, eventId, assigneeId, followup.dueAt, context.userId, context.role],
    });
  }

  statements.push(await prepareAudit({
    eventType: "record.create",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "engagement_event",
    subjectId: eventId,
    payload: {
      contactMethod,
      outcome,
      hasNarrative: Boolean(note),
      narrativeVisibility: note?.visibility ?? null,
      followupCreated: Boolean(followup),
    },
  }, query));

  await runTransaction(statements);
  return {
    recorded: true,
    engagementHandle: opaqueHandle("engagement", context.organizationId, eventId),
    followupCreated: Boolean(followup),
  };
}

function normalizeEmployeeActionError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const message = error.message;
  if (message === "Action handle is invalid." || message === "Employee action response is invalid.") {
    throw new EngagementWriteError("INVALID_ACTION_READINESS", message, 400);
  }
  if (message === "Employee action target is not available." || message === "Engagement event is not available.") {
    throw new EngagementWriteError("ACTION_CONTEXT_UNAVAILABLE", message, 409);
  }
  if (message === "Employee action willingness access is not authorized.") {
    throw new EngagementWriteError("FORBIDDEN", "Action Readiness access is not authorized.", 403);
  }
  if (message === "The employee currently declines all actions.") {
    throw new EngagementWriteError("DECLINES_ALL", message, 409);
  }
  if (message === "Open-to-actions posture is established by recording a willing, considering, or completed action.") {
    throw new EngagementWriteError("INVALID_ACTION_READINESS", message, 400);
  }
  throw error;
}

export async function recordOutreachActionResponse(
  context: WorkspaceContext,
  input: { personHandle: unknown; actionHandle: unknown; response: unknown; engagementHandle?: unknown },
  dependencies: EngagementWriteDependencies = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const personId = await resolvePersonId(context, input.personHandle, query);
  const engagementEventId = await resolveEngagementEventId(context, personId, input.engagementHandle, query);
  try {
    return await recordEmployeeActionResponse(context, {
      personId,
      actionHandle: input.actionHandle,
      response: input.response,
      engagementEventId,
    }, {
      query,
      runTransaction: dependencies.runTransaction,
      prepareAudit: dependencies.prepareAudit,
    });
  } catch (error) {
    return normalizeEmployeeActionError(error);
  }
}

export async function recordOutreachActionPosture(
  context: WorkspaceContext,
  input: { personHandle: unknown; posture: unknown; engagementHandle?: unknown },
  dependencies: EngagementWriteDependencies = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const personId = await resolvePersonId(context, input.personHandle, query);
  const engagementEventId = await resolveEngagementEventId(context, personId, input.engagementHandle, query);
  try {
    return await recordEmployeeActionPosture(context, {
      personId,
      posture: input.posture,
      engagementEventId,
    }, {
      query,
      runTransaction: dependencies.runTransaction,
      prepareAudit: dependencies.prepareAudit,
    });
  } catch (error) {
    return normalizeEmployeeActionError(error);
  }
}

export async function completeOutreachFollowup(
  context: WorkspaceContext,
  input: { personHandle: unknown; followupHandle: unknown },
  dependencies: EngagementWriteDependencies = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const runTransaction = dependencies.runTransaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;
  const personId = await resolvePersonId(context, input.personHandle, query);
  const followupHandle = requireHandle(input.followupHandle, "Follow-up");
  const [followup] = await query<{ id: string }>(`
    /* engagement-recording:resolve-followup */
    SELECT item.id
    FROM local801.engagement_followups item
    WHERE item.organization_id = $1::uuid
      AND item.person_id = $2::uuid
      AND item.status = 'open'
      AND item.completed_at IS NULL
      AND encode(digest('followup:' || $1::text || ':' || item.id::text, 'sha256'), 'hex') = $3::text
    LIMIT 1
  `, [context.organizationId, personId, followupHandle]);
  if (!followup?.id) throw new EngagementWriteError("FOLLOWUP_NOT_FOUND", "Follow-up is no longer open.", 409);

  const updateStatement: DatabaseStatement = {
    sql: `
      /* engagement-recording:complete-followup */
      WITH updated AS (
        UPDATE local801.engagement_followups item
        SET status = 'completed', completed_at = now()
        FROM local801.users actor
        WHERE item.id = $2::uuid
          AND item.organization_id = $1::uuid
          AND item.person_id = $3::uuid
          AND item.status = 'open'
          AND item.completed_at IS NULL
          AND actor.id = $4::uuid
          AND actor.organization_id = $1::uuid
          AND actor.deactivated_at IS NULL
          AND (
            $5::text IN ('system_owner','local_admin','cat_admin')
            OR EXISTS (
              SELECT 1
              FROM local801.engagement_assignments assignment
              WHERE assignment.organization_id = $1::uuid
                AND assignment.person_id = item.person_id
                AND assignment.archived_at IS NULL
                AND assignment.status = 'open'
                AND (assignment.primary_user_id = actor.id OR assignment.backup_user_id = actor.id)
            )
          )
        RETURNING item.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS followup_completed
      FROM updated
    `,
    parameters: [context.organizationId, followup.id, personId, context.userId, context.role],
  };
  const audit = await prepareAudit({
    eventType: "record.update",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "engagement_followup",
    subjectId: followup.id,
    payload: { status: "completed" },
  }, query);
  await runTransaction([updateStatement, audit]);
  return { completed: true };
}

export const __testing = {
  opaqueHandle,
  normalizeOccurredAt,
  normalizeFollowup,
  normalizeNote,
  normalizeEnum,
};
