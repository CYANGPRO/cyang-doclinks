import { expect } from "@playwright/test";
import { NextRequest, NextResponse } from "next/server";
import type { UploadPresignRouteDeps } from "../../../src/app/api/admin/upload/presign/route";
import type { UploadCompleteRouteDeps } from "../../../src/app/api/admin/upload/complete/route";
import type { ServeRouteDeps } from "../../../src/app/serve/[docId]/route";
import type { CronScanRouteDeps } from "../../../src/app/api/cron/scan/route";

export type UploadRuntimeDocState = {
  id: string;
  ownerId: string;
  orgId: string | null;
  title: string;
  originalFilename: string;
  contentType: string;
  r2Bucket: string;
  r2Key: string;
  sizeBytes: number;
  encryptionEnabled: boolean;
  status: string;
  scanStatus: string;
  moderationStatus: string;
  riskLevel: string;
  riskFlags: Record<string, unknown> | null;
};

type StoredObject = {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
};

type ScanJobState = {
  id: string;
  docId: string;
  bucket: string;
  key: string;
  attempts: number;
  status: "queued" | "running" | "clean" | "infected" | "error" | "dead_letter";
  lastError: string | null;
};

type ScannerOutcome = "clean" | "infected" | "unknown" | "unavailable";

function asyncBuffer(body: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function objectMapKey(bucket: string, key: string) {
  return `${bucket}:${key}`;
}

function jsonError(error: string, status: number, extra?: { message?: string; headers?: HeadersInit }) {
  return NextResponse.json(
    {
      ok: false as const,
      error,
      ...(extra?.message ? { message: extra.message } : {}),
    },
    { status, headers: extra?.headers }
  );
}

function buildSqlForUpload(state: {
  docs: Map<string, UploadRuntimeDocState>;
  aliases: string[];
  configuredBucket: string;
}) {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");

    if (text.includes("insert into docs (")) {
      const docId = String(values[0]);
      const orgId = values[1] ? String(values[1]) : null;
      const ownerId = String(values[2]);
      const title = String(values[3]);
      const originalFilename = String(values[4]);
      const contentType = String(values[5]);
      const sizeBytes = Number(values[6] ?? 0);
      const r2Bucket = String(values[7] || state.configuredBucket);
      const r2Key = String(values[8]);

      state.docs.set(docId, {
        id: docId,
        ownerId,
        orgId,
        title,
        originalFilename,
        contentType,
        sizeBytes,
        r2Bucket,
        r2Key,
        encryptionEnabled: true,
        status: "uploading",
        scanStatus: "pending",
        moderationStatus: "active",
        riskLevel: "low",
        riskFlags: null,
      });
      return [];
    }

    if (text.includes("from public.docs") && text.includes("where r2_bucket =")) {
      const bucket = String(values[0]);
      const key = String(values[1]);
      const doc = Array.from(state.docs.values()).find((candidate) => candidate.r2Bucket === bucket && candidate.r2Key === key);
      return doc ? [{ id: doc.id }] : [];
    }

    if (text.includes("coalesce(original_filename, title, '')::text as name")) {
      const docId = String(values[0]);
      const doc = state.docs.get(docId);
      return doc
        ? [
            {
              id: doc.id,
              name: doc.originalFilename,
              content_type: doc.contentType,
              r2_bucket: doc.r2Bucket,
              r2_key: doc.r2Key,
            },
          ]
        : [];
    }

    if (text.includes("set status = 'uploading'")) {
      const docId = String(values[0]);
      const doc = state.docs.get(docId);
      if (doc) doc.status = "uploading";
      return [];
    }

    if (text.includes("size_bytes::bigint as size_bytes") && text.includes("encryption_enabled::boolean")) {
      const docId = String(values[0]);
      const doc = state.docs.get(docId);
      return doc
        ? [
            {
              size_bytes: doc.sizeBytes,
              encryption_enabled: doc.encryptionEnabled,
            },
          ]
        : [];
    }

    if (text.includes("set\n        title = coalesce(") || text.includes("set\r\n        title = coalesce(")) {
      const docId = String(values[13]);
      const doc = state.docs.get(docId);
      if (!doc) return [];
      doc.title = String(values[0] ?? doc.title);
      doc.originalFilename = String(values[1] ?? doc.originalFilename);
      doc.contentType = String(values[2] ?? doc.contentType);
      doc.status = "ready";
      doc.scanStatus = String(values[3] ?? doc.scanStatus);
      doc.riskLevel = String(values[4] ?? doc.riskLevel);
      doc.riskFlags = (values[5] as Record<string, unknown>) ?? doc.riskFlags;
      doc.moderationStatus = doc.riskLevel === "high" ? "quarantined" : "active";
      return [
        {
          doc_state: doc.status,
          scan_state: doc.scanStatus,
          moderation_status: doc.moderationStatus,
        },
      ];
    }

    if (text.includes("select owner_id::text as owner_id")) {
      const docId = String(values[0]);
      const doc = state.docs.get(docId);
      return doc
        ? [
            {
              owner_id: doc.ownerId,
              org_id: doc.orgId,
              size_bytes: doc.sizeBytes,
            },
          ]
        : [];
    }

    if (text.includes("insert into public.doc_aliases")) {
      const alias = String(values[0]);
      state.aliases.push(alias);
      return [];
    }

    throw new Error(`Unhandled upload SQL: ${text}`);
  }) as UploadCompleteRouteDeps["sql"] & UploadPresignRouteDeps["sql"];
}

export function createUploadRuntimeHarness(overrides?: Partial<UploadRuntimeDocState>) {
  const configuredBucket = "docs-bucket";
  const docs = new Map<string, UploadRuntimeDocState>();
  const objects = new Map<string, StoredObject>();
  const scanJobs = new Map<string, ScanJobState>();
  const aliases: string[] = [];
  const deletedKeys: string[] = [];
  const mintedTickets: string[] = [];
  const queuedScans: Array<{ docId: string; bucket: string; key: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const securityLogs: Array<Record<string, unknown>> = [];
  const cronRuns: Array<Record<string, unknown>> = [];
  const exceptions: Array<Record<string, unknown>> = [];
  const scannerOutcomes = new Map<string, ScannerOutcome>();
  let nextJobId = 1;

  const sql = buildSqlForUpload({ docs, aliases, configuredBucket });

  function getDoc(docId: string) {
    const doc = docs.get(docId);
    expect(doc, `Expected doc ${docId} to exist in upload runtime harness`).toBeTruthy();
    return doc as UploadRuntimeDocState;
  }

  function seedDoc(doc: UploadRuntimeDocState) {
    docs.set(doc.id, { ...doc });
  }

  if (overrides?.id) {
    seedDoc({
      id: overrides.id,
      ownerId: overrides.ownerId ?? "owner-1",
      orgId: overrides.orgId ?? null,
      title: overrides.title ?? "Quarterly Report",
      originalFilename: overrides.originalFilename ?? "report.pdf",
      contentType: overrides.contentType ?? "application/pdf",
      r2Bucket: overrides.r2Bucket ?? configuredBucket,
      r2Key: overrides.r2Key ?? `docs/${overrides.id}_report.pdf`,
      sizeBytes: overrides.sizeBytes ?? Buffer.from("%PDF-1.7\nok").byteLength,
      encryptionEnabled: overrides.encryptionEnabled ?? true,
      status: overrides.status ?? "uploading",
      scanStatus: overrides.scanStatus ?? "pending",
      moderationStatus: overrides.moderationStatus ?? "active",
      riskLevel: overrides.riskLevel ?? "low",
      riskFlags: overrides.riskFlags ?? null,
    });
  }

  function seedUploadedObject(docId: string, body = Buffer.from("%PDF-1.7\nok")) {
    const doc = getDoc(docId);
    doc.sizeBytes = body.byteLength;
    objects.set(objectMapKey(doc.r2Bucket, doc.r2Key), {
      bucket: doc.r2Bucket,
      key: doc.r2Key,
      body,
      contentType: doc.contentType,
      metadata: {
        "doc-id": doc.id,
        "orig-content-type": doc.contentType,
        "orig-ext": ".pdf",
      },
    });
  }

  function setScannerOutcome(docId: string, outcome: ScannerOutcome) {
    const doc = getDoc(docId);
    scannerOutcomes.set(objectMapKey(doc.r2Bucket, doc.r2Key), outcome);
  }

  function buildUploadPresignDeps(): UploadPresignRouteDeps {
    const deps = {
      sql,
      getR2Bucket: () => configuredBucket,
      r2Client: {} as UploadPresignRouteDeps["r2Client"],
      requireUser: async () => ({
        id: "owner-1",
        orgId: null,
        orgSlug: null,
        email: "owner@example.com",
        role: "admin",
      }),
      assertCanUpload: async () => ({ ok: true }),
      getPlanForUser: async () => ({ id: "pro" } as { id: string }),
      enforcePlanLimitsEnabled: () => true,
      enforceGlobalApiRateLimit: async () => ({ ok: true, status: 200, retryAfterSeconds: 0 }),
      clientIpKey: () => ({ ip: "203.0.113.10", ipHash: "iphash" }),
      detectPresignFailureSpike: async () => {},
      enforceIpAbuseBlock: async () => ({ ok: true, retryAfterSeconds: 0 }),
      logSecurityEvent: async (entry: unknown) => {
        securityLogs.push(entry as Record<string, unknown>);
      },
      maybeBlockIpOnAbuse: async () => {},
      getActiveMasterKeyOrThrow: async () => ({ id: "mk-1", key: Buffer.alloc(32, 7) }),
      appendImmutableAudit: async (entry: unknown) => {
        audits.push(entry as Record<string, unknown>);
      },
      reportException: async () => {},
      validateUploadType: ({ filename, declaredMime }: { filename: string; declaredMime?: string | null }) => ({
        ok: true,
        canonicalMime: declaredMime || "application/pdf",
        ext: filename.toLowerCase().endsWith(".pdf") ? ".pdf" : ".bin",
        family: "document",
      }),
      getRouteTimeoutMs: () => 20_000,
      isRouteTimeoutError: ((_: unknown): _ is never => false),
      withRouteTimeout: async <T>(work: Promise<T>) => work,
      assertRuntimeEnv: () => {},
      isRuntimeEnvError: ((_: unknown): _ is never => false),
      withRequestTelemetry: async <T>(_req: Request, fn: () => Promise<T>) => fn(),
      getSignedUrl: async (
        _client: UploadPresignRouteDeps["r2Client"],
        _command: unknown,
        { expiresIn }: { expiresIn: number }
      ) => `https://upload.example.test/presigned?expiresIn=${expiresIn}`,
    };
    return deps as unknown as UploadPresignRouteDeps;
  }

  function buildUploadCompleteDeps(): UploadCompleteRouteDeps {
    const deps = {
      validatePdfBuffer: () => ({ ok: true, riskLevel: "low", flags: [], details: undefined }),
      sql,
      slugify: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      requireDocWrite: async () => {},
      requireUser: async () => ({
        id: "owner-1",
        orgId: null,
        orgSlug: null,
        email: "owner@example.com",
        role: "admin",
      }),
      getPlanForUser: async () => ({ id: "pro" } as { id: string }),
      incrementUploads: async () => {},
      enforceGlobalApiRateLimit: async () => ({ ok: true, status: 200, retryAfterSeconds: 0 }),
      clientIpKey: () => ({ ip: "203.0.113.10", ipHash: "iphash" }),
      logDbErrorEvent: async () => {},
      logSecurityEvent: async (entry: unknown) => {
        securityLogs.push(entry as Record<string, unknown>);
      },
      detectStorageSpike: async () => {},
      getR2Bucket: () => configuredBucket,
      r2Client: {
        send: async (command: { constructor: { name: string }; input?: { Bucket?: string; Key?: string; Body?: Buffer; ContentType?: string; Metadata?: Record<string, string> } }) => {
          const bucket = String(command.input?.Bucket || configuredBucket);
          const key = String(command.input?.Key || "");
          const objectKey = objectMapKey(bucket, key);
          const stored = objects.get(objectKey);

          switch (command.constructor.name) {
            case "HeadObjectCommand":
              if (!stored) throw new Error("NoSuchKey");
              return {
                ContentLength: stored.body.byteLength,
                ContentType: stored.contentType,
                Metadata: stored.metadata,
              };
            case "GetObjectCommand":
              if (!stored) throw new Error("NoSuchKey");
              return {
                Body: asyncBuffer(stored.body),
              };
            case "PutObjectCommand":
              objects.set(objectKey, {
                bucket,
                key,
                body: Buffer.isBuffer(command.input?.Body) ? command.input.Body : Buffer.from(command.input?.Body || ""),
                contentType: String(command.input?.ContentType || "application/octet-stream"),
                metadata: command.input?.Metadata ?? {},
              });
              return {};
            case "DeleteObjectCommand":
              deletedKeys.push(key);
              objects.delete(objectKey);
              return {};
            default:
              throw new Error(`Unhandled R2 command ${command.constructor.name}`);
          }
        },
      } as unknown,
      enqueueDocScan: async ({ docId, bucket, key }: { docId: string; bucket: string; key: string }) => {
        queuedScans.push({ docId, bucket, key });
        scanJobs.set(`job-${nextJobId}`, {
          id: `job-${nextJobId}`,
          docId,
          bucket,
          key,
          attempts: 0,
          status: "queued",
          lastError: null,
        });
        nextJobId += 1;
        getDoc(docId).scanStatus = "pending";
      },
      encryptAes256Gcm: ({ plaintext }: { plaintext: Buffer }) => Buffer.concat([Buffer.from("enc:"), plaintext]),
      generateDataKey: () => Buffer.alloc(32, 1),
      generateIv: () => Buffer.from("123456789012"),
      wrapDataKey: () => ({
        wrapped: Buffer.from("wrapped"),
        iv: Buffer.from("wrapiv"),
        tag: Buffer.from("wraptag"),
      }),
      getActiveMasterKeyOrThrow: async () => ({ id: "mk-1", key: Buffer.alloc(32, 7) }),
      getRouteTimeoutMs: () => 45_000,
      isRouteTimeoutError: ((_: unknown): _ is never => false),
      withRouteTimeout: async <T>(work: Promise<T>) => work,
      assertRuntimeEnv: () => {},
      isRuntimeEnvError: ((_: unknown): _ is never => false),
      validateUploadType: () => ({ ok: true, canonicalMime: "application/pdf", ext: ".pdf", family: "document" }),
      resolvePublicAppBaseUrl: () => "https://app.example.test",
      findMissingPublicTableColumns: async () => [],
      withRequestTelemetry: async <T>(_req: NextRequest, fn: () => Promise<T>) => fn(),
      jsonError,
      jsonRateLimitError: (status: number, retryAfterSeconds: number) =>
        NextResponse.json({ ok: false, error: "RATE_LIMIT" }, { status, headers: { "Retry-After": String(retryAfterSeconds) } }),
    };
    return deps as unknown as UploadCompleteRouteDeps;
  }

  function buildServeDeps(): ServeRouteDeps {
    const deps = {
      sql: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join(" ");
        if (text.includes("select owner_id::text as owner_id")) {
          const docId = String(values[0]);
          const doc = docs.get(docId);
          return doc ? [{ owner_id: doc.ownerId }] : [];
        }
        return [];
      }) as ServeRouteDeps["sql"],
      mintAccessTicket: async () => {
        const ticket = `ticket_${mintedTickets.length + 1}`;
        mintedTickets.push(ticket);
        return ticket;
      },
      resolveDoc: async (input: { token?: string; docId?: string }) => {
        const doc = input.docId
          ? docs.get(input.docId)
          : input.token
          ? Array.from(docs.values())[0]
          : Array.from(docs.values()).find((candidate) => candidate.id === input.docId);
        if (!doc) return { ok: false, error: "NOT_FOUND" } as const;
        const blocked = doc.status !== "ready" || doc.scanStatus !== "clean" || doc.moderationStatus !== "active";
        if (input.token !== "tok_live" && input.docId !== doc.id) {
          return { ok: false, error: "NOT_FOUND" } as const;
        }
        if (blocked) {
          return { ok: false, error: "NOT_FOUND" } as const;
        }
        return {
          ok: true,
          source: input.token ? "token" : "direct",
          docId: doc.id,
          bucket: doc.r2Bucket,
          r2Key: doc.r2Key,
          title: doc.title,
          originalFilename: doc.originalFilename,
          contentType: doc.contentType,
          sizeBytes: doc.sizeBytes,
          requiresPassword: false,
        } as const;
      },
      getClientIpFromHeaders: () => "203.0.113.10",
      getUserAgentFromHeaders: () => "pw-test",
      logDocAccess: async () => {},
      rateLimit: async () => ({ ok: true, resetSeconds: 60 }),
      rateLimitHeaders: () => ({}),
      stableHash: () => "stable",
      emitWebhook: async () => {},
      geoDecisionForRequest: async () => ({ allowed: true }),
      getCountryFromHeaders: () => "US",
      assertCanServeView: async () => ({ ok: true }),
      incrementMonthlyViews: async () => {},
      enforcePlanLimitsEnabled: () => false,
      getAuthedUser: async () => ({
        id: "owner-1",
        email: "owner@example.com",
        orgId: null,
        orgSlug: null,
        role: "admin",
      }),
      roleAtLeast: () => true,
      isGlobalServeDisabled: async () => false,
      isSecurityTestNoDbMode: () => false,
      getRouteTimeoutMs: () => 25_000,
      isRouteTimeoutError: ((_: unknown): _ is never => false),
      withRouteTimeout: async <T>(work: Promise<T>) => work,
      enforceIpAbuseBlock: async () => ({ ok: true, retryAfterSeconds: 0 }),
      logDbErrorEvent: async () => {},
      logSecurityEvent: async () => {},
      maybeBlockIpOnAbuse: async () => {},
      assertRuntimeEnv: () => {},
      isRuntimeEnvError: ((_: unknown): _ is never => false),
      resolvePublicAppBaseUrl: () => "https://app.example.test",
      withRequestTelemetry: async <T>(_req: NextRequest, fn: () => Promise<T>) => fn(),
    };
    return deps as unknown as ServeRouteDeps;
  }

  function buildCronScanDeps(overrides?: Partial<CronScanRouteDeps>): CronScanRouteDeps {
    const deps = {
      cronUnauthorizedResponse: () => NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 }),
      isCronAuthorized: () => true,
      enforceGlobalApiRateLimit: async () => ({ ok: true, status: 200, retryAfterSeconds: 0 }),
      getRouteTimeoutMs: () => 120_000,
      isRouteTimeoutError: ((_: unknown): _ is never => false),
      withRouteTimeout: async <T>(work: Promise<T>) => work,
      healScanQueue: async () => ({
        runningTimeout: 20,
        maxAttempts: 2,
        retryBase: 1,
        retryMax: 2,
        staleRequeued: 0,
        staleDeadLettered: 0,
        errorRequeued: 0,
        maxAttemptJobs: Array.from(scanJobs.values()).filter((job) => job.status === "dead_letter").length,
      }),
      countQueuedStaleJobs: async () => ({
        queuedStaleCount: 0,
        oldestQueuedAgeSeconds: 0,
      }),
      claimQueuedJobs: async (maxJobs: number) => {
        const claimed = Array.from(scanJobs.values())
          .filter((job) => job.status === "queued")
          .slice(0, maxJobs);
        for (const job of claimed) {
          job.status = "running";
          job.attempts += 1;
        }
        return claimed.map((job) => ({
          id: job.id,
          doc_id: job.docId,
          r2_bucket: job.bucket,
          r2_key: job.key,
          attempts: job.attempts,
        }));
      },
      scanR2Object: async ({ bucket, key }: { bucket: string; key: string }) => {
        const outcome = scannerOutcomes.get(objectMapKey(bucket, key)) ?? "clean";
        if (outcome === "unavailable") {
          throw new Error("scanner_unavailable");
        }
        if (outcome === "unknown") {
          return {
            ok: true,
            sha256: "sha256-unknown",
            verdict: "unknown",
            riskLevel: "medium",
            flags: ["clam:unknown"],
            meta: { source: "local-verify" },
          };
        }
        if (outcome === "infected") {
          return {
            ok: true,
            sha256: "sha256-infected",
            verdict: "infected",
            riskLevel: "high",
            flags: ["clam:infected"],
            meta: { source: "local-verify" },
          };
        }
        return {
          ok: true,
          sha256: "sha256-clean",
          verdict: "clean",
          riskLevel: "low",
          flags: ["clam:clean"],
          meta: { source: "local-verify" },
        };
      },
      applyScanVerdict: async (
        job: { id: string; doc_id: string },
        verdict: { verdict: "clean" | "infected" | "unknown"; riskLevel: "low" | "medium" | "high"; flags: string[] }
      ) => {
        const doc = getDoc(job.doc_id);
        const scanJob = scanJobs.get(job.id);
        doc.scanStatus = verdict.verdict === "clean" ? "clean" : "quarantined";
        doc.riskLevel = verdict.riskLevel;
        doc.riskFlags = { flags: verdict.flags, source: "local-verify" };
        doc.moderationStatus = verdict.verdict === "clean" && verdict.riskLevel !== "high" ? "active" : "quarantined";
        if (scanJob) {
          scanJob.status = verdict.verdict === "clean" ? "clean" : "infected";
          scanJob.lastError = null;
        }
      },
      markScanFailure: async ({
        job,
        errorMessage,
        maxAttempts,
        retryBaseMinutes,
        retryMaxMinutes,
      }: {
        job: { id: string; doc_id: string; attempts: number };
        errorMessage: string;
        maxAttempts: number;
        retryBaseMinutes: number;
        retryMaxMinutes: number;
      }) => {
        const attempt = Math.max(1, Number(job.attempts || 1));
        const deadLettered = attempt >= maxAttempts;
        const delayMinutes = deadLettered ? null : Math.min(retryMaxMinutes, retryBaseMinutes * Math.pow(2, Math.max(0, attempt - 1)));
        const scanJob = scanJobs.get(job.id);
        if (scanJob) {
          scanJob.status = deadLettered ? "dead_letter" : "error";
          scanJob.lastError = errorMessage;
        }
        if (deadLettered) {
          getDoc(job.doc_id).scanStatus = "error";
        }
        return {
          attempt,
          delayMinutes: delayMinutes == null ? null : Math.floor(delayMinutes),
          deadLettered,
        };
      },
      logSecurityEvent: async (entry: unknown) => {
        securityLogs.push(entry as Record<string, unknown>);
      },
      detectScanFailureSpike: async () => {},
      reportException: async (entry: unknown) => {
        exceptions.push(entry as Record<string, unknown>);
      },
      logCronRun: async (entry: unknown) => {
        cronRuns.push(entry as Record<string, unknown>);
      },
      ...overrides,
    };
    return deps as unknown as CronScanRouteDeps;
  }

  function makeUploadPresignRequest(body: Record<string, unknown>) {
    return new NextRequest("https://app.example.test/api/admin/upload/presign", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(JSON.stringify(body), "utf8")),
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify(body),
    });
  }

  function makeUploadCompleteRequest(docId: string) {
    return new NextRequest("https://app.example.test/api/admin/upload/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "64",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({
        doc_id: docId,
        title: "Quarterly Report",
        original_filename: "report.pdf",
      }),
    });
  }

  function makeServeRequest(docId: string) {
    return new NextRequest(`https://app.example.test/serve/${docId}?token=tok_live`, { method: "GET" });
  }

  function makeCronScanRequest() {
    return new NextRequest("https://app.example.test/api/cron/scan", {
      method: "GET",
      headers: {
        authorization: "Bearer test-cron-secret",
      },
    });
  }

  return {
    docs,
    aliases,
    deletedKeys,
    mintedTickets,
    queuedScans,
    audits,
    securityLogs,
    cronRuns,
    exceptions,
    buildUploadPresignDeps,
    buildUploadCompleteDeps,
    buildServeDeps,
    buildCronScanDeps,
    makeUploadPresignRequest,
    makeUploadCompleteRequest,
    makeServeRequest,
    makeCronScanRequest,
    getDoc,
    seedDoc,
    seedUploadedObject,
    setScannerOutcome,
    getLatestDoc() {
      return Array.from(docs.values()).at(-1) ?? null;
    },
  };
}
