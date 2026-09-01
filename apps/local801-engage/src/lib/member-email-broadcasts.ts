import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import { sendMemberEmailPreviewTest, type SendMemberEmailPreviewTestInput } from "./member-email-resend.ts";
import {
  memberEmailDeliveryBoundary,
  memberEmailRealTestBoundary,
  requireMemberEmailPreview,
  requireSyntheticMemberEmail,
} from "./member-email-preview-policy.ts";
import {
  createPiiBlindIndex,
  createPiiIntegrityHash,
  decryptPiiField,
  encryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiEmail,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/;
const MAX_RECIPIENTS = 1_500;
const MAX_SUBJECT = 160;
const MAX_BODY = 20_000;
const AUDIENCE_HANDLE_RE = /^[0-9a-f]{64}$/;

const STATIC_AUDIENCES = Object.freeze({
  members: { label: "All current members", description: "Everyone marked as a current union member." },
  nonmembers: { label: "Current nonmembers", description: "Everyone marked as a current nonmember." },
  represented_unit: { label: "Entire represented unit", description: "Current members and nonmembers; unknown statuses stay excluded." },
  registered_users: { label: "All registered users", description: "Every active Local 801 account, across all assigned roles." },
  cat_members: { label: "All CAT members", description: "Active CAT administrators, leads, and CAT members." },
} as const);

type StaticAudienceKey = keyof typeof STATIC_AUDIENCES;
type AudienceKind = StaticAudienceKey | "department" | "campaign";

type AudienceSelection = {
  key: string;
  kind: AudienceKind;
  label: string;
  referenceHandle: string | null;
  department: string | null;
  campaignId: string | null;
};

export type MemberEmailAudienceOption = {
  key: string;
  label: string;
  group: "Membership" | "Users" | "CAT" | "Departments" | "Saved lists";
  description: string;
};

type SnapshotRow = { id: string; snapshot_date: string | Date };

type AudienceRow = {
  recipient_kind: "person" | "workspace_user";
  person_id: string | null;
  user_id: string | null;
  home_contact_id: string | null;
  home_contact_value: string | null;
  home_encrypted_payload: string | null;
  home_key_version: string | null;
  home_format_version: number | string | null;
  work_contact_id: string | null;
  work_contact_value: string | null;
  work_encrypted_payload: string | null;
  work_key_version: string | null;
  work_format_version: number | string | null;
  user_email_value: string | null;
  user_email_encrypted_payload: string | null;
  user_email_key_version: string | null;
  user_email_format_version: number | string | null;
};

type PlannedRecipient = {
  id: string;
  personId: string | null;
  userId: string | null;
  contactMethodId: string | null;
  contactKind: "home" | "work" | "cat_user" | null;
  status: "eligible" | "missing" | "duplicate" | "suppressed";
  duplicateOfRecipientId: string | null;
  normalizedEmail: string | null;
  blindIndexKeyVersion: string | null;
  blindIndex: string | null;
};

export type MemberEmailAudienceSummary = {
  audienceKey: string;
  audienceLabel: string;
  snapshotDate: string;
  representedRecipients: number;
  eligible: number;
  missing: number;
  duplicate: number;
  suppressed: number;
  homePreferred: number;
  workFallback: number;
  syntheticOnly: true;
};

type AudiencePlan = MemberEmailAudienceSummary & { snapshotId: string; recipients: PlannedRecipient[] };

type BroadcastRow = {
  id: string;
  handle: string;
  status: string;
  source_snapshot_id: string;
  snapshot_date: string | Date;
  eligible_count: number | string;
  missing_count: number | string;
  duplicate_count: number | string;
  suppressed_count: number | string;
  scheduled_for: string | Date | null;
  created_by: string;
  approved_by: string | null;
  simulated_at: string | Date | null;
  created_at: string | Date;
  subject_encrypted_payload: string;
  subject_encryption_key_version: string;
  subject_encryption_format_version: number | string;
  audience_kind: string;
  audience_label: string;
  audience_reference_handle: string | null;
  represented_count: number | string;
};

type RealTestBroadcastRow = BroadcastRow & {
  body_encrypted_payload: string;
  body_encryption_key_version: string;
  body_encryption_format_version: number | string;
};

export type MemberEmailBroadcastSummary = {
  handle: string;
  subject: string;
  status: "draft" | "review" | "approved" | "simulated" | "cancelled";
  audienceLabel: string;
  representedRecipients: number;
  snapshotDate: string;
  eligible: number;
  missing: number;
  duplicate: number;
  suppressed: number;
  scheduledFor: string | null;
  createdAt: string;
  simulatedAt: string | null;
  requiresDifferentApprover: boolean;
};

type Dependencies = {
  query?: DatabaseQuery;
  transaction?: <T>(callback: (query: DatabaseQuery) => Promise<T>) => Promise<T>;
  env?: NodeJS.ProcessEnv;
  keyConfig?: PiiKeyConfiguration;
  now?: () => Date;
  sendPreviewTest?: (input: SendMemberEmailPreviewTestInput) => Promise<{ providerMessageId: string }>;
};

export class MemberEmailBroadcastError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "MemberEmailBroadcastError";
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new MemberEmailBroadcastError(code, message, status);
}

function requireAccess(context: WorkspaceContext, env: NodeJS.ProcessEnv) {
  requireMemberEmailPreview(env);
  if (!can(context.role, "sendMemberEmail")) fail("FORBIDDEN", "Member email broadcast access is not authorized.", 403);
}

function dateOnly(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("SNAPSHOT_INVALID", "The approved membership snapshot date is invalid.", 503);
  return date.toISOString().slice(0, 10);
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function count(value: number | string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function content(value: unknown, label: string, max: number) {
  if (typeof value !== "string") fail("INVALID_CONTENT", `${label} is required.`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized.length > max) fail("INVALID_CONTENT", `${label} must be between 1 and ${max.toLocaleString()} characters.`);
  return normalized;
}

function schedule(value: unknown, now: Date) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 50) fail("INVALID_SCHEDULE", "The simulated send time is invalid.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime() - 60_000
    || parsed.getTime() > now.getTime() + 366 * 86_400_000) {
    fail("INVALID_SCHEDULE", "Choose a simulated send time from now through the next year.");
  }
  return parsed.toISOString();
}

function audienceKey(value: unknown) {
  if (value === undefined || value === null || value === "") return "members";
  if (typeof value !== "string" || value.length > 100) fail("INVALID_AUDIENCE", "Choose an available recipient audience.");
  if (value in STATIC_AUDIENCES) return value as StaticAudienceKey;
  const [prefix, handle, extra] = value.split(":");
  if (extra !== undefined || (prefix !== "department" && prefix !== "campaign") || !handle || !AUDIENCE_HANDLE_RE.test(handle)) {
    fail("INVALID_AUDIENCE", "Choose an available recipient audience.");
  }
  return `${prefix}:${handle}`;
}

function audienceHandleSql(domain: "department" | "campaign", expression: string) {
  if (domain === "campaign") {
    return `encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex')`;
  }
  return `encode(public.digest('member-email:department:' || $1::text || ':' || lower(btrim(${expression})), 'sha256'), 'hex')`;
}

async function latestApprovedSnapshot(context: WorkspaceContext, query: DatabaseQuery) {
  const snapshots = await query<SnapshotRow>(`
    /* member-email:latest-approved-snapshot */
    SELECT id::text, snapshot_date
    FROM local801.membership_snapshots
    WHERE organization_id = $1::uuid AND status = 'approved'
    ORDER BY snapshot_date DESC, approved_at DESC NULLS LAST, created_at DESC, id DESC
    LIMIT 1
  `, [context.organizationId]);
  if (snapshots.length !== 1) fail("SNAPSHOT_UNAVAILABLE", "Exactly one latest approved membership snapshot could not be established.", 409);
  return snapshots[0];
}

async function resolveAudienceSelection(
  context: WorkspaceContext,
  snapshotId: string,
  value: unknown,
  query: DatabaseQuery,
): Promise<AudienceSelection> {
  const key = audienceKey(value);
  if (key in STATIC_AUDIENCES) {
    const kind = key as StaticAudienceKey;
    return { key, kind, label: STATIC_AUDIENCES[kind].label, referenceHandle: null, department: null, campaignId: null };
  }
  const [kind, referenceHandle] = key.split(":") as ["department" | "campaign", string];
  if (kind === "department") {
    const [row] = await query<{ department: string }>(`
      /* member-email:resolve-department-audience */
      SELECT min(btrim(snapshot_row.department)) AS department
      FROM local801.membership_snapshot_rows snapshot_row
      WHERE snapshot_row.organization_id = $1::uuid AND snapshot_row.snapshot_id = $2::uuid
        AND snapshot_row.membership_status = 'member' AND nullif(btrim(snapshot_row.department), '') IS NOT NULL
        AND ${audienceHandleSql("department", "snapshot_row.department")} = $3::text
      GROUP BY lower(btrim(snapshot_row.department))
      LIMIT 1
    `, [context.organizationId, snapshotId, referenceHandle]);
    if (!row?.department) fail("AUDIENCE_UNAVAILABLE", "That department is no longer available in the approved member snapshot.", 409);
    return { key, kind, label: `Department members · ${row.department}`, referenceHandle, department: row.department, campaignId: null };
  }
  const [row] = await query<{ id: string; name: string }>(`
    /* member-email:resolve-campaign-audience */
    SELECT campaign.id::text, campaign.name
    FROM local801.outreach_campaigns campaign
    WHERE campaign.organization_id = $1::uuid AND campaign.archived_at IS NULL
      AND ${audienceHandleSql("campaign", "campaign.id::text")} = $2::text
      AND EXISTS (
        SELECT 1 FROM local801.outreach_campaign_population population
        WHERE population.organization_id = campaign.organization_id AND population.campaign_id = campaign.id
      )
    LIMIT 1
  `, [context.organizationId, referenceHandle]);
  if (!row?.id || !row.name) fail("AUDIENCE_UNAVAILABLE", "That saved campaign list is no longer available.", 409);
  return { key, kind, label: `Saved list · ${row.name}`, referenceHandle, department: null, campaignId: row.id };
}

export async function listMemberEmailAudienceOptions(context: WorkspaceContext, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  requireAccess(context, env);
  const query = dependencies.query ?? queryLocal801;
  const snapshot = await latestApprovedSnapshot(context, query);
  const [departments, campaigns] = await Promise.all([
    query<{ handle: string; label: string; people_count: number | string }>(`
      /* member-email:department-options */
      SELECT ${audienceHandleSql("department", "snapshot_row.department")} AS handle,
        min(btrim(snapshot_row.department)) AS label, count(*)::integer AS people_count
      FROM local801.membership_snapshot_rows snapshot_row
      WHERE snapshot_row.organization_id = $1::uuid AND snapshot_row.snapshot_id = $2::uuid
        AND snapshot_row.membership_status = 'member' AND nullif(btrim(snapshot_row.department), '') IS NOT NULL
      GROUP BY lower(btrim(snapshot_row.department))
      ORDER BY min(btrim(snapshot_row.department))
      LIMIT 250
    `, [context.organizationId, snapshot.id]),
    query<{ handle: string; label: string; people_count: number | string }>(`
      /* member-email:campaign-options */
      SELECT ${audienceHandleSql("campaign", "campaign.id::text")} AS handle,
        campaign.name AS label, count(population.person_id)::integer AS people_count
      FROM local801.outreach_campaigns campaign
      JOIN local801.outreach_campaign_population population
        ON population.organization_id = campaign.organization_id AND population.campaign_id = campaign.id
      WHERE campaign.organization_id = $1::uuid AND campaign.archived_at IS NULL
      GROUP BY campaign.id, campaign.organization_id, campaign.name, campaign.created_at
      ORDER BY campaign.created_at DESC, campaign.name
      LIMIT 100
    `, [context.organizationId]),
  ]);
  const options: MemberEmailAudienceOption[] = [
    { key: "members", label: STATIC_AUDIENCES.members.label, group: "Membership", description: STATIC_AUDIENCES.members.description },
    { key: "nonmembers", label: STATIC_AUDIENCES.nonmembers.label, group: "Membership", description: STATIC_AUDIENCES.nonmembers.description },
    { key: "represented_unit", label: STATIC_AUDIENCES.represented_unit.label, group: "Membership", description: STATIC_AUDIENCES.represented_unit.description },
    { key: "registered_users", label: STATIC_AUDIENCES.registered_users.label, group: "Users", description: STATIC_AUDIENCES.registered_users.description },
    { key: "cat_members", label: STATIC_AUDIENCES.cat_members.label, group: "CAT", description: STATIC_AUDIENCES.cat_members.description },
    ...departments.filter((row) => AUDIENCE_HANDLE_RE.test(row.handle) && row.label).map((row) => ({
      key: `department:${row.handle}`, label: row.label, group: "Departments" as const,
      description: `${count(row.people_count).toLocaleString()} current ${count(row.people_count) === 1 ? "member" : "members"}`,
    })),
    ...campaigns.filter((row) => AUDIENCE_HANDLE_RE.test(row.handle) && row.label).map((row) => ({
      key: `campaign:${row.handle}`, label: row.label, group: "Saved lists" as const,
      description: `${count(row.people_count).toLocaleString()} saved ${count(row.people_count) === 1 ? "person" : "people"}`,
    })),
  ];
  return options;
}

function protectedValue(
  row: AudienceRow,
  kind: "home" | "work",
  organizationId: string,
  keyConfig: PiiKeyConfiguration,
) {
  const id = row[`${kind}_contact_id`];
  if (!id) return null;
  const encryptedPayload = row[`${kind}_encrypted_payload`];
  const encryptionKeyVersion = row[`${kind}_key_version`];
  const encryptionFormatVersion = Number(row[`${kind}_format_version`]);
  if (!encryptedPayload || !encryptionKeyVersion || encryptionFormatVersion !== 1) {
    fail("PROTECTED_CONTACT_MISSING", "A selected member contact is missing its protected PII companion.", 503);
  }
  return decryptPiiField(
    { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 },
    { organizationId, entity: "person-contact", recordId: id, field: "contact-value" },
    keyConfig,
  );
}

function selectedContact(
  row: AudienceRow,
  mode: ReturnType<typeof getPiiProtectedReadMode>,
  organizationId: string,
  keyConfig: PiiKeyConfiguration,
) {
  if (row.recipient_kind === "workspace_user") {
    if (!row.user_id) fail("WORKSPACE_RECIPIENT_INVALID", "A registered user recipient could not be established safely.", 503);
    const value = mode === "legacy"
      ? row.user_email_value
      : (() => {
          const format = Number(row.user_email_format_version);
          if (!row.user_email_encrypted_payload || !row.user_email_key_version || format !== 1) {
            fail("PROTECTED_CONTACT_MISSING", "A selected registered user is missing protected email data.", 503);
          }
          return decryptPiiField({
            encryptedPayload: row.user_email_encrypted_payload,
            encryptionKeyVersion: row.user_email_key_version,
            encryptionFormatVersion: 1,
          }, { organizationId, entity: "user", recordId: row.user_id, field: "email" }, keyConfig);
        })();
    return { id: null, kind: "cat_user" as const, value };
  }
  const value = (kind: "home" | "work") => mode === "legacy"
    ? row[`${kind}_contact_value`]
    : protectedValue(row, kind, organizationId, keyConfig);
  if (row.home_contact_id) return { id: row.home_contact_id, kind: "home" as const, value: value("home") };
  if (row.work_contact_id) return { id: row.work_contact_id, kind: "work" as const, value: value("work") };
  return null;
}

async function buildAudiencePlan(context: WorkspaceContext, selectionInput: unknown, dependencies: Dependencies = {}): Promise<AudiencePlan> {
  const env = dependencies.env ?? process.env;
  requireAccess(context, env);
  const query = dependencies.query ?? queryLocal801;
  const mode = getPiiProtectedReadMode(env);
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  if (mode !== "legacy") await assertPiiProtectedReadState(context.organizationId, query, mode);

  const snapshot = await latestApprovedSnapshot(context, query);
  const selection = await resolveAudienceSelection(context, snapshot.id, selectionInput, query);

  const workspaceUserAudience = selection.kind === "registered_users" || selection.kind === "cat_members";
  const rows = workspaceUserAudience ? await query<AudienceRow>(`
    /* member-email:synthetic-workspace-user-audience */
    SELECT 'workspace_user'::text AS recipient_kind, NULL::text AS person_id, app_user.id::text AS user_id,
      NULL::text AS home_contact_id, NULL::text AS home_contact_value,
      NULL::text AS home_encrypted_payload, NULL::text AS home_key_version, NULL::integer AS home_format_version,
      NULL::text AS work_contact_id, NULL::text AS work_contact_value,
      NULL::text AS work_encrypted_payload, NULL::text AS work_key_version, NULL::integer AS work_format_version,
      app_user.email AS user_email_value, protected.email_encrypted_payload AS user_email_encrypted_payload,
      protected.email_encryption_key_version AS user_email_key_version,
      protected.email_encryption_format_version AS user_email_format_version
    FROM local801.users app_user
    LEFT JOIN local801.user_pii protected
      ON protected.organization_id = app_user.organization_id AND protected.user_id = app_user.id
    WHERE app_user.organization_id = $1::uuid AND app_user.deactivated_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM local801.workspace_user_roles user_role
        JOIN local801.workspace_roles role
          ON role.id = user_role.role_id AND role.organization_id = $1::uuid
        WHERE user_role.user_id = app_user.id
          AND ($2::text = 'registered_users' OR role.code IN ('cat_admin','cat_lead','cat_member'))
      )
    ORDER BY app_user.id
    LIMIT ${MAX_RECIPIENTS + 1}
  `, [context.organizationId, selection.kind]) : await query<AudienceRow>(`
    /* member-email:synthetic-audience */
    SELECT 'person'::text AS recipient_kind, snapshot_row.person_id::text, NULL::text AS user_id,
      home.id::text AS home_contact_id, home.contact_value AS home_contact_value,
      home_pii.contact_value_encrypted_payload AS home_encrypted_payload,
      home_pii.encryption_key_version AS home_key_version,
      home_pii.encryption_format_version AS home_format_version,
      work.id::text AS work_contact_id, work.contact_value AS work_contact_value,
      work_pii.contact_value_encrypted_payload AS work_encrypted_payload,
      work_pii.encryption_key_version AS work_key_version,
      work_pii.encryption_format_version AS work_format_version,
      NULL::text AS user_email_value, NULL::text AS user_email_encrypted_payload,
      NULL::text AS user_email_key_version, NULL::integer AS user_email_format_version
    FROM local801.membership_snapshot_rows snapshot_row
    JOIN local801.people person
      ON person.organization_id = snapshot_row.organization_id AND person.id = snapshot_row.person_id
      AND person.archived_at IS NULL AND person.local_number = '0801'
    LEFT JOIN LATERAL (
      SELECT contact.id, contact.contact_value
      FROM local801.person_contact_methods contact
      WHERE contact.organization_id = $1::uuid AND contact.person_id = snapshot_row.person_id
        AND contact.contact_type = 'personal_email' AND contact.contact_label = 'home'
        AND contact.is_primary = true AND contact.archived_at IS NULL AND contact.verified_at IS NOT NULL
      ORDER BY contact.created_at DESC, contact.id DESC LIMIT 1
    ) home ON true
    LEFT JOIN local801.person_contact_method_pii home_pii
      ON home_pii.organization_id = $1::uuid AND home_pii.contact_method_id = home.id
    LEFT JOIN LATERAL (
      SELECT contact.id, contact.contact_value
      FROM local801.person_contact_methods contact
      WHERE contact.organization_id = $1::uuid AND contact.person_id = snapshot_row.person_id
        AND contact.contact_type = 'work_email' AND contact.is_primary = true
        AND contact.archived_at IS NULL AND contact.verified_at IS NOT NULL
      ORDER BY contact.created_at DESC, contact.id DESC LIMIT 1
    ) work ON true
    LEFT JOIN local801.person_contact_method_pii work_pii
      ON work_pii.organization_id = $1::uuid AND work_pii.contact_method_id = work.id
    WHERE snapshot_row.organization_id = $1::uuid AND snapshot_row.snapshot_id = $2::uuid
      AND (
        ($3::text = 'members' AND snapshot_row.membership_status = 'member')
        OR ($3::text = 'nonmembers' AND snapshot_row.membership_status = 'nonmember')
        OR ($3::text = 'represented_unit' AND snapshot_row.membership_status IN ('member','nonmember'))
        OR ($3::text = 'department' AND snapshot_row.membership_status = 'member'
          AND lower(btrim(snapshot_row.department)) = lower(btrim($4::text)))
        OR ($3::text = 'campaign' AND snapshot_row.membership_status IN ('member','nonmember') AND EXISTS (
          SELECT 1 FROM local801.outreach_campaign_population population
          WHERE population.organization_id = $1::uuid AND population.campaign_id = $5::uuid
            AND population.person_id = snapshot_row.person_id
        ))
      )
    ORDER BY snapshot_row.person_id
    LIMIT ${MAX_RECIPIENTS + 1}
  `, [context.organizationId, snapshot.id, selection.kind, selection.department, selection.campaignId]);
  if (rows.length > MAX_RECIPIENTS) fail("AUDIENCE_TOO_LARGE", `Preview broadcasts are limited to ${MAX_RECIPIENTS.toLocaleString()} represented recipients.`, 409);

  const preliminary: Array<Omit<PlannedRecipient, "status" | "duplicateOfRecipientId">> = [];
  for (const row of rows) {
    const contact = selectedContact(row, mode, context.organizationId, keyConfig);
    if (!contact?.value) {
      preliminary.push({ id: randomUUID(), personId: row.person_id, userId: row.user_id, contactMethodId: null,
        contactKind: row.recipient_kind === "workspace_user" ? "cat_user" : null,
        normalizedEmail: null, blindIndexKeyVersion: null, blindIndex: null });
      continue;
    }
    let normalized: string;
    try {
      normalized = normalizePiiEmail(contact.value);
    } catch {
      fail("INVALID_ROSTER_EMAIL", "A selected member email is invalid. Correct the roster before previewing a broadcast.", 409);
    }
    requireSyntheticMemberEmail(normalized);
    const index = createPiiBlindIndex(normalized, { organizationId: context.organizationId, domain: "member-email:recipient" }, keyConfig);
    preliminary.push({ id: randomUUID(), personId: row.person_id, userId: row.user_id,
      contactMethodId: contact.id, contactKind: contact.kind,
      normalizedEmail: normalized, blindIndexKeyVersion: index.blindIndexKeyVersion, blindIndex: index.blindIndex });
  }

  const canonical = new Map<string, PlannedRecipient>();
  const recipients: PlannedRecipient[] = preliminary.map((item) => {
    if (!item.normalizedEmail || !item.blindIndex || !item.blindIndexKeyVersion) {
      return { ...item, status: "missing", duplicateOfRecipientId: null };
    }
    const key = `${item.blindIndexKeyVersion}:${item.blindIndex}`;
    const existing = canonical.get(key);
    if (existing) return { ...item, status: "duplicate", duplicateOfRecipientId: existing.id };
    const planned: PlannedRecipient = {
      ...item,
      status: "eligible",
      duplicateOfRecipientId: null,
    };
    canonical.set(key, planned);
    return planned;
  });

  return {
    snapshotId: snapshot.id,
    audienceKey: selection.key,
    audienceLabel: selection.label,
    snapshotDate: dateOnly(snapshot.snapshot_date),
    representedRecipients: recipients.length,
    eligible: recipients.filter((item) => item.status === "eligible").length,
    missing: recipients.filter((item) => item.status === "missing").length,
    duplicate: recipients.filter((item) => item.status === "duplicate").length,
    suppressed: recipients.filter((item) => item.status === "suppressed").length,
    homePreferred: recipients.filter((item) => item.contactKind === "home").length,
    workFallback: recipients.filter((item) => item.contactKind === "work").length,
    syntheticOnly: true,
    recipients,
  };
}

export async function previewMemberEmailAudience(
  context: WorkspaceContext,
  dependencies: Dependencies = {},
  selectionInput: unknown = "members",
) {
  const { snapshotId: _snapshotId, recipients: _recipients, ...summary } = await buildAudiencePlan(context, selectionInput, dependencies);
  return summary;
}

function broadcastHandleSql(alias: string) {
  return `encode(public.digest('member-email-broadcast:' || ${alias}.organization_id::text || ':' || ${alias}.id::text, 'sha256'), 'hex')`;
}

export async function createMemberEmailBroadcast(
  context: WorkspaceContext,
  input: { subject: unknown; body: unknown; audienceKey?: unknown; scheduledFor?: unknown },
  dependencies: Dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  requireAccess(context, env);
  const subject = content(input.subject, "Subject", MAX_SUBJECT);
  const body = content(input.body, "Message", MAX_BODY);
  const now = (dependencies.now ?? (() => new Date()))();
  const scheduledFor = schedule(input.scheduledFor, now);
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const plan = await buildAudiencePlan(context, input.audienceKey, { ...dependencies, keyConfig });
  if (plan.eligible === 0) fail("NO_ELIGIBLE_RECIPIENTS", "The approved snapshot has no eligible synthetic recipients.", 409);

  const id = randomUUID();
  const subjectProtected = encryptPiiField(subject,
    { organizationId: context.organizationId, entity: "member-email-broadcast", recordId: id, field: "subject" }, keyConfig);
  const bodyProtected = encryptPiiField(body,
    { organizationId: context.organizationId, entity: "member-email-broadcast", recordId: id, field: "body" }, keyConfig);
  const subjectIntegrity = createPiiIntegrityHash(subject,
    { organizationId: context.organizationId, domain: "member-email-subject" }, keyConfig);
  const bodyIntegrity = createPiiIntegrityHash(body,
    { organizationId: context.organizationId, domain: "member-email-body" }, keyConfig);
  const protectedRecipients = plan.recipients.map((recipient) => {
    const encrypted = recipient.normalizedEmail ? encryptPiiField(recipient.normalizedEmail,
      { organizationId: context.organizationId, entity: "member-email-recipient", recordId: recipient.id, field: "email" }, keyConfig) : null;
    return {
      id: recipient.id,
      person_id: recipient.personId,
      user_id: recipient.userId,
      contact_method_id: recipient.contactMethodId,
      contact_kind: recipient.contactKind,
      status: recipient.status,
      duplicate_of_recipient_id: recipient.duplicateOfRecipientId,
      blind_index_key_version: recipient.blindIndexKeyVersion,
      blind_index: recipient.blindIndex,
      encrypted_payload: encrypted?.encryptedPayload ?? null,
      encryption_key_version: encrypted?.encryptionKeyVersion ?? null,
      encryption_format_version: encrypted?.encryptionFormatVersion ?? null,
    };
  });
  const transaction = dependencies.transaction ?? withLocal801Transaction;
  const result = await transaction(async (query) => {
    const [created] = await query<{ handle: string }>(`
      /* member-email:create-broadcast */
      INSERT INTO local801.member_email_broadcasts
        (id, organization_id, source_snapshot_id, audience_kind, audience_label, audience_reference_handle,
         represented_count, subject_hash_key_version, subject_hash,
         body_hash_key_version, body_hash, eligible_count, missing_count,
         duplicate_count, suppressed_count, scheduled_for, created_by)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,$7::integer,$8::text,$9::text,$10::text,$11::text,
        $12::integer,$13::integer,$14::integer,$15::integer,$16::timestamptz,$17::uuid)
      RETURNING ${broadcastHandleSql("member_email_broadcasts")} AS handle
    `, [id, context.organizationId, plan.snapshotId,
      plan.audienceKey.split(":", 1)[0], plan.audienceLabel,
      plan.audienceKey.includes(":") ? plan.audienceKey.split(":", 2)[1] : null,
      plan.representedRecipients,
      subjectIntegrity.blindIndexKeyVersion, subjectIntegrity.blindIndex,
      bodyIntegrity.blindIndexKeyVersion, bodyIntegrity.blindIndex,
      plan.eligible, plan.missing, plan.duplicate, plan.suppressed, scheduledFor, context.userId]);
    if (!created?.handle || !HANDLE_RE.test(created.handle)) fail("CREATE_FAILED", "The Preview broadcast could not be created safely.", 503);

    await query(`
      INSERT INTO local801.member_email_broadcast_content
        (organization_id, broadcast_id, subject_encrypted_payload, subject_encryption_key_version,
         subject_encryption_format_version, body_encrypted_payload, body_encryption_key_version, body_encryption_format_version)
      VALUES ($1::uuid,$2::uuid,$3::text,$4::text,$5::smallint,$6::text,$7::text,$8::smallint)
    `, [context.organizationId, id, subjectProtected.encryptedPayload, subjectProtected.encryptionKeyVersion,
      subjectProtected.encryptionFormatVersion, bodyProtected.encryptedPayload, bodyProtected.encryptionKeyVersion,
      bodyProtected.encryptionFormatVersion]);

    await query(`
      /* member-email:freeze-recipients */
      INSERT INTO local801.member_email_broadcast_recipients
        (id, organization_id, broadcast_id, person_id, user_id, contact_method_id, contact_kind, recipient_status,
         duplicate_of_recipient_id, email_blind_index_key_version, email_blind_index,
         email_encrypted_payload, email_encryption_key_version, email_encryption_format_version)
      SELECT value.id::uuid,$1::uuid,$2::uuid,value.person_id::uuid,value.user_id::uuid,value.contact_method_id::uuid,value.contact_kind,
        value.status,value.duplicate_of_recipient_id::uuid,value.blind_index_key_version,value.blind_index,
        value.encrypted_payload,value.encryption_key_version,value.encryption_format_version
      FROM jsonb_to_recordset($3::text::jsonb) AS value(
        id text, person_id text, user_id text, contact_method_id text, contact_kind text, status text,
        duplicate_of_recipient_id text, blind_index_key_version text, blind_index text,
        encrypted_payload text, encryption_key_version text, encryption_format_version smallint
      )
    `, [context.organizationId, id, JSON.stringify(protectedRecipients)]);

    const audit = await prepareAtomicAuditStatement({
      eventType: "broadcast.create", actorId: context.userId, organizationId: context.organizationId,
      subjectType: "member_email_broadcast", subjectId: id,
      payload: { eligibleCount: plan.eligible, missingCount: plan.missing, duplicateCount: plan.duplicate,
        suppressedCount: plan.suppressed, representedCount: plan.representedRecipients,
        audienceKind: plan.audienceKey.split(":", 1)[0],
        audienceReferenceHandle: plan.audienceKey.includes(":") ? plan.audienceKey.split(":", 2)[1] : null,
        sourceSnapshotId: plan.snapshotId, syntheticOnly: true },
    }, query);
    await query(audit.sql, audit.parameters);
    return { handle: created.handle };
  });
  const { snapshotId: _snapshotId, recipients: _recipients, ...audience } = plan;
  return { ...result, audience };
}

function publicStatus(value: string): MemberEmailBroadcastSummary["status"] {
  return value === "review" || value === "approved" || value === "simulated" || value === "cancelled" ? value : "draft";
}

function decryptSubject(row: BroadcastRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  const format = Number(row.subject_encryption_format_version);
  if (format !== 1) fail("CONTENT_UNAVAILABLE", "Protected broadcast content is unavailable.", 503);
  return decryptPiiField({
    encryptedPayload: row.subject_encrypted_payload,
    encryptionKeyVersion: row.subject_encryption_key_version,
    encryptionFormatVersion: 1,
  }, { organizationId, entity: "member-email-broadcast", recordId: row.id, field: "subject" }, keyConfig);
}

function decryptBody(row: RealTestBroadcastRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  const format = Number(row.body_encryption_format_version);
  if (format !== 1) fail("CONTENT_UNAVAILABLE", "Protected broadcast content is unavailable.", 503);
  return decryptPiiField({
    encryptedPayload: row.body_encrypted_payload,
    encryptionKeyVersion: row.body_encryption_key_version,
    encryptionFormatVersion: 1,
  }, { organizationId, entity: "member-email-broadcast", recordId: row.id, field: "body" }, keyConfig);
}

export async function listMemberEmailBroadcasts(context: WorkspaceContext, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  requireAccess(context, env);
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const rows = await query<BroadcastRow>(`
    /* member-email:list */
    SELECT broadcast.id::text, ${broadcastHandleSql("broadcast")} AS handle, broadcast.status,
      broadcast.source_snapshot_id::text, snapshot.snapshot_date, broadcast.audience_kind,
      broadcast.audience_label, broadcast.audience_reference_handle, broadcast.represented_count,
      broadcast.eligible_count,
      broadcast.missing_count, broadcast.duplicate_count, broadcast.suppressed_count,
      broadcast.scheduled_for, broadcast.created_by::text, broadcast.approved_by::text,
      broadcast.simulated_at, broadcast.created_at,
      content.subject_encrypted_payload, content.subject_encryption_key_version, content.subject_encryption_format_version
    FROM local801.member_email_broadcasts broadcast
    JOIN local801.membership_snapshots snapshot
      ON snapshot.organization_id = broadcast.organization_id AND snapshot.id = broadcast.source_snapshot_id
    JOIN local801.member_email_broadcast_content content
      ON content.organization_id = broadcast.organization_id AND content.broadcast_id = broadcast.id
    WHERE broadcast.organization_id = $1::uuid
    ORDER BY broadcast.created_at DESC, broadcast.id DESC
    LIMIT 25
  `, [context.organizationId]);
  return rows.filter((row) => HANDLE_RE.test(row.handle)).map((row): MemberEmailBroadcastSummary => ({
    handle: row.handle,
    subject: decryptSubject(row, context.organizationId, keyConfig),
    status: publicStatus(row.status),
    audienceLabel: row.audience_label,
    representedRecipients: count(row.represented_count),
    snapshotDate: dateOnly(row.snapshot_date),
    eligible: count(row.eligible_count),
    missing: count(row.missing_count),
    duplicate: count(row.duplicate_count),
    suppressed: count(row.suppressed_count),
    scheduledFor: timestamp(row.scheduled_for),
    createdAt: timestamp(row.created_at)!,
    simulatedAt: timestamp(row.simulated_at),
    requiresDifferentApprover: row.created_by === context.userId,
  }));
}

async function mutateStatus(
  context: WorkspaceContext,
  handle: string,
  action: "submit" | "approve" | "simulate_test" | "simulate_send",
  dependencies: Dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  requireAccess(context, env);
  if (!HANDLE_RE.test(handle)) fail("NOT_FOUND", "Preview broadcast not found.", 404);
  const transaction = dependencies.transaction ?? withLocal801Transaction;
  const now = (dependencies.now ?? (() => new Date()))();
  const deliveryBoundary = memberEmailDeliveryBoundary(env);
  return transaction(async (query) => {
    const [row] = await query<BroadcastRow>(`
      /* member-email:lock-broadcast */
      SELECT broadcast.id::text, ${broadcastHandleSql("broadcast")} AS handle, broadcast.status,
        broadcast.source_snapshot_id::text, snapshot.snapshot_date, broadcast.audience_kind,
        broadcast.audience_label, broadcast.audience_reference_handle, broadcast.represented_count,
        broadcast.eligible_count,
        broadcast.missing_count, broadcast.duplicate_count, broadcast.suppressed_count,
        broadcast.scheduled_for, broadcast.created_by::text, broadcast.approved_by::text,
        broadcast.simulated_at, broadcast.created_at,
        content.subject_encrypted_payload, content.subject_encryption_key_version, content.subject_encryption_format_version
      FROM local801.member_email_broadcasts broadcast
      JOIN local801.membership_snapshots snapshot
        ON snapshot.organization_id = broadcast.organization_id AND snapshot.id = broadcast.source_snapshot_id
      JOIN local801.member_email_broadcast_content content
        ON content.organization_id = broadcast.organization_id AND content.broadcast_id = broadcast.id
      WHERE broadcast.organization_id = $1::uuid AND ${broadcastHandleSql("broadcast")} = $2::text
      FOR UPDATE OF broadcast
    `, [context.organizationId, handle]);
    if (!row) fail("NOT_FOUND", "Preview broadcast not found.", 404);

    let eventType: "broadcast.submit" | "broadcast.approve" | "broadcast.test_simulated" | "broadcast.send_simulated";
    if (action === "submit") {
      if (row.status !== "draft") fail("INVALID_STATE", "Only a draft can be submitted for review.", 409);
      await query(`UPDATE local801.member_email_broadcasts SET status='review', submitted_by=$3::uuid,
        submitted_at=$4::timestamptz, updated_at=$4::timestamptz WHERE organization_id=$1::uuid AND id=$2::uuid`,
      [context.organizationId, row.id, context.userId, now.toISOString()]);
      eventType = "broadcast.submit";
    } else if (action === "approve") {
      if (row.status !== "review") fail("INVALID_STATE", "Only a reviewed broadcast can be approved.", 409);
      if (row.created_by === context.userId) fail("SEPARATE_APPROVER_REQUIRED", "A different authorized administrator must approve this broadcast.", 409);
      await query(`UPDATE local801.member_email_broadcasts SET status='approved', approved_by=$3::uuid,
        approved_at=$4::timestamptz, updated_at=$4::timestamptz WHERE organization_id=$1::uuid AND id=$2::uuid`,
      [context.organizationId, row.id, context.userId, now.toISOString()]);
      eventType = "broadcast.approve";
    } else if (action === "simulate_test") {
      if (!new Set(["draft", "review", "approved"]).has(row.status)) fail("INVALID_STATE", "This broadcast cannot run another test simulation.", 409);
      eventType = "broadcast.test_simulated";
    } else {
      if (row.status !== "approved") fail("INVALID_STATE", "Only an approved broadcast can simulate delivery.", 409);
      const scheduledFor = timestamp(row.scheduled_for);
      if (scheduledFor && new Date(scheduledFor).getTime() > now.getTime()) {
        fail("NOT_DUE", "The scheduled Preview simulation time has not arrived.", 409);
      }
      await query(`
        /* member-email:simulate-delivery */
        INSERT INTO local801.member_email_delivery_events
          (organization_id, broadcast_id, recipient_id, provider_event_id, event_type, occurred_at, metadata)
        SELECT $1::uuid,$2::uuid,recipient.id,
          'preview-send:' || $2::text || ':' || recipient.id::text,
          'simulated.delivered',$3::timestamptz,'{"syntheticOnly":true}'::jsonb
        FROM local801.member_email_broadcast_recipients recipient
        WHERE recipient.organization_id=$1::uuid AND recipient.broadcast_id=$2::uuid AND recipient.recipient_status='eligible'
        ON CONFLICT (organization_id, provider_event_id) DO NOTHING
      `, [context.organizationId, row.id, now.toISOString()]);
      const [delivered] = await query<{ delivered_count: number | string }>(`
        WITH updated AS (
          UPDATE local801.member_email_broadcast_recipients SET simulated_delivery_at=$3::timestamptz
          WHERE organization_id=$1::uuid AND broadcast_id=$2::uuid AND recipient_status='eligible'
          RETURNING id
        ) SELECT count(*)::integer AS delivered_count FROM updated
      `, [context.organizationId, row.id, now.toISOString()]);
      if (count(delivered?.delivered_count ?? 0) !== count(row.eligible_count)) {
        fail("RECIPIENT_SET_CHANGED", "The frozen recipient set did not match its approved count.", 409);
      }
      await query(`UPDATE local801.member_email_broadcasts SET status='simulated', simulated_by=$3::uuid,
        simulated_at=$4::timestamptz, updated_at=$4::timestamptz WHERE organization_id=$1::uuid AND id=$2::uuid`,
      [context.organizationId, row.id, context.userId, now.toISOString()]);
      eventType = "broadcast.send_simulated";
    }
    const audit = await prepareAtomicAuditStatement({
      eventType, actorId: context.userId, organizationId: context.organizationId,
      subjectType: "member_email_broadcast", subjectId: row.id,
      payload: { action, eligibleCount: count(row.eligible_count), syntheticOnly: true,
        audienceKind: row.audience_kind, audienceReferenceHandle: row.audience_reference_handle,
        deliveryMode: deliveryBoundary.mode, outboundNetworkAllowed: deliveryBoundary.outboundNetworkAllowed },
    }, query);
    await query(audit.sql, audit.parameters);
    return { action, status: action === "submit" ? "review" : action === "approve" ? "approved" : action === "simulate_send" ? "simulated" : row.status };
  });
}

export function submitMemberEmailBroadcast(context: WorkspaceContext, handle: string, dependencies?: Dependencies) {
  return mutateStatus(context, handle, "submit", dependencies);
}

export function approveMemberEmailBroadcast(context: WorkspaceContext, handle: string, dependencies?: Dependencies) {
  return mutateStatus(context, handle, "approve", dependencies);
}

export function simulateMemberEmailTest(context: WorkspaceContext, handle: string, dependencies?: Dependencies) {
  return mutateStatus(context, handle, "simulate_test", dependencies);
}

export function simulateMemberEmailSend(context: WorkspaceContext, handle: string, dependencies?: Dependencies) {
  return mutateStatus(context, handle, "simulate_send", dependencies);
}

export async function sendMemberEmailRealTest(context: WorkspaceContext, handle: string, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  requireAccess(context, env);
  const boundary = memberEmailRealTestBoundary(env);
  if (!HANDLE_RE.test(handle)) fail("NOT_FOUND", "Preview broadcast not found.", 404);
  const query = dependencies.query ?? queryLocal801;
  const [row] = await query<RealTestBroadcastRow>(`
    /* member-email:real-test-broadcast */
    SELECT broadcast.id::text, ${broadcastHandleSql("broadcast")} AS handle, broadcast.status,
      broadcast.source_snapshot_id::text, snapshot.snapshot_date, broadcast.audience_kind,
      broadcast.audience_label, broadcast.audience_reference_handle, broadcast.represented_count,
      broadcast.eligible_count,
      broadcast.missing_count, broadcast.duplicate_count, broadcast.suppressed_count,
      broadcast.scheduled_for, broadcast.created_by::text, broadcast.approved_by::text,
      broadcast.simulated_at, broadcast.created_at,
      content.subject_encrypted_payload, content.subject_encryption_key_version, content.subject_encryption_format_version,
      content.body_encrypted_payload, content.body_encryption_key_version, content.body_encryption_format_version
    FROM local801.member_email_broadcasts broadcast
    JOIN local801.membership_snapshots snapshot
      ON snapshot.organization_id = broadcast.organization_id AND snapshot.id = broadcast.source_snapshot_id
    JOIN local801.member_email_broadcast_content content
      ON content.organization_id = broadcast.organization_id AND content.broadcast_id = broadcast.id
    WHERE broadcast.organization_id = $1::uuid AND ${broadcastHandleSql("broadcast")} = $2::text
  `, [context.organizationId, handle]);
  if (!row) fail("NOT_FOUND", "Preview broadcast not found.", 404);
  if (!new Set(["draft", "review", "approved"]).has(row.status)) {
    fail("INVALID_STATE", "This broadcast cannot send a real Preview test.", 409);
  }

  const existing = await query<{ already_sent: boolean }>(`
    /* member-email:real-test-audit-check */
    SELECT true AS already_sent
    FROM local801.audit_events
    WHERE organization_id = $1::uuid AND event_type = 'broadcast.real_test_sent'
      AND subject_type = 'member_email_broadcast' AND subject_id = $2::uuid
    LIMIT 1
  `, [context.organizationId, row.id]);
  if (existing.length > 0) return { action: "real_test" as const, status: publicStatus(row.status), alreadySent: true };

  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const subject = decryptSubject(row, context.organizationId, keyConfig);
  const body = decryptBody(row, context.organizationId, keyConfig);
  const send = dependencies.sendPreviewTest ?? sendMemberEmailPreviewTest;
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await send({
      apiKey: boundary.apiKey,
      from: boundary.from,
      to: boundary.recipient,
      subject: `[CAT Preview Test] ${subject}`,
      text: `${body}\n\n---\nCAT Preview one-address test. No member broadcast was delivered.`,
      idempotencyKey: `cat-preview-test/${context.organizationId}/${row.id}`,
    }));
  } catch {
    fail("PROVIDER_REJECTED", "Resend did not accept the CAT Preview test email.", 502);
  }

  const transaction = dependencies.transaction ?? withLocal801Transaction;
  await transaction(async (transactionQuery) => {
    const audit = await prepareAtomicAuditStatement({
      eventType: "broadcast.real_test_sent",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "member_email_broadcast",
      subjectId: row.id,
      payload: {
        provider: boundary.provider,
        deliveryMode: boundary.mode,
        recipientCount: 1,
        memberDeliveryAllowed: false,
        providerMessageHash: createHash("sha256").update(providerMessageId).digest("hex"),
      },
    }, transactionQuery);
    await transactionQuery(audit.sql, audit.parameters);
  });
  return { action: "real_test" as const, status: publicStatus(row.status), alreadySent: false };
}

export const __testing = { content, schedule, MAX_RECIPIENTS, MAX_SUBJECT, MAX_BODY };
