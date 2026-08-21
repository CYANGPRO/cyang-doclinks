import { expect, test } from "@playwright/test";
import {
  buildDependencySummary,
  classifyBackupRecoverySummary,
  summarizeHealthChecks,
  toExternalHealthSummary,
  type HealthCheck,
} from "../src/lib/health";

test.describe("health readiness aggregation", () => {
  test("fails readiness when a critical dependency is down", () => {
    const checks: HealthCheck[] = [
      { name: "config", state: "ok", critical: true, summary: "ok" },
      { name: "database", state: "down", critical: true, summary: "down" },
      { name: "backup_recovery", state: "degraded", critical: false, summary: "warn" },
    ];

    const summary = summarizeHealthChecks(checks);
    expect(summary.ok).toBeFalsy();
    expect(summary.status).toBe("down");
    expect(summary.httpStatus).toBe(503);
  });

  test("keeps readiness passing when only non-critical checks are degraded", () => {
    const checks: HealthCheck[] = [
      { name: "config", state: "ok", critical: true, summary: "ok" },
      { name: "database", state: "ok", critical: true, summary: "ok" },
      { name: "storage", state: "ok", critical: true, summary: "ok" },
      { name: "backup_recovery", state: "degraded", critical: false, summary: "warn" },
    ];

    const summary = summarizeHealthChecks(checks);
    expect(summary.ok).toBeTruthy();
    expect(summary.status).toBe("ok");
    expect(summary.httpStatus).toBe(200);
  });

  test("ignores disabled checks when computing readiness", () => {
    const checks: HealthCheck[] = [
      { name: "config", state: "ok", critical: true, summary: "ok" },
      { name: "database", state: "ok", critical: true, summary: "ok" },
      { name: "backup_recovery", state: "disabled", critical: false, summary: "disabled" },
    ];

    const summary = summarizeHealthChecks(checks);
    expect(summary.ok).toBeTruthy();
    expect(summary.status).toBe("ok");
  });

  test("keeps backup recovery healthy when the latest attempt failed but a recent success is still fresh", () => {
    const result = classifyBackupRecoverySummary({
      enabled: true,
      tablesReady: true,
      lastStatus: "failed",
      maxAgeHours: 30,
      recoveryDrillDays: 30,
      hoursSinceLastSuccess: 4,
      freshnessOk: true,
      recoveryDrillDue: false,
    });

    expect(result.state).toBe("ok");
    expect(result.summary).toContain("latest attempt failed");
  });

  test("keeps backup recovery degraded when restore drill cadence is overdue", () => {
    const result = classifyBackupRecoverySummary({
      enabled: true,
      tablesReady: true,
      lastStatus: "ok",
      maxAgeHours: 30,
      recoveryDrillDays: 30,
      hoursSinceLastSuccess: 4,
      freshnessOk: true,
      recoveryDrillDue: true,
    });

    expect(result.state).toBe("degraded");
    expect(result.summary).toContain("restore drill cadence");
  });

  test("sanitizes external health summaries so raw details are not exposed", () => {
    const summary = toExternalHealthSummary({
      ok: false,
      service: "cyang.io",
      ts: Date.now(),
      status: "degraded",
      checks: [
        {
          name: "database",
          state: "down",
          critical: true,
          summary: "Database dependency is unavailable.",
          details: {
            latencyMs: 17,
            error: 'column "enc_key_version" does not exist',
            table: "public.docs",
          },
        },
      ],
      config: {
        environment: "production",
        status: "fail",
        errorCount: 2,
        warningCount: 1,
      },
    });

    expect(summary.summary.length).toBeGreaterThan(0);
    expect("checks" in summary).toBeFalsy();
    expect("config" in summary).toBeFalsy();
    expect(JSON.stringify(summary)).not.toContain("enc_key_version");
    expect(JSON.stringify(summary)).not.toContain("public.docs");
    expect(JSON.stringify(summary)).not.toContain("database");
  });

  test("builds dependency summaries from injectable probes so local verification can simulate failures safely", async () => {
    const summary = await buildDependencySummary({
      auditRuntimeConfig: () => ({
        ok: false,
        environment: "development",
        status: "warn",
        errorCount: 0,
        warningCount: 1,
        findings: [],
      }),
      probeDatabase: async () => ({
        name: "database",
        state: "down",
        critical: true,
        summary: "Database dependency is unavailable.",
        details: { reason: 'column "enc_key_version" does not exist' },
      }),
      probeStorage: async () => ({
        name: "storage",
        state: "ok",
        critical: true,
        summary: "Object storage reachable.",
      }),
      probeMalwareScannerConfig: async () => ({
        name: "malware_scanner",
        state: "ok",
        critical: true,
        summary: "Malware scanner endpoint and HMAC configuration are present.",
      }),
      probeScanQueue: async () => ({
        name: "scan_queue",
        state: "degraded",
        critical: true,
        summary: "Malware scanning is reachable but has backlog or failure signals.",
      }),
      probeBackupRecovery: async () => ({
        name: "backup_recovery",
        state: "ok",
        critical: false,
        summary: "Backups and restore drill cadence are within policy.",
      }),
      probeKeyRotation: async () => ({
        name: "key_rotation",
        state: "ok",
        critical: false,
        summary: "Key rotation queue is healthy.",
      }),
    });

    expect(summary.status).toBe("down");
    expect(summary.checks.some((check) => check.name === "database" && check.state === "down")).toBeTruthy();
    expect(JSON.stringify(toExternalHealthSummary(summary))).not.toContain("enc_key_version");
  });
});
