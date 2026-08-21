import "server-only";

import { createHash } from "node:crypto";
import { decryptEnvelope } from "./encryption.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";
import type { NoteVisibility } from "./engagement-recording.ts";

export type RecentEngagementHistoryItem = {
  occurredAt: string;
  contactMethod: string;
  outcome: string;
  note: string | null;
  noteVisibility: NoteVisibility | null;
};

type EngagementNoteRow = {
  occurred_at: string | Date;
  contact_method: string;
  outcome: string;
  encrypted_payload: string | null;
  visibility: NoteVisibility | null;
  note_hash: string | null;
  encryption_key_version: string | null;
  encryption_format_version: number | null;
};

function iso(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Engagement timestamp is invalid.");
  return date.toISOString();
}

export async function listRecentEngagementHistory(
  context: WorkspaceContext,
  personId: string,
  query: DatabaseQuery = queryLocal801,
): Promise<RecentEngagementHistoryItem[]> {
  const rows = await query<EngagementNoteRow>(`
    /* engagement-notes:recent-history */
    SELECT
      event.occurred_at,
      event.contact_method,
      event.outcome,
      note.encrypted_payload,
      note.visibility,
      event.note_hash,
      note.encryption_key_version,
      note.encryption_format_version
    FROM local801.engagement_events event
    LEFT JOIN local801.engagement_notes note
      ON note.organization_id = $1::uuid
     AND note.engagement_event_id = event.id
     AND note.archived_at IS NULL
     AND note.visibility = event.note_visibility
     AND (
       (note.visibility = 'writer_only' AND note.created_by = $3::uuid)
       OR (note.visibility = 'assigned_scope' AND (
         $4::text IN ('system_owner','local_admin','cat_admin')
         OR EXISTS (
           SELECT 1
           FROM local801.engagement_assignments assignment
           WHERE assignment.organization_id = $1::uuid
             AND assignment.person_id = event.person_id
             AND assignment.archived_at IS NULL
             AND assignment.status = 'open'
             AND (assignment.primary_user_id = $3::uuid OR assignment.backup_user_id = $3::uuid)
         )
       ))
       OR (note.visibility = 'cat_members' AND $4::text IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member'))
       OR (note.visibility = 'cat_leads' AND $4::text IN ('system_owner','local_admin','cat_admin','cat_lead'))
       OR (note.visibility = 'administrators' AND $4::text IN ('system_owner','local_admin','cat_admin'))
     )
    WHERE event.organization_id = $1::uuid
      AND event.person_id = $2::uuid
      AND event.voided_at IS NULL
    ORDER BY event.occurred_at DESC, event.id DESC
    LIMIT 10
  `, [context.organizationId, personId, context.userId, context.role]);

  return rows.map((row) => {
    if (row.encrypted_payload) {
      const envelopeHash = createHash("sha256").update(row.encrypted_payload, "utf8").digest("hex");
      if (!row.note_hash || envelopeHash !== row.note_hash) throw new Error("Encrypted engagement note integrity check failed.");
    }
    let note: string | null = null;
    if (row.encrypted_payload) {
      const decrypted = decryptEnvelope(row.encrypted_payload);
      if (row.encryption_key_version !== decrypted.keyVersion || row.encryption_format_version !== decrypted.formatVersion) {
        throw new Error("Encrypted engagement note metadata check failed.");
      }
      note = decrypted.plaintext.toString("utf8");
    }
    return {
      occurredAt: iso(row.occurred_at),
      contactMethod: row.contact_method,
      outcome: row.outcome,
      note,
      noteVisibility: row.visibility,
    };
  });
}
