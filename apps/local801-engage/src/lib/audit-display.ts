import "server-only";

import { getAuditPage, type AuditEventRecord } from "./audit.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const MAX_AUDIT_ACTORS = 100;

const EVENT_LABELS: Record<string, string> = {
  "auth.sign_in": "Signed in",
  "policy.acknowledged": "Acknowledged privacy and acceptable use",
  "session.mobile_device_attested": "Verified mobile device",
  "session.mobile_push_registered": "Registered native notifications",
  "import.preview": "Previewed import",
  "import.upload": "Uploaded import",
  "import.validation": "Validated import",
  "import.reject_errors_download": "Downloaded import errors",
  "import.resolution_set": "Set import resolution",
  "import.resolution_cleared": "Cleared import resolution",
  "import.approval_plan_update": "Updated import approval plan",
  "import.duplicate_source_ack": "Acknowledged duplicate import source",
  "import.review_new_people": "Approved proposed new people",
  "import.review_existing_changes": "Acknowledged existing-person changes",
  "import.review_decision_cleared": "Cleared import review decision",
  "import.execute": "Executed import",
  "record.create": "Created record",
  "record.update": "Updated record",
  "role.change": "Changed user role",
  "report.run": "Ran report",
  "export.generate": "Generated export",
  "config.change": "Changed configuration",
  "record.archive": "Archived record",
  "record.restore": "Restored record",
};

const SUBJECT_LABELS: Record<string, string> = {
  import_batch: "Import batch",
  import_file: "Import file",
  person: "Person",
  user: "Workspace user",
  engagement_event: "Engagement",
  engagement_followup: "Follow-up",
  outreach_campaign: "Campaign",
  campaign: "Campaign",
  cat_action: "CAT action",
  cat_action_task: "CAT action task",
  document: "Document",
  report: "Report",
  configuration: "Configuration",
  policy_acknowledgement: "Policy acknowledgment",
};

export const auditEventFilterOptions = Object.entries(EVENT_LABELS)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

function humanize(value: string) {
  const normalized = value.replace(/[._-]+/g, " ").trim();
  if (!normalized) return "Activity";
  return normalized[0].toUpperCase() + normalized.slice(1);
}

export function auditEventLabel(value: string) {
  return EVENT_LABELS[value] ?? humanize(value);
}

export function auditSubjectLabel(value: string | null) {
  if (!value) return "General activity";
  return SUBJECT_LABELS[value] ?? humanize(value);
}

type ProtectedActorRow = {
  user_id: string;
  display_name_encrypted_payload: string;
  display_name_encryption_key_version: string;
  display_name_encryption_format_version: number;
};

function encryptedDisplayName(row: ProtectedActorRow): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  if (
    typeof row.display_name_encrypted_payload !== "string"
    || typeof row.display_name_encryption_key_version !== "string"
    || Number(row.display_name_encryption_format_version) !== 1
  ) {
    throw new Error("Protected audit actor display data is invalid.");
  }
  return {
    encryptedPayload: row.display_name_encrypted_payload,
    encryptionKeyVersion: row.display_name_encryption_key_version,
    encryptionFormatVersion: 1,
  };
}

export type AuditDisplayEvent = AuditEventRecord & {
  eventLabel: string;
  subjectLabel: string;
  actorDisplayName: string | null;
};

export type AuditDisplayPage = Omit<Awaited<ReturnType<typeof getAuditPage>>, "events"> & {
  events: AuditDisplayEvent[];
  protectedActorNames: boolean;
};

export async function getAuditDisplayPage(
  context: WorkspaceContext,
  input: { eventType?: unknown; cursor?: unknown; pageSize?: unknown },
  dependencies: {
    query?: DatabaseQuery;
    env?: NodeJS.ProcessEnv;
    keyConfig?: PiiKeyConfiguration;
  } = {},
): Promise<AuditDisplayPage> {
  const query = dependencies.query ?? queryLocal801;
  const page = await getAuditPage(context, input, query);
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);

  const baseEvents = page.events.map((event) => ({
    ...event,
    eventLabel: auditEventLabel(event.event_type),
    subjectLabel: auditSubjectLabel(event.subject_type),
    actorDisplayName: null as string | null,
  }));

  if (mode === "legacy") {
    return { ...page, events: baseEvents, protectedActorNames: false };
  }

  await assertPiiProtectedReadState(context.organizationId, query, mode);
  const actorIds = [...new Set(page.events.flatMap((event) => event.actor_user_id ? [event.actor_user_id] : []))];
  if (actorIds.length > MAX_AUDIT_ACTORS) throw new Error("Audit actor display exceeded its bounded read limit.");
  if (actorIds.length === 0) return { ...page, events: baseEvents, protectedActorNames: true };

  const rows = await query<ProtectedActorRow>(`
    /* audit-display:protected-actors */
    WITH requested AS (
      SELECT requested_id::uuid AS user_id
      FROM jsonb_array_elements_text($2::text::jsonb) AS requested(requested_id)
    )
    SELECT protected.user_id::text,
      protected.display_name_encrypted_payload,
      protected.display_name_encryption_key_version,
      protected.display_name_encryption_format_version
    FROM local801.user_pii protected
    JOIN requested ON requested.user_id = protected.user_id
    WHERE protected.organization_id = $1::uuid
    ORDER BY protected.user_id
    LIMIT ${MAX_AUDIT_ACTORS + 1}
  `, [context.organizationId, JSON.stringify(actorIds)]);
  if (rows.length > MAX_AUDIT_ACTORS) throw new Error("Audit actor display exceeded its bounded read limit.");

  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  const actors = new Map<string, string>();
  for (const row of rows) {
    if (actors.has(row.user_id)) throw new Error("Duplicate protected audit actor companion detected.");
    const displayName = decryptPiiField(
      encryptedDisplayName(row),
      { organizationId: context.organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
      keyConfig,
    );
    actors.set(row.user_id, displayName);
  }

  return {
    ...page,
    protectedActorNames: true,
    events: baseEvents.map((event) => ({
      ...event,
      actorDisplayName: event.actor_user_id ? actors.get(event.actor_user_id) ?? null : null,
    })),
  };
}
