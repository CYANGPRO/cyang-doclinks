import { NextResponse } from "next/server";
import { z } from "zod";
import { PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

import { sql } from "@/lib/db";
import { getR2Bucket, r2Client } from "@/lib/r2";
import { requireUser } from "@/lib/authz";
import { assertCanUpload, getPlanForUser } from "@/lib/monetization";
import { enforcePlanLimitsEnabled } from "@/lib/billingFlags";
import {
  enforceGlobalApiRateLimit,
  clientIpKey,
  detectPresignFailureSpike,
  enforceIpAbuseBlock,
  logSecurityEvent,
  maybeBlockIpOnAbuse,
} from "@/lib/securityTelemetry";
import { getActiveMasterKeyOrThrow } from "@/lib/masterKeys";
import { appendImmutableAudit } from "@/lib/immutableAudit";
import { reportException } from "@/lib/observability";
import { validateUploadType } from "@/lib/uploadTypeValidation";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { assertRuntimeEnv, isRuntimeEnvError } from "@/lib/runtimeEnv";
import { withRequestTelemetry } from "@/lib/perfTelemetry";

export const runtime = "nodejs";
const MAX_UPLOAD_PRESIGN_BODY_BYTES = 16 * 1024;

// Enterprise: encryption is mandatory.
// We keep "encrypt" in the schema for backward compatibility, but it must be true (or omitted).
const BodySchema = z.object({
  title: z.string().optional(),
  filename: z.string().min(1).max(240),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive().optional(),
  encrypt: z.boolean().optional(),
});

export type UploadPresignRouteDeps = {
  sql: typeof sql;
  getR2Bucket: typeof getR2Bucket;
  r2Client: typeof r2Client;
  requireUser: typeof requireUser;
  assertCanUpload: typeof assertCanUpload;
  getPlanForUser: typeof getPlanForUser;
  enforcePlanLimitsEnabled: typeof enforcePlanLimitsEnabled;
  enforceGlobalApiRateLimit: typeof enforceGlobalApiRateLimit;
  clientIpKey: typeof clientIpKey;
  detectPresignFailureSpike: typeof detectPresignFailureSpike;
  enforceIpAbuseBlock: typeof enforceIpAbuseBlock;
  logSecurityEvent: typeof logSecurityEvent;
  maybeBlockIpOnAbuse: typeof maybeBlockIpOnAbuse;
  getActiveMasterKeyOrThrow: typeof getActiveMasterKeyOrThrow;
  appendImmutableAudit: typeof appendImmutableAudit;
  reportException: typeof reportException;
  validateUploadType: typeof validateUploadType;
  getRouteTimeoutMs: typeof getRouteTimeoutMs;
  isRouteTimeoutError: typeof isRouteTimeoutError;
  withRouteTimeout: typeof withRouteTimeout;
  assertRuntimeEnv: typeof assertRuntimeEnv;
  isRuntimeEnvError: typeof isRuntimeEnvError;
  withRequestTelemetry: typeof withRequestTelemetry;
  getSignedUrl: typeof getSignedUrl;
};

const defaultUploadPresignRouteDeps: UploadPresignRouteDeps = {
  sql,
  getR2Bucket,
  r2Client,
  requireUser,
  assertCanUpload,
  getPlanForUser,
  enforcePlanLimitsEnabled,
  enforceGlobalApiRateLimit,
  clientIpKey,
  detectPresignFailureSpike,
  enforceIpAbuseBlock,
  logSecurityEvent,
  maybeBlockIpOnAbuse,
  getActiveMasterKeyOrThrow,
  appendImmutableAudit,
  reportException,
  validateUploadType,
  getRouteTimeoutMs,
  isRouteTimeoutError,
  withRouteTimeout,
  assertRuntimeEnv,
  isRuntimeEnvError,
  withRequestTelemetry,
  getSignedUrl,
};

function safeKeyPart(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").slice(0, 120);
}

function getKeyPrefix() {
  const p = process.env.R2_PREFIX || "docs/";
  if (p.startsWith("r2://")) return "docs/";
  return p.endsWith("/") ? p : `${p}/`;
}

function authErrorCode(err: unknown): "UNAUTHENTICATED" | "FORBIDDEN" | "MFA_REQUIRED" | null {
  const msg = err instanceof Error ? err.message : String(err || "");
  if (msg === "UNAUTHENTICATED") return "UNAUTHENTICATED";
  if (msg === "FORBIDDEN") return "FORBIDDEN";
  if (msg === "MFA_REQUIRED") return "MFA_REQUIRED";
  if (msg.includes("outside a request scope")) return "UNAUTHENTICATED";
  return null;
}

function parseJsonBodyLength(req: Request): number {
  const raw = String(req.headers.get("content-length") || "").trim();
  const out = Number(raw);
  return Number.isFinite(out) ? Math.max(0, Math.floor(out)) : 0;
}

export async function postUploadPresignRoute(
  req: Request,
  deps: UploadPresignRouteDeps = defaultUploadPresignRouteDeps
) {
  const ipInfo = deps.clientIpKey(req);
  const timeoutMs = deps.getRouteTimeoutMs("ROUTE_TIMEOUT_UPLOAD_PRESIGN_MS", 20_000);
  try {
    return await deps.withRequestTelemetry(
      req,
      () => deps.withRouteTimeout(
        (async () => {
        if (parseJsonBodyLength(req) > MAX_UPLOAD_PRESIGN_BODY_BYTES) {
          return NextResponse.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
        }
        const abuseBlock = await deps.enforceIpAbuseBlock({ req, scope: "upload_presign" });
        if (!abuseBlock.ok) {
          return NextResponse.json(
            { ok: false, error: "ABUSE_BLOCKED" },
            { status: 403, headers: { "Retry-After": String(abuseBlock.retryAfterSeconds) } }
          );
        }
        // Global API throttle (best-effort)
        const globalRl = await deps.enforceGlobalApiRateLimit({
          req,
          scope: "ip:api",
          limit: Number(process.env.RATE_LIMIT_API_IP_PER_MIN || 240),
          windowSeconds: 60,
          strict: true,
        });
        if (!globalRl.ok) {
          return NextResponse.json(
            { ok: false, error: "RATE_LIMIT" },
            { status: globalRl.status, headers: { "Retry-After": String(globalRl.retryAfterSeconds) } }
          );
        }
        const json = await req.json().catch(() => null);
        const parsed = BodySchema.safeParse(json);
        if (!parsed.success) {
          return NextResponse.json({ ok: false, error: "BAD_REQUEST" }, { status: 400 });
        }

        const { title, filename } = parsed.data;
        const sizeBytes = parsed.data.sizeBytes ?? null;
        const absMax = Number(process.env.UPLOAD_ABSOLUTE_MAX_BYTES || 104_857_600); // 100 MB default
        if (sizeBytes != null && Number.isFinite(absMax) && absMax > 0 && sizeBytes > absMax) {
          return NextResponse.json(
            { ok: false, error: "FILE_TOO_LARGE", message: `File exceeds absolute limit (${absMax} bytes).` },
            { status: 413 }
          );
        }

        const user = await deps.requireUser();
        deps.assertRuntimeEnv("upload_presign");
        const plan = await deps.getPlanForUser(user.id);
        const r2Bucket = deps.getR2Bucket();

        // Upload presign throttle per-IP (stronger)
        const basePresignLimit = Number(process.env.RATE_LIMIT_UPLOAD_PRESIGN_IP_PER_MIN || 30);
        const freePresignLimit = Number(process.env.RATE_LIMIT_UPLOAD_PRESIGN_FREE_IP_PER_MIN || 12);
        const effectivePresignLimit =
          plan.id === "free"
            ? Math.max(1, Math.min(basePresignLimit, Number.isFinite(freePresignLimit) ? freePresignLimit : 12))
            : basePresignLimit;
        const presignRl = await deps.enforceGlobalApiRateLimit({
          req,
          scope: "ip:upload_presign",
          limit: effectivePresignLimit,
          windowSeconds: 60,
          actorUserId: user.id,
          orgId: user.orgId ?? null,
          strict: true,
        });
        if (!presignRl.ok) {
          await logSecurityEvent({
            type: "upload_throttle",
            severity: "medium",
            ip: ipInfo.ip,
            actorUserId: user.id,
            orgId: user.orgId ?? null,
            scope: "ip:upload_presign",
            message: "Upload presign throttled",
          });
          await maybeBlockIpOnAbuse({
            ip: ipInfo.ip,
            category: "upload_presign_abuse",
            scope: "upload_presign",
            threshold: Number(process.env.ABUSE_BLOCK_PRESIGN_THRESHOLD || 20),
            windowSeconds: Number(process.env.ABUSE_BLOCK_PRESIGN_WINDOW_SECONDS || 600),
            blockSeconds: Number(process.env.ABUSE_BLOCK_TTL_SECONDS || 3600),
            reason: "Repeated upload presign abuse",
          });
          return NextResponse.json(
            { ok: false, error: "RATE_LIMIT" },
            { status: presignRl.status, headers: { "Retry-After": String(presignRl.retryAfterSeconds) } }
          );
        }

        const declaredType = validateUploadType({
          filename,
          declaredMime: parsed.data.contentType,
        });
        if (!declaredType.ok) {
          return NextResponse.json(
            { ok: false, error: declaredType.error, message: declaredType.message },
            { status: 400 }
          );
        }

        // Enterprise mode: encryption is mandatory for everyone.
        // Non-owner accounts are allowed to upload; they just cannot disable encryption.
        const encryptRequested = parsed.data.encrypt;
        if (encryptRequested === false) {
          return NextResponse.json(
            { ok: false, error: "ENCRYPTION_REQUIRED", message: "Encryption is mandatory." },
            { status: 400 }
          );
        }
        const contentType = declaredType.canonicalMime;

        // Hard enforcement needs an explicit sizeBytes to prevent bypassing storage/file-size caps.
        if (deps.enforcePlanLimitsEnabled() && (sizeBytes == null || !Number.isFinite(sizeBytes) || sizeBytes <= 0)) {
          return NextResponse.json({ ok: false, error: "MISSING_SIZE", message: "sizeBytes is required." }, { status: 400 });
        }

        // --- Monetization / plan limits (hidden) ---
        const canUpload = await deps.assertCanUpload({ userId: user.id, sizeBytes: sizeBytes ?? null });
        if (!canUpload.ok) {
          return NextResponse.json(
            { ok: false, error: "PAYMENT_REQUIRED", message: canUpload.message || "Upgrade required to upload." },
            { status: 402 }
          );
        }

        // --- Mandatory encryption configuration ---
        let activeKeyId: string;
        try {
          activeKeyId = (await deps.getActiveMasterKeyOrThrow()).id;
        } catch (e: unknown) {
          const msg = e instanceof Error && e.message === "MASTER_KEY_REVOKED" ? "Active master key is revoked." : "Missing DOC_MASTER_KEYS.";
          await deps.logSecurityEvent({
            type: "upload_presign_error",
            severity: "high",
            ip: ipInfo.ip,
            actorUserId: user.id,
            orgId: user.orgId ?? null,
            scope: "upload_presign",
            message: "Encryption configuration unavailable during presign",
            meta: { reason: msg },
          });
          await deps.detectPresignFailureSpike({ ip: ipInfo.ip });
          return NextResponse.json(
            { ok: false, error: "ENCRYPTION_NOT_CONFIGURED", message: "Encryption configuration unavailable." },
            { status: 500 }
          );
        }

        const docId = crypto.randomUUID();
        const keyPrefix = getKeyPrefix();
        const safeName = safeKeyPart(filename);
        const key = `${keyPrefix}${docId}_${safeName}`;

        const createdByEmail = user.email;

        await deps.sql`
          insert into docs (
            id,
            org_id,
            owner_id,
            title,
            original_filename,
            content_type,
            size_bytes,
            r2_bucket,
            r2_key,
            created_by_email,
            status,
            encryption_enabled
          )
          values (
            ${docId}::uuid,
            ${user.orgId ? user.orgId : null}::uuid,
            ${user.id}::uuid,
            ${title ?? filename},
            ${filename},
            ${contentType},
            ${sizeBytes}::bigint,
            ${r2Bucket},
            ${key},
            ${createdByEmail},
            'uploading',
            true
          )
        `;

        await deps.appendImmutableAudit({
          streamKey: `doc:${docId}`,
          action: "doc.upload_initiated",
          actorUserId: user.id,
          orgId: user.orgId ?? null,
          docId,
          ipHash: ipInfo.ipHash,
          payload: {
            encryptionEnabled: true,
            encAlg: "AES-256-GCM",
            encKeyVersion: activeKeyId,
            contentType,
            sizeBytes,
            filename,
          },
        });

        const expiresIn = 10 * 60;

        const putParams: PutObjectCommandInput = {
          Bucket: r2Bucket,
          Key: key,
          ContentType: contentType,
          Metadata: {
            "doc-id": docId,
            "orig-content-type": contentType,
            "orig-ext": declaredType.ext,
          },
        };

        const unhoistableHeaders = new Set([
          "content-type",
          "x-amz-meta-doc-id",
          "x-amz-meta-orig-content-type",
          "x-amz-meta-orig-ext",
        ]);

        const uploadUrl = await deps.getSignedUrl(deps.r2Client, new PutObjectCommand(putParams), {
          expiresIn,
          unhoistableHeaders,
        });

        return NextResponse.json({
          ok: true,
          doc_id: docId,
          upload_url: uploadUrl,
          r2_key: key,
          bucket: r2Bucket,
          expires_in: expiresIn,
          upload_headers: {
            "content-type": contentType,
            "x-amz-meta-doc-id": docId,
            "x-amz-meta-orig-content-type": contentType,
            "x-amz-meta-orig-ext": declaredType.ext,
          },
        });
        })(),
        timeoutMs
      ),
      { routeKey: "/api/admin/upload/presign" }
    );
  } catch (err: unknown) {
    if (deps.isRouteTimeoutError(err)) {
      return NextResponse.json(
        { ok: false, error: "TIMEOUT", message: "Unable to initialize upload in time." },
        { status: 504 }
      );
    }
    const authCode = authErrorCode(err);
    if (authCode === "UNAUTHENTICATED") {
      return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
    }
    if (authCode === "FORBIDDEN") {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }
    if (authCode === "MFA_REQUIRED") {
      return NextResponse.json({ ok: false, error: "MFA_REQUIRED" }, { status: 403 });
    }
    if (deps.isRuntimeEnvError(err)) {
      return NextResponse.json(
        { ok: false, error: "ENV_MISCONFIGURED", message: "Upload configuration is unavailable." },
        { status: 503 }
      );
    }
    await deps.logSecurityEvent({
      type: "upload_presign_error",
      severity: "high",
      ip: ipInfo.ip,
      scope: "upload_presign",
      message: "Unhandled presign error",
      meta: { error_type: err instanceof Error ? err.name || "Error" : typeof err },
    });
    await deps.detectPresignFailureSpike({ ip: ipInfo.ip });
    await deps.reportException({
      error: err,
      event: "upload_presign_route_error",
      context: { route: "/api/admin/upload/presign" },
    });
    return NextResponse.json(
      { ok: false, error: "SERVER_ERROR", message: "Unable to initialize upload." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  return postUploadPresignRoute(req);
}
