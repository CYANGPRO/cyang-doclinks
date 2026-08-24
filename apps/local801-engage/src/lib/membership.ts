import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type MembershipSummary = {
  represented: number | "—";
  members: number | "—";
  nonmembers: number | "—";
  additionsThisMonth: number | "—";
  dropsThisMonth: number | "—";
  netChange: number | "—";
  snapshotDate: string | null;
  sourceLabel: string;
  source: "database" | "unavailable";
};

export type MembershipBreakdown = {
  dimension: "department" | "classification" | "job_status" | "location";
  label: string;
  represented: number;
  members: number;
  membershipPercentage: string;
};

type MembershipSummaryRow = {
  snapshot_date: string | Date;
  represented: number | string;
  members: number | string;
  nonmembers: number | string;
  additions_this_month: number | string;
  drops_this_month: number | string;
  net_change: number | string;
};

export function unavailableMembershipSummary(): MembershipSummary {
  return {
    represented: "—",
    members: "—",
    nonmembers: "—",
    additionsThisMonth: "—",
    dropsThisMonth: "—",
    netChange: "—",
    snapshotDate: null,
    sourceLabel: "Approved snapshot unavailable",
    source: "unavailable",
  };
}

function finiteNumber(value: number | string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOnly(value: string | Date) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

export async function getMembershipSummary(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<MembershipSummary> {
  if (!can(context.role, "manageImports")) throw new Error("Membership access is not authorized.");
  try {
    const [row] = await query<MembershipSummaryRow>(
      `
        WITH latest_approved_snapshot AS (
          SELECT id, snapshot_date, approved_at, created_at
          FROM local801.membership_snapshots
          WHERE organization_id = $1
            AND status = 'approved'
          ORDER BY
            snapshot_date DESC,
            approved_at DESC NULLS LAST,
            created_at DESC,
            id DESC
          LIMIT 1
        )
        SELECT
          snapshot.snapshot_date,
          count(snapshot_row.id) FILTER (
            WHERE snapshot_row.membership_status IN ('member', 'nonmember')
          ) AS represented,
          count(snapshot_row.id) FILTER (
            WHERE snapshot_row.membership_status = 'member'
          ) AS members,
          count(snapshot_row.id) FILTER (
            WHERE snapshot_row.membership_status = 'nonmember'
          ) AS nonmembers,
          COALESCE((
            SELECT count(*)
            FROM local801.membership_events event
            WHERE event.organization_id = $1
              AND event.event_type = 'addition'
              AND event.effective_date >= date_trunc('month', current_date)::date
              AND event.effective_date < (date_trunc('month', current_date) + interval '1 month')::date
          ), 0) AS additions_this_month,
          COALESCE((
            SELECT count(*)
            FROM local801.membership_events event
            WHERE event.organization_id = $1
              AND event.event_type = 'drop'
              AND event.effective_date >= date_trunc('month', current_date)::date
              AND event.effective_date < (date_trunc('month', current_date) + interval '1 month')::date
          ), 0) AS drops_this_month,
          COALESCE((
            SELECT
              count(*) FILTER (WHERE event.event_type = 'addition')
              - count(*) FILTER (WHERE event.event_type = 'drop')
            FROM local801.membership_events event
            WHERE event.organization_id = $1
              AND event.effective_date >= date_trunc('month', current_date)::date
              AND event.effective_date < (date_trunc('month', current_date) + interval '1 month')::date
          ), 0) AS net_change
        FROM latest_approved_snapshot snapshot
        LEFT JOIN local801.membership_snapshot_rows snapshot_row
          ON snapshot_row.snapshot_id = snapshot.id
         AND snapshot_row.organization_id = $1
        GROUP BY snapshot.id, snapshot.snapshot_date
      `,
      [context.organizationId],
    );

    if (!row) return unavailableMembershipSummary();
    const snapshotDate = dateOnly(row.snapshot_date);

    return {
      represented: finiteNumber(row.represented),
      members: finiteNumber(row.members),
      nonmembers: finiteNumber(row.nonmembers),
      additionsThisMonth: finiteNumber(row.additions_this_month),
      dropsThisMonth: finiteNumber(row.drops_this_month),
      netChange: finiteNumber(row.net_change),
      snapshotDate,
      sourceLabel: `Approved snapshot · ${snapshotDate}`,
      source: "database",
    };
  } catch {
    return unavailableMembershipSummary();
  }
}

export async function getMembershipBreakdowns(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<MembershipBreakdown[]> {
  if (!can(context.role, "manageImports")) throw new Error("Membership access is not authorized.");
  const rows = await query<{
    dimension: MembershipBreakdown["dimension"];
    label: string;
    represented: number | string;
    members: number | string;
  }>(`
    /* membership:bounded-breakdowns */
    WITH latest_snapshot AS (
      SELECT id FROM local801.membership_snapshots
      WHERE organization_id = $1 AND status = 'approved'
      ORDER BY snapshot_date DESC, approved_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    ), current_people AS (
      SELECT person.department, person.classification, person.section, snapshot_row.membership_status
      FROM latest_snapshot snapshot
      JOIN local801.membership_snapshot_rows snapshot_row
        ON snapshot_row.snapshot_id = snapshot.id AND snapshot_row.organization_id = $1
      JOIN local801.people person
        ON person.id = snapshot_row.person_id AND person.organization_id = $1 AND person.archived_at IS NULL
      WHERE snapshot_row.membership_status IN ('member', 'nonmember')
    ), grouped AS (
      SELECT 'department'::text AS dimension, COALESCE(NULLIF(btrim(department), ''), 'Unspecified') AS label,
        count(*) AS represented, count(*) FILTER (WHERE membership_status = 'member') AS members
      FROM current_people GROUP BY 2
      UNION ALL
      SELECT 'classification', COALESCE(NULLIF(btrim(classification), ''), 'Unspecified'),
        count(*), count(*) FILTER (WHERE membership_status = 'member')
      FROM current_people GROUP BY 2
      UNION ALL
      SELECT 'location', COALESCE(NULLIF(btrim(section), ''), 'Unspecified'),
        count(*), count(*) FILTER (WHERE membership_status = 'member')
      FROM current_people GROUP BY 2
    )
    SELECT dimension, label, represented, members
    FROM grouped
    ORDER BY dimension, label ASC
    LIMIT 150
  `, [context.organizationId]);
  return rows.map((row) => {
    const represented = finiteNumber(row.represented);
    const members = finiteNumber(row.members);
    return { dimension: row.dimension, label: row.label, represented, members, membershipPercentage: represented ? `${((members / represented) * 100).toFixed(1)}%` : "0.0%" };
  });
}
