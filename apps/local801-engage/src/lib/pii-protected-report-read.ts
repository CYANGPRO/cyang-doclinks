import "server-only";

import type { EngagementCommandCenterReport } from "./engagement-command-center.ts";
import type { EngagementReport } from "./reports.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import {
  assertPiiProtectedReadState,
  getPiiProtectedReadMode,
  PiiProtectedReadError,
} from "./pii-protected-read.ts";

const PREVIEW_ROW_LIMIT = 500;

const PERIOD_DAYS = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
} as const;

type ProtectedUserRow = {
  user_id: string;
  display_name_encrypted_payload: string;
  display_name_encryption_key_version: string;
  display_name_encryption_format_version: number;
};

type EngagementOrganizerRow = {
  user_id: string | null;
  event_count: unknown;
};

type CommandCenterOrganizerRow = {
  user_id: string | null;
  assigned_count: unknown;
  reached_in_period_count: unknown;
  engagement_event_count: unknown;
  outstanding_followup_count: unknown;
  overdue_followup_count: unknown;
};

function blocked(code: string, message: string): never {
  throw new PiiProtectedReadError(code, message);
}

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((Math.min(numerator, denominator) / denominator) * 1000) / 10 : 0;
}

function encrypted(
  row: Record<string, unknown>,
  payload: string,
  key: string,
  format: string,
): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[key];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    blocked("ENVELOPE_INVALID", "A protected PII companion has an invalid envelope.");
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 };
}

function decryptUserDisplayName(row: ProtectedUserRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"),
    { organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
    keyConfig,
  );
}

function uniqueMap<T>(rows: readonly T[], key: (row: T) => string, label: string) {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) blocked("DUPLICATE_COMPANION", `Duplicate ${label} protected companion detected.`);
    result.set(id, row);
  }
  return result;
}

async function getProtectedUsers(
  organizationId: string,
  query: DatabaseQuery,
): Promise<Map<string, ProtectedUserRow>> {
  const users = await query<ProtectedUserRow>(`
    /* pii-protected-report-read:users */
    SELECT user_id::text,
      display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version
    FROM local801.user_pii
    WHERE organization_id = $1::uuid
    ORDER BY user_id
    LIMIT ${PREVIEW_ROW_LIMIT + 1}
  `, [organizationId]);
  if (users.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected report read exceeded its bounded user limit.");
  return uniqueMap(users, (row) => row.user_id, "report user");
}

function protectedOrganizerLabel(
  userId: string | null,
  usersById: Map<string, ProtectedUserRow>,
  organizationId: string,
  keyConfig: PiiKeyConfiguration,
) {
  if (!userId) return "Unknown organizer";
  const user = usersById.get(userId);
  if (!user) blocked("COMPANION_MISSING", "A report organizer is missing its protected PII companion.");
  return decryptUserDisplayName(user, organizationId, keyConfig);
}

export async function hydrateEngagementReportFromProtectedPii(
  organizationId: string,
  report: EngagementReport,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<EngagementReport> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return report;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const [organizers, usersById] = await Promise.all([
    query<EngagementOrganizerRow>(`
      /* pii-protected-report-read:engagement-organizers */
      SELECT organizer_user_id::text AS user_id,
        COALESCE(sum(event_count), 0) AS event_count
      FROM reporting.engagement_by_organizer
      WHERE organization_id = $1::uuid
      GROUP BY organizer_user_id
      ORDER BY event_count DESC, organizer_user_id ASC NULLS LAST
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId]),
    getProtectedUsers(organizationId, query),
  ]);
  if (organizers.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected engagement reporting exceeded its bounded organizer limit.");

  return {
    ...report,
    organizers: organizers.map((row) => ({
      label: protectedOrganizerLabel(row.user_id, usersById, organizationId, keyConfig),
      eventCount: count(row.event_count),
    })),
  };
}

function commandCenterParameters(report: EngagementCommandCenterReport, organizationId: string) {
  const periodDays = report.filters.period === "all" ? null : PERIOD_DAYS[report.filters.period];
  return [
    organizationId,
    report.filters.department,
    report.filters.workLocation,
    report.filters.membershipStatus,
    report.filters.employeeGroup,
    periodDays,
  ] as const;
}

function cohortCte() {
  return `
    WITH cohort AS (
      SELECT membership.person_id
      FROM reporting.current_membership membership
      WHERE membership.organization_id = $1::uuid
        AND ($2::text IS NULL OR COALESCE(NULLIF(trim(membership.department), ''), 'Unspecified') = $2::text)
        AND ($3::text IS NULL OR COALESCE(NULLIF(trim(membership.work_location), ''), 'Unspecified') = $3::text)
        AND ($4::text IS NULL OR membership.membership_status = $4::text)
        AND (
          $5::text = 'all'
          OR EXISTS (
            SELECT 1
            FROM reporting.new_hires hire
            WHERE hire.organization_id = membership.organization_id
              AND hire.person_id = membership.person_id
              AND ($6::integer IS NULL OR hire.hire_date >= current_date - $6::integer)
          )
        )
    )`;
}

export async function hydrateCommandCenterReportFromProtectedPii(
  organizationId: string,
  report: EngagementCommandCenterReport,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<EngagementCommandCenterReport> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return report;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const parameters = commandCenterParameters(report, organizationId);
  const [organizers, usersById] = await Promise.all([
    query<CommandCenterOrganizerRow>(`
      /* pii-protected-report-read:command-center-organizers */
      ${cohortCte()},
      organizer_assignments AS (
        SELECT assignment.primary_user_id AS organizer_user_id, assignment.person_id
        FROM local801.engagement_assignments assignment
        JOIN cohort ON cohort.person_id = assignment.person_id
        WHERE assignment.organization_id = $1::uuid
          AND assignment.archived_at IS NULL
          AND assignment.primary_user_id IS NOT NULL
      ),
      assigned_summary AS (
        SELECT
          organizer_user_id,
          count(DISTINCT person_id) AS assigned_count,
          count(DISTINCT person_id) FILTER (
            WHERE EXISTS (
              SELECT 1
              FROM local801.engagement_events event
              WHERE event.organization_id = $1::uuid
                AND event.person_id = organizer_assignments.person_id
                AND event.voided_at IS NULL
                AND ($6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer))
            )
          ) AS reached_in_period_count
        FROM organizer_assignments
        GROUP BY organizer_user_id
      ),
      organizer_events AS (
        SELECT event.recorded_by AS organizer_user_id, count(*) AS engagement_event_count
        FROM local801.engagement_events event
        JOIN cohort ON cohort.person_id = event.person_id
        WHERE event.organization_id = $1::uuid
          AND event.voided_at IS NULL
          AND ($6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer))
        GROUP BY event.recorded_by
      ),
      organizer_followups AS (
        SELECT
          followup.assigned_to AS organizer_user_id,
          count(*) FILTER (WHERE followup.completed_at IS NULL) AS outstanding_followup_count,
          count(*) FILTER (WHERE followup.completed_at IS NULL AND followup.due_at < now()) AS overdue_followup_count
        FROM local801.engagement_followups followup
        JOIN cohort ON cohort.person_id = followup.person_id
        WHERE followup.organization_id = $1::uuid
          AND followup.assigned_to IS NOT NULL
        GROUP BY followup.assigned_to
      ),
      organizer_ids AS (
        SELECT organizer_user_id FROM assigned_summary
        UNION
        SELECT organizer_user_id FROM organizer_events
        UNION
        SELECT organizer_user_id FROM organizer_followups
      )
      SELECT organizer_ids.organizer_user_id::text AS user_id,
        COALESCE(assigned_summary.assigned_count, 0) AS assigned_count,
        COALESCE(assigned_summary.reached_in_period_count, 0) AS reached_in_period_count,
        COALESCE(organizer_events.engagement_event_count, 0) AS engagement_event_count,
        COALESCE(organizer_followups.outstanding_followup_count, 0) AS outstanding_followup_count,
        COALESCE(organizer_followups.overdue_followup_count, 0) AS overdue_followup_count
      FROM organizer_ids
      LEFT JOIN assigned_summary ON assigned_summary.organizer_user_id = organizer_ids.organizer_user_id
      LEFT JOIN organizer_events ON organizer_events.organizer_user_id = organizer_ids.organizer_user_id
      LEFT JOIN organizer_followups ON organizer_followups.organizer_user_id = organizer_ids.organizer_user_id
      ORDER BY assigned_count DESC, organizer_ids.organizer_user_id ASC NULLS LAST
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, parameters),
    getProtectedUsers(organizationId, query),
  ]);
  if (organizers.length > PREVIEW_ROW_LIMIT) blocked("PREVIEW_BOUND_EXCEEDED", "Protected command-center reporting exceeded its bounded organizer limit.");

  return {
    ...report,
    organizers: organizers.map((row) => {
      const assignedCount = count(row.assigned_count);
      const reachedInPeriodCount = Math.min(count(row.reached_in_period_count), assignedCount);
      return {
        label: protectedOrganizerLabel(row.user_id, usersById, organizationId, keyConfig),
        assignedCount,
        reachedInPeriodCount,
        coverageRate: rate(reachedInPeriodCount, assignedCount),
        engagementEventCount: count(row.engagement_event_count),
        outstandingFollowupCount: count(row.outstanding_followup_count),
        overdueFollowupCount: count(row.overdue_followup_count),
      };
    }),
  };
}
