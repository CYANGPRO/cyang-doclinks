// src/app/api/cron/scan/route.ts
export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { cronUnauthorizedResponse, isCronAuthorized } from "@/lib/cronAuth";
import { sql } from "@/lib/db";
import { scanR2Object, type MalwareScanVerdict } from "@/lib/malwareScan";
import { logSecurityEvent, detectScanFailureSpike, enforceGlobalApiRateLimit } from "@/lib/securityTelemetry";
import { healScanQueue } from "@/lib/scanQueue";
import { reportException } from "@/lib/observability";
import { logCronRun } from "@/lib/cronTelemetry";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";

type Job = {
  id: string;
  doc_id: string;
  r2_bucket: string;
  r2_key: string;
  attempts: number;
};

type QueuedStaleSummary = {
  queuedStaleCount: number;
  oldestQueuedAgeSeconds: number;
};

type ScanFailureUpdate = {
  attempt: number;
  delayMinutes: number | null;
  deadLettered: boolean;
};

const SCANNER_VERSION = "v4-ovh-clamav-hmac";

async function countQueuedStaleJobs(staleMinutes: number): Promise<QueuedStaleSummary> {
  const staleQueued = (await sql`
    select
      count(*)::int as queued_stale_count,
      coalesce(extract(epoch from (now() - min(created_at))), 0)::int as oldest_queued_age_seconds
    from public.malware_scan_jobs
    where status = 'queued'
      and created_at < now() - (${staleMinutes}::text || ' minutes')::interval
  `) as unknown as Array<{ queued_stale_count: number; oldest_queued_age_seconds: number }>;

  return {
    queuedStaleCount: Number(staleQueued?.[0]?.queued_stale_count ?? 0),
    oldestQueuedAgeSeconds: Number(staleQueued?.[0]?.oldest_queued_age_seconds ?? 0),
  };
}

async function claimQueuedJobs(maxJobs: number): Promise<Job[]> {
  return (await sql`
    with picked as (
      select id, doc_id, r2_bucket, r2_key, attempts
      from public.malware_scan_jobs
      where status = 'queued'
      order by created_at asc
      limit ${maxJobs}
      for update skip locked
    )
    update public.malware_scan_jobs j
      set status = 'running',
          attempts = j.attempts + 1,
          started_at = coalesce(j.started_at, now()),
          scanner_version = ${SCANNER_VERSION}
    from picked p
    where j.id = p.id
    returning j.id::text as id, j.doc_id::text as doc_id, j.r2_bucket::text as r2_bucket, j.r2_key::text as r2_key, j.attempts::int as attempts
  `) as unknown as Job[];
}

async function applyScanVerdict(job: Job, verdict: MalwareScanVerdict): Promise<void> {
  const scanStatus =
    verdict.verdict === "clean" ? "clean" : verdict.verdict === "infected" ? "quarantined" : "quarantined";

  await sql`
    update public.docs
    set
      scan_status = ${scanStatus}::text,
      risk_level = ${verdict.riskLevel}::text,
      risk_flags = ${JSON.stringify({ flags: verdict.flags, meta: verdict.meta ?? null, source: "malware_scan" })}::jsonb,
      moderation_status = case
        when lower(coalesce(moderation_status, 'active')) in ('disabled', 'deleted') then moderation_status
        when ${scanStatus}::text = 'clean' and ${verdict.riskLevel}::text <> 'high' then 'active'
        when ${scanStatus}::text = 'quarantined' or ${verdict.riskLevel}::text = 'high' then 'quarantined'
        else moderation_status
      end
    where id = ${job.doc_id}::uuid
  `;

  await sql`
    update public.malware_scan_jobs
    set
      status = ${verdict.verdict === "infected" ? "infected" : verdict.verdict === "clean" ? "clean" : "skipped"}::text,
      finished_at = now(),
      scanner_version = ${String(verdict.meta?.scannerVersion || verdict.meta?.source || SCANNER_VERSION)},
      sha256 = ${verdict.sha256},
      result = ${JSON.stringify(verdict)}::jsonb,
      last_error = null
    where id = ${job.id}::uuid
  `;
}

async function markScanFailure(args: {
  job: Job;
  errorMessage: string;
  maxAttempts: number;
  retryBaseMinutes: number;
  retryMaxMinutes: number;
}): Promise<ScanFailureUpdate> {
  const attempt = Math.max(1, Number(args.job.attempts || 1));
  const delayMinutes = Math.min(args.retryMaxMinutes, args.retryBaseMinutes * Math.pow(2, Math.max(0, attempt - 1)));
  const deadLettered = attempt >= args.maxAttempts;

  await sql`
    update public.malware_scan_jobs
    set
      status = ${deadLettered ? "dead_letter" : "error"}::text,
      finished_at = now(),
      last_error = ${args.errorMessage},
      next_retry_at = case
        when ${deadLettered} then null
        else now() + (${Math.floor(delayMinutes)}::text || ' minutes')::interval
      end
    where id = ${args.job.id}::uuid
  `;

  if (deadLettered) {
    await sql`
      update public.docs
      set scan_status = case
        when lower(coalesce(moderation_status,'active')) in ('disabled','quarantined','deleted') then scan_status
        else 'error'
      end
      where id = ${args.job.doc_id}::uuid
    `;
  }

  return {
    attempt,
    delayMinutes: deadLettered ? null : Math.floor(delayMinutes),
    deadLettered,
  };
}

export type CronScanRouteDeps = {
  cronUnauthorizedResponse: typeof cronUnauthorizedResponse;
  isCronAuthorized: typeof isCronAuthorized;
  enforceGlobalApiRateLimit: typeof enforceGlobalApiRateLimit;
  getRouteTimeoutMs: typeof getRouteTimeoutMs;
  isRouteTimeoutError: typeof isRouteTimeoutError;
  withRouteTimeout: typeof withRouteTimeout;
  healScanQueue: typeof healScanQueue;
  countQueuedStaleJobs: typeof countQueuedStaleJobs;
  claimQueuedJobs: typeof claimQueuedJobs;
  scanR2Object: typeof scanR2Object;
  applyScanVerdict: typeof applyScanVerdict;
  markScanFailure: typeof markScanFailure;
  logSecurityEvent: typeof logSecurityEvent;
  detectScanFailureSpike: typeof detectScanFailureSpike;
  reportException: typeof reportException;
  logCronRun: typeof logCronRun;
};

const defaultCronScanRouteDeps: CronScanRouteDeps = {
  cronUnauthorizedResponse,
  isCronAuthorized,
  enforceGlobalApiRateLimit,
  getRouteTimeoutMs,
  isRouteTimeoutError,
  withRouteTimeout,
  healScanQueue,
  countQueuedStaleJobs,
  claimQueuedJobs,
  scanR2Object,
  applyScanVerdict,
  markScanFailure,
  logSecurityEvent,
  detectScanFailureSpike,
  reportException,
  logCronRun,
};

export async function getCronScanRoute(req: NextRequest, deps: CronScanRouteDeps = defaultCronScanRouteDeps) {
  const timeoutMs = deps.getRouteTimeoutMs("ROUTE_TIMEOUT_CRON_SCAN_MS", 120_000);
  const rl = await deps.enforceGlobalApiRateLimit({
    req,
    scope: "ip:cron_scan",
    limit: Number(process.env.RATE_LIMIT_CRON_SCAN_PER_MIN || 30),
    windowSeconds: 60,
    strict: true,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "RATE_LIMIT" },
      { status: rl.status, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
    );
  }

  if (!deps.isCronAuthorized(req)) {
    return deps.cronUnauthorizedResponse();
  }

  const startedAt = Date.now();
  try {
    return await deps.withRouteTimeout(
      (async () => {
        const maxJobs = Math.max(1, Math.min(100, Number(process.env.SCAN_CRON_BATCH || 25)));
        const defaultScanMaxBytes = Number(process.env.UPLOAD_ABSOLUTE_MAX_BYTES || 100 * 1024 * 1024);
        const absMaxBytes = Math.max(1024 * 1024, Number(process.env.SCAN_ABS_MAX_BYTES || defaultScanMaxBytes));
        const maxAttempts = Math.max(1, Number(process.env.SCAN_MAX_ATTEMPTS || 5));
        const retryBase = Math.max(1, Number(process.env.SCAN_RETRY_BASE_MINUTES || 5));
        const retryMax = Math.max(retryBase, Number(process.env.SCAN_RETRY_MAX_MINUTES || 720));
        const staleMinutes = Math.max(1, Number(process.env.SCAN_QUEUE_STALE_ALERT_MINUTES || 5));
        const staleCountThreshold = Math.max(1, Number(process.env.SCAN_QUEUE_STALE_ALERT_COUNT || 1));
        const queueHealth = await deps.healScanQueue();

        if (queueHealth.staleDeadLettered > 0) {
          await deps.logSecurityEvent({
            type: "malware_scan_dead_letter",
            severity: "high",
            scope: "scanner",
            message: "Stale running scan jobs moved to dead-letter",
            meta: { count: queueHealth.staleDeadLettered, reason: "stale_running_timeout" },
          });
        }

        if (queueHealth.maxAttemptJobs > 0) {
          await deps.logSecurityEvent({
            type: "malware_scan_dead_letter_backlog",
            severity: "high",
            scope: "scanner",
            message: "Scan jobs reached max attempts and require manual review",
            meta: { count: queueHealth.maxAttemptJobs, maxAttempts },
          });
        }

        const { queuedStaleCount, oldestQueuedAgeSeconds } = await deps.countQueuedStaleJobs(staleMinutes);
        if (queuedStaleCount >= staleCountThreshold) {
          await deps.logSecurityEvent({
            type: "malware_scan_queue_stale",
            severity: "high",
            scope: "scanner",
            message: "Queued scan jobs are older than stale threshold",
            meta: {
              queuedStaleCount,
              oldestQueuedAgeSeconds,
              staleMinutes,
              staleCountThreshold,
            },
          });
        }

        const jobs = await deps.claimQueuedJobs(maxJobs);
        const results: Array<Record<string, unknown>> = [];

        for (const job of jobs) {
          try {
            const verdict = await deps.scanR2Object({
              bucket: job.r2_bucket,
              key: job.r2_key,
              absMaxBytes,
            });

            if (verdict.verdict === "unknown") {
              throw new Error(`SCAN_UNKNOWN_VERDICT:${(verdict.flags || []).join(",")}`);
            }

            await deps.applyScanVerdict(job, verdict);

            if (verdict.riskLevel === "high") {
              await deps.logSecurityEvent({
                type: "malware_scan_high_risk_quarantine",
                severity: "high",
                scope: "scanner",
                docId: job.doc_id,
                message: "Doc auto-quarantined due to high-risk malware scan verdict",
                meta: { jobId: job.id, sha256: verdict.sha256, flags: verdict.flags },
              });
            }

            results.push({ id: job.id, ok: true, verdict: verdict.verdict, riskLevel: verdict.riskLevel });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const failure = await deps.markScanFailure({
              job,
              errorMessage: message,
              maxAttempts,
              retryBaseMinutes: retryBase,
              retryMaxMinutes: retryMax,
            });

            await deps.logSecurityEvent({
              type: "malware_scan_job_failed",
              severity: "high",
              docId: job.doc_id,
              scope: "scanner",
              message: "Malware scan job failed",
              meta: {
                jobId: job.id,
                attempts: failure.attempt,
                error: message,
                retryDelayMinutes: failure.delayMinutes,
                deadLettered: failure.deadLettered,
              },
            });
            if (failure.deadLettered) {
              await deps.logSecurityEvent({
                type: "malware_scan_dead_letter",
                severity: "high",
                docId: job.doc_id,
                scope: "scanner",
                message: "Malware scan job dead-lettered after max retries",
                meta: {
                  jobId: job.id,
                  attempts: failure.attempt,
                  maxAttempts,
                  error: message,
                },
              });
            }
            await deps.detectScanFailureSpike();
            await deps.reportException({
              error,
              event: "malware_scan_job_error",
              context: { jobId: job.id, docId: job.doc_id },
            });

            results.push({ id: job.id, ok: false, error: "SCAN_JOB_FAILED" });
          }
        }

        const duration = Date.now() - startedAt;
        await deps.logCronRun({
          job: "scan",
          ok: true,
          durationMs: duration,
          meta: {
            claimed: jobs.length,
            failed: results.filter((result) => result.ok === false).length,
            deadLetterBacklog: queueHealth.maxAttemptJobs,
            queuedStaleCount,
            oldestQueuedAgeSeconds,
          },
        });

        return NextResponse.json({
          ok: true,
          duration_ms: duration,
          claimed: jobs.length,
          queue_health: queueHealth,
          results,
        });
      })(),
      timeoutMs
    );
  } catch (error: unknown) {
    const duration = Date.now() - startedAt;
    if (deps.isRouteTimeoutError(error)) {
      await deps.logCronRun({
        job: "scan",
        ok: false,
        durationMs: duration,
        meta: { error: "ROUTE_TIMEOUT" },
      });
      return NextResponse.json({ ok: false, error: "TIMEOUT" }, { status: 504 });
    }

    const message = error instanceof Error ? error.message : String(error);
    await deps.logCronRun({
      job: "scan",
      ok: false,
      durationMs: duration,
      meta: { error: message },
    });
    return NextResponse.json({ ok: false, error: "CRON_SCAN_FAILED" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return getCronScanRoute(req);
}
