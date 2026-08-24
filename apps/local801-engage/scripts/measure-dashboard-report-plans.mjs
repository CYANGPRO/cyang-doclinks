import postgres from "postgres";
import { getDashboardMetrics } from "../src/lib/metrics.ts";
import { databaseOperation } from "../src/lib/performance-timing.ts";
import { getEngagementReport, getMembershipReport, getNewHireReport } from "../src/lib/reports.ts";

const databaseUrl = process.env.LOCAL801_DATABASE_URL?.trim();
const organizationSlug = process.env.LOCAL801_ORGANIZATION_SLUG?.trim();
if (!databaseUrl || !organizationSlug) {
  throw new Error("LOCAL801_DATABASE_URL and LOCAL801_ORGANIZATION_SLUG are required.");
}

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5, prepare: false });
const plans = [];

try {
  await sql.begin(async (transaction) => {
    await transaction.unsafe("SET TRANSACTION READ ONLY");
    await transaction.unsafe("SET LOCAL statement_timeout = '15s'");
    const organizations = await transaction.unsafe(`
      SELECT id::text AS organization_id
      FROM local801.organizations
      WHERE slug = $1::text AND archived_at IS NULL
      LIMIT 1
    `, [organizationSlug]);
    if (organizations.length !== 1) throw new Error("The configured active organization was not found.");
    const organizationId = organizations[0].organization_id;
    const actors = await transaction.unsafe(`
      SELECT app_user.id::text AS user_id, role.code AS role
      FROM local801.users app_user
      JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
      JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = app_user.organization_id
      WHERE app_user.organization_id = $1::uuid AND app_user.deactivated_at IS NULL
      ORDER BY CASE role.code WHEN 'system_owner' THEN 0 WHEN 'local_admin' THEN 1 ELSE 2 END, app_user.id
      LIMIT 1
    `, [organizationId]);
    if (actors.length !== 1) throw new Error("No active report-authorized account was found.");
    const context = {
      organizationId,
      organizationSlug,
      userId: actors[0].user_id,
      email: "redacted@example.test",
      role: actors[0].role,
    };

    const explain = async (statement, parameters = []) => {
      const rows = await transaction.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING FALSE, SUMMARY TRUE) ${statement}`,
        [...parameters],
      );
      const report = rows[0]?.["QUERY PLAN"]?.[0];
      plans.push({
        operation: databaseOperation(statement),
        planningMs: Number(report?.["Planning Time"] ?? 0).toFixed(2),
        executionMs: Number(report?.["Execution Time"] ?? 0).toFixed(2),
        node: report?.Plan?.["Node Type"] ?? "unknown",
        sharedHits: report?.Plan?.["Shared Hit Blocks"] ?? 0,
        sharedReads: report?.Plan?.["Shared Read Blocks"] ?? 0,
      });
      return [];
    };

    await getDashboardMetrics(context, async (statement, parameters) => {
      await explain(statement, parameters);
      return [{ organization_exists: true }];
    });
    await getMembershipReport(context, explain);
    await getNewHireReport(context, explain);
    await getEngagementReport(context, explain);
  });
  console.table(plans);
} finally {
  await sql.end({ timeout: 1 });
}
