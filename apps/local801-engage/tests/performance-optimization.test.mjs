import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getDashboardMetrics } from "../src/lib/metrics.ts";
import {
  __testing,
  databaseOperation,
  measureDatabaseQuery,
  slowQueryThreshold,
} from "../src/lib/performance-timing.ts";

const context = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  organizationSlug: "local801",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "system_owner",
};

test("performance timing uses bounded non-PII operation labels", async () => {
  assert.equal(databaseOperation("/* reports:membership-overview */ SELECT 1"), "reports:membership-overview");
  assert.equal(databaseOperation("SELECT 'person@example.test'"), "unlabeled");
  assert.equal(__testing.safeOperation("PAGE.REPORTS.Overview"), "page.reports.overview");
  assert.equal(__testing.safeOperation("person@example.test"), "unlabeled");
  assert.equal(slowQueryThreshold({ LOCAL801_SLOW_QUERY_MS: "1" }), 25);
  assert.equal(slowQueryThreshold({ LOCAL801_SLOW_QUERY_MS: "99999" }), 5_000);
  assert.equal(__testing.enabled({ VERCEL_ENV: "production" }), true);
  assert.equal(__testing.enabled({ VERCEL_ENV: "production", LOCAL801_PERFORMANCE_TIMING_ENABLED: "0" }), false);

  const previous = {
    timing: process.env.LOCAL801_PERFORMANCE_TIMING_ENABLED,
    vercel: process.env.VERCEL_ENV,
  };
  process.env.LOCAL801_PERFORMANCE_TIMING_ENABLED = "1";
  process.env.VERCEL_ENV = "production";
  const messages = [];
  const originalInfo = console.info;
  console.info = (...values) => messages.push(values.join(" "));
  try {
    await assert.rejects(
      measureDatabaseQuery("/* reports:safe */ SELECT $1", async () => {
        throw new Error("person@example.test");
      }),
      /person@example\.test/,
    );
  } finally {
    console.info = originalInfo;
    if (previous.timing === undefined) delete process.env.LOCAL801_PERFORMANCE_TIMING_ENABLED;
    else process.env.LOCAL801_PERFORMANCE_TIMING_ENABLED = previous.timing;
    if (previous.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous.vercel;
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /reports:safe/);
  assert.doesNotMatch(messages[0], /person@example\.test|SELECT|\$1/);
});

test("dashboard aggregation scans each repeated source once", async () => {
  let capturedSql = "";
  const result = await getDashboardMetrics(context, async (sql) => {
    capturedSql = sql;
    return [{
      organization_exists: true,
      represented: "787",
      members: "522",
      open_assignments: "4",
      assigned_attention_90: "2",
      new_hires_this_month: "3",
      new_hires_awaiting_first_engagement_14: "1",
      additions_this_month: "5",
      drops_this_month: "2",
      recent_membership_changes_7_days: "3",
      overdue_followups: "1",
      followups_due_today: "2",
      upcoming_followups: "4",
      imports_in_review: "0",
      active_campaigns: "2",
      open_cat_actions: "1",
    }];
  });
  assert.equal(result.source, "database");
  assert.match(capturedSql, /\/\* dashboard:summary \*\//);
  assert.equal((capturedSql.match(/FROM reporting\.current_membership/g) ?? []).length, 1);
  assert.equal((capturedSql.match(/FROM local801\.membership_events/g) ?? []).length, 1);
  assert.equal((capturedSql.match(/FROM local801\.engagement_followups/g) ?? []).length, 1);
  assert.match(capturedSql, /count\(\*\) FILTER/);
});

test("Speed Insights is mounted and native-only SDKs are deferred from the initial client bundle", async () => {
  const [layout, runtime, notifications] = await Promise.all([
    readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/NativeRuntime.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/NativeNotificationRouter.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /@vercel\/speed-insights\/next/);
  assert.match(layout, /<SpeedInsights \/>/);
  assert.doesNotMatch(runtime, /^import .*@capacitor/m);
  assert.match(runtime, /window as Window & \{ Capacitor\?/);
  assert.doesNotMatch(runtime, /import\("@capacitor\/core"\)/);
  assert.doesNotMatch(notifications, /^import .*@capacitor/m);
  assert.doesNotMatch(notifications, /import\("@capacitor\/core"\)/);
  assert.match(notifications, /import\("@capacitor\/local-notifications"\)/);
});
