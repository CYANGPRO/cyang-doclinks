import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { sql } from "@/lib/db";
import { getR2Bucket, getR2Prefix, r2Client } from "@/lib/r2";
import { auditRuntimeConfig, type ConfigAuditReport } from "@/lib/configAudit";
import { getBackupRecoveryStatusSummary, type BackupRecoveryStatusSummary } from "@/lib/backupRecovery";
import { getKeyRotationStatusSummary } from "@/lib/keyRotationJobs";
import { malwareScannerConfigurationSummary } from "@/lib/malwareScannerConfig";

export type HealthState = "ok" | "degraded" | "down" | "disabled";
export type HealthCheck = {
  name: string;
  state: HealthState;
  critical: boolean;
  summary: string;
  details?: Record<string, unknown>;
};

export type HealthSummary = {
  ok: boolean;
  service: string;
  ts: number;
  status: "ok" | "degraded" | "down";
  checks: HealthCheck[];
  config: {
    environment: ConfigAuditReport["environment"];
    status: ConfigAuditReport["status"];
    errorCount: number;
    warningCount: number;
  };
};

export type ExternalHealthSummary = {
  ok: boolean;
  service: string;
  ts: number;
  status: "ok" | "degraded" | "down";
  summary: string;
};

export type PublicHealthSnapshot = {
  ok: boolean;
  service: string;
  ts: number;
  status?: "ok" | "degraded" | "down";
  error?: string;
};

export type HealthDependencySummaryDeps = {
  auditRuntimeConfig: typeof auditRuntimeConfig;
  probeDatabase: () => Promise<HealthCheck>;
  probeStorage: () => Promise<HealthCheck>;
  probeMalwareScannerConfig: () => Promise<HealthCheck>;
  probeScanQueue: () => Promise<HealthCheck>;
  probeBackupRecovery: () => Promise<HealthCheck>;
  probeKeyRotation: () => Promise<HealthCheck>;
};

type DependencyHealthCacheEntry = {
  expiresAt: number;
  summary: HealthSummary;
};

function worstState(states: readonly HealthState[]): "ok" | "degraded" | "down" {
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  return "ok";
}

export function summarizeHealthChecks(checks: readonly HealthCheck[]): {
  ok: boolean;
  status: "ok" | "degraded" | "down";
  httpStatus: number;
} {
  const criticalStates = checks.filter((check) => check.critical).map((check) => check.state);
  const nonDisabledStates = checks
    .filter((check) => check.state !== "disabled")
    .map((check) => check.state);
  const status = worstState(criticalStates.length ? criticalStates : nonDisabledStates);
  return {
    ok: status === "ok",
    status,
    httpStatus: status === "down" ? 503 : 200,
  };
}

function toLatencyDetails(startedAt: number, details?: Record<string, unknown>) {
  return {
    latencyMs: Math.max(1, Date.now() - startedAt),
    ...(details || {}),
  };
}

function failureDetails(startedAt: number, reason: string) {
  return toLatencyDetails(startedAt, { reason });
}

function externalSummaryText(status: HealthSummary["status"]) {
  if (status === "ok") return "Core service readiness is operating normally.";
  if (status === "degraded") return "Core service readiness is degraded.";
  return "Core service readiness is unavailable.";
}

export function toExternalHealthSummary(summary: HealthSummary): ExternalHealthSummary {
  return {
    ok: summary.ok,
    service: summary.service,
    ts: summary.ts,
    status: summary.status,
    summary: externalSummaryText(summary.status),
  };
}

export function classifyBackupRecoverySummary(summary: BackupRecoveryStatusSummary): {
  state: Exclude<HealthState, "down">;
  summary: string;
} {
  if (!summary.enabled) {
    return {
      state: "disabled",
      summary: "Backup automation is not enabled.",
    };
  }

  if (!summary.tablesReady || summary.lastStatus === "missing") {
    return {
      state: "degraded",
      summary: "Backup status tables are not ready or have not received backup status yet.",
    };
  }

  if (!summary.freshnessOk) {
    return {
      state: "degraded",
      summary: "Backup freshness requires attention.",
    };
  }

  if (summary.recoveryDrillDue) {
    return {
      state: "degraded",
      summary: "Backups are current, but restore drill cadence requires attention.",
    };
  }

  return {
    state: "ok",
    summary:
      summary.lastStatus === "failed"
        ? "Backups are within policy; the latest attempt failed but the most recent successful backup is still fresh."
        : "Backups and restore drill cadence are within policy.",
  };
}

async function probeDatabase(): Promise<HealthCheck> {
  const startedAt = Date.now();
  try {
    const rows = (await sql`
      select
        1 as ok,
        to_regclass('public.schema_migrations')::text as schema_migrations,
        to_regclass('public.docs')::text as docs,
        to_regclass('public.users')::text as users
    `) as Array<{
      ok: number;
      schema_migrations: string | null;
      docs: string | null;
      users: string | null;
    }>;
    const row = rows[0];
    if (!row || row.ok !== 1) {
      return {
        name: "database",
        state: "down",
        critical: true,
        summary: "Database ping failed.",
      };
    }
    return {
      name: "database",
      state: row.docs && row.users ? "ok" : "degraded",
      critical: true,
      summary: row.docs && row.users ? "Database reachable." : "Database reachable, but core tables are incomplete.",
      details: toLatencyDetails(startedAt, {
        schemaMigrationsReady: Boolean(row.schema_migrations),
        docsTableReady: Boolean(row.docs),
        usersTableReady: Boolean(row.users),
      }),
    };
  } catch {
    return {
      name: "database",
      state: "down",
      critical: true,
      summary: "Database dependency is unavailable.",
      details: failureDetails(startedAt, "db_error"),
    };
  }
}

async function probeStorage(): Promise<HealthCheck> {
  const startedAt = Date.now();
  try {
    const bucket = getR2Bucket();
    const prefix = getR2Prefix();
    await r2Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1,
      })
    );
    return {
      name: "storage",
      state: "ok",
      critical: true,
      summary: "Object storage reachable.",
      details: toLatencyDetails(startedAt),
    };
  } catch {
    return {
      name: "storage",
      state: "down",
      critical: true,
      summary: "Object storage dependency is unavailable.",
      details: failureDetails(startedAt, "storage_error"),
    };
  }
}

async function probeMalwareScannerConfig(): Promise<HealthCheck> {
  const summary = malwareScannerConfigurationSummary();
  if (!summary.configured) {
    return {
      name: "malware_scanner",
      state: "down",
      critical: true,
      summary: "Malware scanner authentication or endpoint configuration is unavailable.",
      details: { configurationState: summary.state, reason: summary.reason },
    };
  }
  return {
    name: "malware_scanner",
    state: "ok",
    critical: true,
    summary: "Malware scanner endpoint and HMAC configuration are present.",
    details: {
      endpointHost: summary.endpointHost,
      endpointPath: summary.endpointPath,
      authMode: summary.authMode,
    },
  };
}

async function probeScanQueue(): Promise<HealthCheck> {
  const startedAt = Date.now();
  const staleMinutesThreshold = Math.max(1, Number(process.env.SCAN_PENDING_DELAY_THRESHOLD || 25));
  const runningTimeoutMinutes = Math.max(1, Number(process.env.SCAN_RUNNING_TIMEOUT_MINUTES || 20));

  try {
    const tableRows = (await sql`
      select to_regclass('public.malware_scan_jobs')::text as reg
    `) as Array<{ reg: string | null }>;
    if (!tableRows[0]?.reg) {
      return {
        name: "scan_queue",
        state: "down",
        critical: true,
        summary: "Malware scan queue schema is missing.",
        details: failureDetails(startedAt, "scan_queue_schema_missing"),
      };
    }

    const rows = (await sql`
      select
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'error')::int as errored,
        count(*) filter (where status = 'dead_letter')::int as dead_letter,
        coalesce(
          max(extract(epoch from (now() - created_at)) / 60.0)
            filter (where status = 'queued'),
          0
        ) as oldest_queued_minutes,
        coalesce(
          max(extract(epoch from (now() - started_at)) / 60.0)
            filter (where status = 'running' and started_at is not null),
          0
        ) as oldest_running_minutes
      from public.malware_scan_jobs
    `) as Array<{
      queued: number;
      running: number;
      errored: number;
      dead_letter: number;
      oldest_queued_minutes: number | string;
      oldest_running_minutes: number | string;
    }>;

    const row = rows[0];
    const oldestQueued = Number(row?.oldest_queued_minutes || 0);
    const oldestRunning = Number(row?.oldest_running_minutes || 0);
    const degraded =
      Number(row?.errored || 0) > 0 ||
      Number(row?.dead_letter || 0) > 0 ||
      oldestQueued >= staleMinutesThreshold ||
      oldestRunning >= runningTimeoutMinutes;

    return {
      name: "scan_queue",
      state: degraded ? "degraded" : "ok",
      critical: true,
      summary: degraded
        ? "Malware scanning is reachable but has backlog or failure signals."
        : "Malware scanning queue is healthy.",
      details: toLatencyDetails(startedAt, {
        queued: Number(row?.queued || 0),
        running: Number(row?.running || 0),
        errored: Number(row?.errored || 0),
        deadLetter: Number(row?.dead_letter || 0),
        oldestQueuedMinutes: oldestQueued,
        oldestRunningMinutes: oldestRunning,
        staleMinutesThreshold,
        runningTimeoutMinutes,
      }),
    };
  } catch {
    return {
      name: "scan_queue",
      state: "down",
      critical: true,
      summary: "Malware scan queue health could not be determined.",
      details: failureDetails(startedAt, "scan_queue_error"),
    };
  }
}

async function probeBackupRecovery(): Promise<HealthCheck> {
  const startedAt = Date.now();
  try {
    const summary = await getBackupRecoveryStatusSummary();
    const classified = classifyBackupRecoverySummary(summary);

    return {
      name: "backup_recovery",
      state: classified.state,
      critical: false,
      summary: classified.summary,
      details: toLatencyDetails(startedAt, {
        lastStatus: summary.lastStatus,
        hoursSinceLastSuccess: summary.hoursSinceLastSuccess,
        freshnessOk: summary.freshnessOk,
        maxAgeHours: summary.maxAgeHours,
        recoveryDrillDays: summary.recoveryDrillDays,
        recoveryDrillDue: summary.recoveryDrillDue,
      }),
    };
  } catch {
    return {
      name: "backup_recovery",
      state: "degraded",
      critical: false,
      summary: "Backup health summary is unavailable.",
      details: failureDetails(startedAt, "backup_error"),
    };
  }
}

async function probeKeyRotation(): Promise<HealthCheck> {
  const startedAt = Date.now();
  try {
    const summary = await getKeyRotationStatusSummary();
    return {
      name: "key_rotation",
      state: summary.failed > 0 ? "degraded" : "ok",
      critical: false,
      summary:
        summary.failed > 0
          ? "Key rotation jobs have failed items that need operator review."
          : "Key rotation queue is healthy.",
      details: toLatencyDetails(startedAt, {
        queued: summary.queued,
        running: summary.running,
        failed: summary.failed,
      }),
    };
  } catch {
    return {
      name: "key_rotation",
      state: "degraded",
      critical: false,
      summary: "Key rotation summary is unavailable.",
      details: failureDetails(startedAt, "key_rotation_error"),
    };
  }
}

function configCheckFromAudit(report: ConfigAuditReport): HealthCheck {
  const detail = {
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    environment: report.environment,
    findings: report.findings.slice(0, 6).map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      field: finding.field,
      message: finding.message,
    })),
  };
  if (report.errorCount > 0) {
    return {
      name: "config",
      state: "down",
      critical: true,
      summary: "Critical configuration validation failed.",
      details: detail,
    };
  }
  if (report.warningCount > 0) {
    return {
      name: "config",
      state: "degraded",
      critical: true,
      summary: "Configuration warnings are present.",
      details: detail,
    };
  }
  return {
    name: "config",
    state: "ok",
    critical: true,
    summary: "Configuration validation passed.",
    details: detail,
  };
}

const defaultHealthDependencySummaryDeps: HealthDependencySummaryDeps = {
  auditRuntimeConfig,
  probeDatabase,
  probeStorage,
  probeMalwareScannerConfig,
  probeScanQueue,
  probeBackupRecovery,
  probeKeyRotation,
};

export function buildLivenessSummary(
  deps: Pick<HealthDependencySummaryDeps, "auditRuntimeConfig"> = defaultHealthDependencySummaryDeps
): HealthSummary {
  const config = deps.auditRuntimeConfig();
  return {
    ok: true,
    service: "cyang.io",
    ts: Date.now(),
    status: "ok",
    checks: [
      {
        name: "process",
        state: "ok",
        critical: true,
        summary: "Application process is running.",
        details: {
          uptimeSeconds: Math.floor(process.uptime()),
          buildSha: String(process.env.NEXT_PUBLIC_BUILD_SHA || "").trim() || null,
        },
      },
    ],
    config: {
      environment: config.environment,
      status: config.status,
      errorCount: config.errorCount,
      warningCount: config.warningCount,
    },
  };
}

async function buildDependencyChecks(
  deps: HealthDependencySummaryDeps = defaultHealthDependencySummaryDeps
): Promise<{ config: ConfigAuditReport; checks: HealthCheck[] }> {
  const config = deps.auditRuntimeConfig();
  const checks = await Promise.all([
    deps.probeDatabase(),
    deps.probeStorage(),
    deps.probeMalwareScannerConfig(),
    deps.probeScanQueue(),
    deps.probeBackupRecovery(),
    deps.probeKeyRotation(),
  ]);
  checks.unshift(configCheckFromAudit(config));
  return { config, checks };
}

export async function buildDependencySummary(
  deps: HealthDependencySummaryDeps = defaultHealthDependencySummaryDeps
): Promise<HealthSummary> {
  const { config, checks } = await buildDependencyChecks(deps);
  const summary = summarizeHealthChecks(checks);
  return {
    ok: summary.ok,
    service: "cyang.io",
    ts: Date.now(),
    status: summary.status,
    checks,
    config: {
      environment: config.environment,
      status: config.status,
      errorCount: config.errorCount,
      warningCount: config.warningCount,
    },
  };
}

let dependencyHealthCache: DependencyHealthCacheEntry | null = null;
let dependencyHealthInFlight: Promise<HealthSummary> | null = null;

function getDependencyHealthCacheMs() {
  const raw = Number(process.env.HEALTH_SUMMARY_CACHE_MS || 30_000);
  if (!Number.isFinite(raw)) return 30_000;
  return Math.max(5_000, Math.min(2 * 60_000, Math.floor(raw)));
}

export async function getCachedDependencySummary(): Promise<HealthSummary> {
  const useCache = defaultHealthDependencySummaryDeps;
  const now = Date.now();
  if (dependencyHealthCache && dependencyHealthCache.expiresAt > now) {
    return dependencyHealthCache.summary;
  }

  if (!dependencyHealthInFlight) {
    dependencyHealthInFlight = buildDependencySummary(useCache)
      .then((summary) => {
        dependencyHealthCache = {
          summary,
          expiresAt: Date.now() + getDependencyHealthCacheMs(),
        };
        return summary;
      })
      .finally(() => {
        dependencyHealthInFlight = null;
      });
  }

  try {
    return await dependencyHealthInFlight;
  } catch (error) {
    if (dependencyHealthCache) {
      return dependencyHealthCache.summary;
    }
    throw error;
  }
}

type PublicHealthCacheEntry = {
  expiresAt: number;
  snapshot: PublicHealthSnapshot;
};

let publicHealthCache: PublicHealthCacheEntry | null = null;
let publicHealthInFlight: Promise<PublicHealthSnapshot> | null = null;

function getPublicHealthCacheMs() {
  const raw = Number(process.env.STATUS_PUBLIC_HEALTH_CACHE_MS || 300_000);
  if (!Number.isFinite(raw)) return 300_000;
  return Math.max(15_000, Math.min(10 * 60_000, Math.floor(raw)));
}

export async function getCachedPublicHealthSnapshot(): Promise<PublicHealthSnapshot> {
  const now = Date.now();
  if (publicHealthCache && publicHealthCache.expiresAt > now) {
    return publicHealthCache.snapshot;
  }

  if (publicHealthInFlight) {
    return publicHealthInFlight;
  }

  publicHealthInFlight = (async () => {
    try {
      const summary = await getCachedDependencySummary();
      const snapshot: PublicHealthSnapshot = {
        ok: summary.ok,
        service: summary.service,
        ts: summary.ts,
        status: summary.status,
      };
      publicHealthCache = {
        snapshot,
        expiresAt: Date.now() + getPublicHealthCacheMs(),
      };
      return snapshot;
    } catch {
      if (publicHealthCache) {
        return publicHealthCache.snapshot;
      }
      return {
        ok: false,
        service: "cyang.io",
        ts: Date.now(),
        error: "SERVER_ERROR",
      };
    } finally {
      publicHealthInFlight = null;
    }
  })();

  return publicHealthInFlight;
}
