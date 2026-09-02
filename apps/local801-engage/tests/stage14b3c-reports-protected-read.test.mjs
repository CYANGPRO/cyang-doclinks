import test from "node:test";
import assert from "node:assert/strict";
import {
  hydrateCommandCenterReportFromProtectedPii,
  hydrateEngagementReportFromProtectedPii,
} from "../src/lib/pii-protected-report-read.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "33333333-3333-4333-8333-333333333333";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const blindKey = Buffer.alloc(32, 9).toString("base64");

function env() {
  return {
    VERCEL_ENV: "preview",
    LOCAL801_PII_PROTECTED_READ_PREVIEW_ENABLED: "1",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "1",
    LOCAL801_PII_BACKFILL_ENABLED: "0",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "0",
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: encryptionKey }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: blindKey }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
  };
}

function state() {
  return [{
    write_mode: "dual",
    backfill_state: "complete",
    backfill_completed_at: new Date().toISOString(),
    protected_read_enabled_at: null,
    protected_write_enabled_at: null,
    verified_at: null,
  }];
}

function protectedUser(keyConfig) {
  const display = encryptPiiField(
    "Synthetic CAT Lead",
    { organizationId, entity: "user", recordId: userId, field: "display-name" },
    keyConfig,
  );
  return {
    user_id: userId,
    display_name_encrypted_payload: display.encryptedPayload,
    display_name_encryption_key_version: display.encryptionKeyVersion,
    display_name_encryption_format_version: display.encryptionFormatVersion,
  };
}

function engagementReport() {
  return {
    overview: { eventCount: 3, activeOrganizerCount: 1, followupCount: 0, openFollowupCount: 0 },
    daily: [], contactMethods: [], outcomes: [], departments: [], workLocations: [],
    organizers: [{ label: "WRONG LEGACY NAME", eventCount: 3 }],
    followupStatuses: [], campaignCoverage: [],
  };
}

function commandCenterReport() {
  return {
    filters: { period: "30d", department: null, workLocation: null, membershipStatus: null, employeeGroup: "all", breakdown: "department" },
    filterOptions: { departments: [], workLocations: [] },
    overview: { representedCount: 2, assignedCount: 1, unassignedCount: 1, everEngagedCount: 1, neverEngagedCount: 1, recentEngagedCount: 1, stale90Count: 0, coverageRate: 50, recentCoverageRate: 50, assignmentRate: 50 },
    followups: { outstandingCount: 0, overdueCount: 0, dueSoonCount: 0, completedCount: 0, averageCloseDays: null },
    newHires: { hireCount: 0, engagedWithin7Count: 0, engagedWithin14Count: 0, engagedWithin30Count: 0, missed14DayTargetCount: 0, within7Rate: 0, within14Rate: 0, within30Rate: 0 },
    depth: [], departments: [], workLocations: [],
    organizers: [{ handle: "c".repeat(64), label: "WRONG LEGACY NAME", assignedCount: 1, reachedInPeriodCount: 1, coverageRate: 100, engagementEventCount: 2, outstandingFollowupCount: 1, overdueFollowupCount: 0 }],
    actionReadiness: { actionSignalCount: 0, willingEmployeeCount: 0, consideringEmployeeCount: 0, completedEmployeeCount: 0, declinesAllCount: 0, specificDeclineEmployeeCount: 0, noActionSignalCount: 2, willingActionCount: 0, completedActionCount: 0, readinessCaptureRate: 0, willingEmployeeRate: 0 },
    actionReadinessByAction: [], actionReadinessDepth: [],
  };
}

test("engagement organizer labels use protected user PII", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("report-read:users")) return [protectedUser(keyConfig)];
    if (sql.includes("engagement-organizers")) return [{ user_id: userId, event_count: 3 }];
    throw new Error("unexpected query");
  };
  const result = await hydrateEngagementReportFromProtectedPii(organizationId, engagementReport(), { query, env: environment, keyConfig });
  assert.deepEqual(result.organizers, [{ label: "Synthetic CAT Lead", eventCount: 3 }]);
});

test("command-center organizer labels and metrics use protected user PII", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("report-read:users")) return [protectedUser(keyConfig)];
    if (sql.includes("command-center-organizers")) return [{ user_id: userId, organizer_handle: "c".repeat(64), assigned_count: 2, reached_in_period_count: 1, engagement_event_count: 4, outstanding_followup_count: 2, overdue_followup_count: 1 }];
    throw new Error("unexpected query");
  };
  const result = await hydrateCommandCenterReportFromProtectedPii(organizationId, commandCenterReport(), { query, env: environment, keyConfig });
  assert.deepEqual(result.organizers[0], {
    handle: "c".repeat(64),
    label: "Synthetic CAT Lead",
    assignedCount: 2,
    reachedInPeriodCount: 1,
    coverageRate: 50,
    engagementEventCount: 4,
    outstandingFollowupCount: 2,
    overdueFollowupCount: 1,
  });
});

test("protected report organizer reads fail closed without a user companion", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("report-read:users")) return [];
    if (sql.includes("engagement-organizers")) return [{ user_id: userId, event_count: 1 }];
    throw new Error("unexpected query");
  };
  await assert.rejects(
    hydrateEngagementReportFromProtectedPii(organizationId, engagementReport(), { query, env: environment, keyConfig }),
    /missing its protected PII companion/i,
  );
});
