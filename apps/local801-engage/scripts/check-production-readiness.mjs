import { getProductionLaunchState } from "../src/lib/production-launch-policy.ts";

const preflight = process.argv.includes("--preflight");
const reportOnly = process.argv.includes("--report-only");
const vercelProductionOnly = process.argv.includes("--vercel-production-only");

if (reportOnly && !vercelProductionOnly) {
  throw new Error("Readiness report-only mode is restricted to the Vercel Production build evidence path.");
}

// Sensitive Vercel variables cannot be exported after creation. Run the same secret-safe preflight
// inside the Production build, where those values are available, and emit only blocker codes plus
// aggregate infrastructure status. Preview, CI, and local builds deliberately produce no report.
if (vercelProductionOnly && process.env.VERCEL_ENV !== "production") process.exit(0);

const evaluatedEnv = preflight
  ? { ...process.env, LOCAL801_PRODUCTION_LAUNCH_ENABLED: "1" }
  : process.env;
const state = getProductionLaunchState(evaluatedEnv);
let infrastructure = { database: "not-checked", storage: "not-checked" };
const blockers = [...state.blockers];
const infrastructureCheckEligible = state.ready || (
  preflight
  && blockers.every((blocker) => blocker === "SECURITY_REVIEW_NOT_APPROVED" || blocker === "SECURITY_REVIEW_ID_MISSING")
);

if (infrastructureCheckEligible) {
  try {
    const [{ queryLocal801 }, { checkStorageReadiness }] = await Promise.all([
      import("../src/lib/db.ts"),
      import("../src/lib/r2.ts"),
    ]);
    const rows = await queryLocal801(`
      SELECT
        count(*) = 1
          AND bool_and(state.write_mode = 'protected')
          AND bool_and(state.backfill_state = 'complete')
          AND bool_and(state.protected_read_enabled_at IS NOT NULL)
          AND bool_and(state.protected_write_enabled_at IS NOT NULL)
          AND bool_and(state.verified_at IS NOT NULL)
          AND to_regclass('local801.api_rate_limit_buckets') IS NOT NULL
          AND to_regclass('local801.user_policy_acknowledgements') IS NOT NULL
          AND to_regclass('local801.user_identity_onboarding') IS NOT NULL
          AS accepted
      FROM local801.organizations organization
      JOIN local801.pii_protection_state state ON state.organization_id = organization.id
      WHERE organization.slug = $1::text AND organization.archived_at IS NULL
    `, [evaluatedEnv.LOCAL801_ORGANIZATION_SLUG]);
    infrastructure.database = rows[0]?.accepted ? "ok" : "error";
    if (infrastructure.database !== "ok") blockers.push("DATABASE_STATE_INVALID");
    infrastructure.storage = (await checkStorageReadiness()).storage;
    if (infrastructure.storage !== "ok") blockers.push("STORAGE_UNAVAILABLE");
  } catch {
    infrastructure = { database: "error", storage: "error" };
    blockers.push("INFRASTRUCTURE_CHECK_UNAVAILABLE");
  }
}

const safeOutput = {
  mode: vercelProductionOnly ? "vercel-production-build-preflight" : preflight ? "preflight" : "active-environment",
  environment: state.environment,
  launchRequested: state.launchRequested,
  ready: state.ready && blockers.length === 0,
  blockers,
  infrastructure,
};

process.stdout.write(`${JSON.stringify(safeOutput, null, 2)}\n`);
process.exitCode = reportOnly || safeOutput.ready ? 0 : 2;
