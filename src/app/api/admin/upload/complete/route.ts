export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { HeadObjectCommandOutput, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { validatePdfBuffer } from "@/lib/pdfSafety";
import { sql } from "@/lib/db";
import { slugify } from "@/lib/slug";
import { requireDocWrite, requireUser } from "@/lib/authz";
import { getPlanForUser, incrementUploads } from "@/lib/monetization";
import { enforceGlobalApiRateLimit, clientIpKey, logDbErrorEvent, logSecurityEvent, detectStorageSpike } from "@/lib/securityTelemetry";
import { getR2Bucket, r2Client } from "@/lib/r2";
import { enqueueDocScan } from "@/lib/scanQueue";
import { encryptAes256Gcm, generateDataKey, generateIv, wrapDataKey } from "@/lib/encryption";
import { getActiveMasterKeyOrThrow } from "@/lib/masterKeys";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { assertRuntimeEnv, isRuntimeEnvError } from "@/lib/runtimeEnv";
import { validateUploadType } from "@/lib/uploadTypeValidation";
import { resolvePublicAppBaseUrl } from "@/lib/publicBaseUrl";
import { findMissingPublicTableColumns } from "@/lib/dbSchema";
import { withRequestTelemetry } from "@/lib/perfTelemetry";
import { jsonError, jsonRateLimitError } from "@/lib/apiResponses";

type CompleteRequest = {
  // Newer flow: doc_id from /presign response
  doc_id?: string;

  // Older flow (what your Network screenshot shows right now)
  r2_bucket?: string;
  r2_key?: string;

  title?: string | null;
  original_filename?: string | null;
};

const DOC_FINALIZE_REQUIRED_COLUMNS = [
  "status",
  "scan_status",
  "risk_level",
  "risk_flags",
  "moderation_status",
  "enc_alg",
  "enc_iv",
  "enc_key_version",
  "enc_wrapped_key",
  "enc_wrap_iv",
  "enc_wrap_tag",
] as const;
const MAX_UPLOAD_COMPLETE_BODY_BYTES = 16 * 1024;

export type UploadCompleteRouteDeps = {
  validatePdfBuffer: typeof validatePdfBuffer;
  sql: typeof sql;
  slugify: typeof slugify;
  requireDocWrite: typeof requireDocWrite;
  requireUser: typeof requireUser;
  getPlanForUser: typeof getPlanForUser;
  incrementUploads: typeof incrementUploads;
  enforceGlobalApiRateLimit: typeof enforceGlobalApiRateLimit;
  clientIpKey: typeof clientIpKey;
  logDbErrorEvent: typeof logDbErrorEvent;
  logSecurityEvent: typeof logSecurityEvent;
  detectStorageSpike: typeof detectStorageSpike;
  getR2Bucket: typeof getR2Bucket;
  r2Client: typeof r2Client;
  enqueueDocScan: typeof enqueueDocScan;
  encryptAes256Gcm: typeof encryptAes256Gcm;
  generateDataKey: typeof generateDataKey;
  generateIv: typeof generateIv;
  wrapDataKey: typeof wrapDataKey;
  getActiveMasterKeyOrThrow: typeof getActiveMasterKeyOrThrow;
  getRouteTimeoutMs: typeof getRouteTimeoutMs;
  isRouteTimeoutError: typeof isRouteTimeoutError;
  withRouteTimeout: typeof withRouteTimeout;
  assertRuntimeEnv: typeof assertRuntimeEnv;
  isRuntimeEnvError: typeof isRuntimeEnvError;
  validateUploadType: typeof validateUploadType;
  resolvePublicAppBaseUrl: typeof resolvePublicAppBaseUrl;
  findMissingPublicTableColumns: typeof findMissingPublicTableColumns;
  withRequestTelemetry: typeof withRequestTelemetry;
  jsonError: typeof jsonError;
  jsonRateLimitError: typeof jsonRateLimitError;
};

const defaultUploadCompleteRouteDeps: UploadCompleteRouteDeps = {
  validatePdfBuffer,
  sql,
  slugify,
  requireDocWrite,
  requireUser,
  getPlanForUser,
  incrementUploads,
  enforceGlobalApiRateLimit,
  clientIpKey,
  logDbErrorEvent,
  logSecurityEvent,
  detectStorageSpike,
  getR2Bucket,
  r2Client,
  enqueueDocScan,
  encryptAes256Gcm,
  generateDataKey,
  generateIv,
  wrapDataKey,
  getActiveMasterKeyOrThrow,
  getRouteTimeoutMs,
  isRouteTimeoutError,
  withRouteTimeout,
  assertRuntimeEnv,
  isRuntimeEnvError,
  validateUploadType,
  resolvePublicAppBaseUrl,
  findMissingPublicTableColumns,
  withRequestTelemetry,
  jsonError,
  jsonRateLimitError,
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sqlErrorCode(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function extractMissingColumn(message: string): string | null {
  const m = /column\s+"?([a-zA-Z0-9_]+)"?\s+of relation/i.exec(message);
  if (m?.[1]) return m[1];
  const m2 = /column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i.exec(message);
  return m2?.[1] ?? null;
}

function parseJsonBodyLength(req: NextRequest): number {
  const raw = String(req.headers.get("content-length") || "").trim();
  const out = Number(raw);
  return Number.isFinite(out) ? Math.max(0, Math.floor(out)) : 0;
}

function authErrorCode(err: unknown): "UNAUTHENTICATED" | "FORBIDDEN" | "MFA_REQUIRED" | null {
  const msg = err instanceof Error ? err.message : String(err || "");
  if (msg === "UNAUTHENTICATED") return "UNAUTHENTICATED";
  if (msg === "FORBIDDEN") return "FORBIDDEN";
  if (msg === "MFA_REQUIRED") return "MFA_REQUIRED";
  if (msg.includes("outside a request scope")) return "UNAUTHENTICATED";
  return null;
}

function uploadFinalizeUnavailable() {
  return jsonError("UPLOAD_FINALIZE_UNAVAILABLE", 503);
}

function uploadFinalizeFailed() {
  return jsonError("UPLOAD_FINALIZE_FAILED", 500);
}

function uploadFinalizeUnavailableWithDeps(deps: Pick<UploadCompleteRouteDeps, "jsonError">) {
  return deps.jsonError("UPLOAD_FINALIZE_UNAVAILABLE", 503);
}

function uploadFinalizeFailedWithDeps(deps: Pick<UploadCompleteRouteDeps, "jsonError">) {
  return deps.jsonError("UPLOAD_FINALIZE_FAILED", 500);
}

async function streamToBuffer(body: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    if (chunk instanceof ArrayBuffer) {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    throw new Error("Unsupported stream chunk type");
  }
  return Buffer.concat(chunks);
}

export async function postUploadCompleteRoute(
  req: NextRequest,
  deps: UploadCompleteRouteDeps = defaultUploadCompleteRouteDeps
) {
  const timeoutMs = deps.getRouteTimeoutMs("ROUTE_TIMEOUT_UPLOAD_COMPLETE_MS", 45_000);
  let stage = "init";
  try {
    return await deps.withRequestTelemetry(
      req,
      () => deps.withRouteTimeout(
        (async () => {
        stage = "global_rate_limit";
        const globalRl = await deps.enforceGlobalApiRateLimit({
          req,
          scope: "ip:api",
          limit: Number(process.env.RATE_LIMIT_API_IP_PER_MIN || 240),
          windowSeconds: 60,
          strict: true,
        });
        if (!globalRl.ok) {
          return deps.jsonRateLimitError(globalRl.status, globalRl.retryAfterSeconds);
        }

    stage = "parse_body";
    if (parseJsonBodyLength(req) > MAX_UPLOAD_COMPLETE_BODY_BYTES) {
      return deps.jsonError("PAYLOAD_TOO_LARGE", 413);
    }
    const parsedBody = await req.json().catch(() => null);
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return deps.jsonError("BAD_REQUEST", 400, { message: "Request body must be a JSON object." });
    }
    const body = parsedBody as CompleteRequest;

        stage = "auth";
        const user = await deps.requireUser();
        stage = "runtime_env";
        deps.assertRuntimeEnv("upload_complete");
        const r2Bucket = deps.getR2Bucket();
        const plan = await deps.getPlanForUser(user.id);

        // Upload complete throttle per-IP
        const ipInfo = deps.clientIpKey(req);
        const baseCompleteLimit = Number(process.env.RATE_LIMIT_UPLOAD_COMPLETE_IP_PER_MIN || 30);
        const freeCompleteLimit = Number(process.env.RATE_LIMIT_UPLOAD_COMPLETE_FREE_IP_PER_MIN || 12);
        const effectiveCompleteLimit =
          plan.id === "free"
            ? Math.max(1, Math.min(baseCompleteLimit, Number.isFinite(freeCompleteLimit) ? freeCompleteLimit : 12))
            : baseCompleteLimit;
        const completeRl = await deps.enforceGlobalApiRateLimit({
          req,
          scope: "ip:upload_complete",
          limit: effectiveCompleteLimit,
          windowSeconds: 60,
          strict: true,
        });
        if (!completeRl.ok) {
          await deps.logSecurityEvent({
            type: "upload_throttle",
            severity: "medium",
            ip: ipInfo.ip,
            scope: "ip:upload_complete",
            message: "Upload complete throttled",
          });
          return deps.jsonRateLimitError(completeRl.status, completeRl.retryAfterSeconds);
        }

    const title = body.title ?? null;
    const originalFilename = body.original_filename ?? null;

    // 1) Resolve docId either directly or via (bucket,key)
    let docId: string | null = body.doc_id ?? null;

    stage = "resolve_doc";
    if (!docId) {
      const bucket = body.r2_bucket ?? null;
      const key = body.r2_key ?? null;

      if (bucket && key) {
        const rows = (await deps.sql`
          select id::text as id
          from public.docs
          where r2_bucket = ${bucket}
            and r2_key = ${key}
          limit 1
        `) as { id: string }[];

        docId = rows?.[0]?.id ?? null;
      }
    }

    if (!docId) {
      return NextResponse.json(
        {
          ok: false,
          error: "MISSING_DOC_ID",
          message: "Send doc_id (preferred) or r2_bucket + r2_key.",
        },
        { status: 400 }
      );
    }

    // AuthZ: must be able to manage this doc.
    stage = "authorize_doc_write";
    await deps.requireDocWrite(docId);

    // 2) Fetch existing doc (for slug fallback)
    stage = "load_doc_row";
    const docRows = (await deps.sql`
      select
        id::text as id,
        coalesce(original_filename, title, '')::text as name,
        coalesce(content_type, '')::text as content_type,
        r2_bucket::text as r2_bucket,
        r2_key::text as r2_key
      from public.docs
      where id = ${docId}::uuid
      limit 1
    `) as { id: string; name: string; content_type: string; r2_bucket: string | null; r2_key: string | null }[];

    if (!docRows.length) {
      return NextResponse.json({ ok: false, error: "doc_not_found" }, { status: 404 });
    }

    stage = "schema_preflight";
    // Strict schema preflight (no fallback writes): fail fast with actionable detail.
    const missingFinalizeColumns = await deps.findMissingPublicTableColumns("docs", DOC_FINALIZE_REQUIRED_COLUMNS);
    if (missingFinalizeColumns.length > 0) {
      await deps.logSecurityEvent({
        type: "upload_complete_schema_mismatch",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "Docs schema missing required upload finalization columns",
        meta: { missingFinalizeColumns },
      });
      return uploadFinalizeUnavailableWithDeps(deps);
    }

    stage = "mark_processing";
    // Legacy deployments may enforce docs_status_check without 'processing'.
    // Keep status as 'uploading' until the final update marks it 'ready'.
    await deps.sql`
      update public.docs
      set status = 'uploading'
      where id = ${docId}::uuid
        and lower(coalesce(status::text, 'ready')) in ('uploading', 'processing')
    `;

    const existingName = docRows[0].name;

    const docBucket = docRows[0].r2_bucket;
    const docKey = docRows[0].r2_key;
    if (!docBucket || !docKey) {
      return deps.jsonError("MISSING_R2_POINTER", 409);
    }

    // Defensive: ensure this doc points at the configured bucket.
    // (Prevents any future cross-bucket pointer mistakes from becoming a data exfil path.)
    if (docBucket !== r2Bucket) {
      await deps.logSecurityEvent({
        type: "upload_complete_bucket_mismatch",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "Doc bucket does not match configured R2 bucket",
        meta: { docBucket, configuredBucket: r2Bucket },
      });
      return deps.jsonError("BUCKET_MISMATCH", 409);
    }

    const cleanupRejectedObject = async (reason: string, meta?: Record<string, unknown>) => {
      try {
          await deps.r2Client.send(
          new DeleteObjectCommand({
            Bucket: docBucket,
            Key: docKey,
          })
        );
      } catch (e: unknown) {
        await deps.logSecurityEvent({
          type: "upload_complete_cleanup_failed",
          severity: "high",
          ip: ipInfo.ip,
          docId,
          scope: "upload_complete",
          message: "Failed to delete rejected object from R2",
          meta: { reason, error: errorMessage(e), ...(meta || {}) },
        });
      }
    };

    // 3) Verify the object exists in R2 and matches expected constraints.
    // This closes the bypass where a client can lie about size/type during presign.
    const absMax = Number(process.env.UPLOAD_ABSOLUTE_MAX_BYTES || 104_857_600); // 100 MB default

    // Pull expected size and encryption flag from DB.
    const verifyRows = (await deps.sql`
      select
        size_bytes::bigint as size_bytes,
        encryption_enabled::boolean as encryption_enabled
      from public.docs
      where id = ${docId}::uuid
      limit 1
    `) as unknown as Array<{
      size_bytes: number | string | null;
      encryption_enabled: boolean | null;
    }>;

    const expectedPlain = Number(verifyRows?.[0]?.size_bytes ?? 0);
    const encryptionEnabled = Boolean(verifyRows?.[0]?.encryption_enabled);

    if (!encryptionEnabled) {
      await deps.logSecurityEvent({
        type: "upload_complete_encryption_required",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "Upload completion blocked because encryption is not enabled for this doc",
      });
      await cleanupRejectedObject("encryption_required");
      return deps.jsonError("ENCRYPTION_REQUIRED", 409);
    }

    stage = "head_object";
    let head: HeadObjectCommandOutput;
    try {
      head = await deps.r2Client.send(
        new HeadObjectCommand({
          Bucket: docBucket,
          Key: docKey,
        })
      );
    } catch (e: unknown) {
      await deps.logSecurityEvent({
        type: "upload_complete_missing_object",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "Upload complete called but R2 object missing",
        meta: { err: e instanceof Error ? e.name || e.message : String(e) },
      });
      return deps.jsonError("OBJECT_MISSING", 409);
    }

    const contentLength = Number(head?.ContentLength ?? 0);
    const ct = String(head?.ContentType ?? "");
    const meta = (head?.Metadata ?? {}) as Record<string, string>;

    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      await cleanupRejectedObject("invalid_object", { contentLength });
      return deps.jsonError("INVALID_OBJECT", 409);
    }
    if (Number.isFinite(absMax) && absMax > 0 && contentLength > absMax) {
      await deps.logSecurityEvent({
        type: "upload_complete_too_large",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "Uploaded object exceeds absolute max",
        meta: { contentLength, absMax },
      });
      await cleanupRejectedObject("object_too_large", { contentLength, absMax });
      return deps.jsonError("OBJECT_TOO_LARGE", 413);
    }

    if (Number.isFinite(expectedPlain) && expectedPlain > 0) {
      const allowedSizes = new Set<number>([expectedPlain]);
      if (!allowedSizes.has(contentLength)) {
        await deps.logSecurityEvent({
          type: "upload_complete_size_mismatch",
          severity: "high",
          ip: ipInfo.ip,
          docId,
          scope: "upload_complete",
          message: "Uploaded object size mismatch",
          meta: { expectedPlain, contentLength, encryptionEnabled },
        });
        await cleanupRejectedObject("size_mismatch", { expectedPlain, contentLength, encryptionEnabled });
        return deps.jsonError("SIZE_MISMATCH", 409);
      }
    }

    // Verify signed metadata we attached during presign.
    const metaDocId = (meta["doc-id"] || meta["doc_id"] || "").toString();
    const metaOrigCt = (meta["orig-content-type"] || meta["orig_content_type"] || "").toString();
    const metaOrigExt = (meta["orig-ext"] || meta["orig_ext"] || "").toString();

    if (!metaDocId) {
      await deps.logSecurityEvent({
        type: "upload_complete_meta_missing_doc_id",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "R2 object metadata doc-id missing",
      });
      await cleanupRejectedObject("metadata_missing");
      return deps.jsonError("METADATA_MISSING", 409);
    }

    if (metaDocId !== docId) {
      await deps.logSecurityEvent({
        type: "upload_complete_meta_mismatch",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "R2 object metadata doc-id mismatch",
        meta: { metaDocId, docId },
      });
      await cleanupRejectedObject("metadata_mismatch", { metaDocId, docId });
      return deps.jsonError("METADATA_MISMATCH", 409);
    }

    if (!metaOrigCt) {
      await deps.logSecurityEvent({
        type: "upload_complete_mime_missing",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "R2 metadata orig-content-type is missing",
        meta: { metaOrigCt, ct, metaOrigExt },
      });
      await cleanupRejectedObject("mime_missing", { metaOrigCt, contentType: ct, metaOrigExt });
      return deps.jsonError("MIME_MISSING", 409);
    }

    if (ct && ct !== metaOrigCt) {
      await deps.logSecurityEvent({
        type: "upload_complete_content_type_mismatch",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "Upload object content-type mismatch with declared metadata",
        meta: { contentType: ct, metaOrigCt },
      });
      await cleanupRejectedObject("content_type_mismatch", { encryptionEnabled: true, contentType: ct, metaOrigCt });
      return deps.jsonError("CONTENT_TYPE_MISMATCH", 409);
    }

    // 4) Read uploaded PDF bytes and validate server-side before encryption.
    stage = "read_object";
    let scanStatus: string = "pending";
    let riskLevel: string = "low";
    let riskFlags: Record<string, unknown> | null = null;
    let uploadedBytes: Buffer;
    try {
      const uploadedObj: GetObjectCommandOutput = await deps.r2Client.send(
        new GetObjectCommand({
          Bucket: docBucket,
          Key: docKey,
        })
      );
      uploadedBytes = await streamToBuffer(uploadedObj.Body as AsyncIterable<unknown>);
    } catch {
      await cleanupRejectedObject("object_read_failed");
      return deps.jsonError("OBJECT_READ_FAILED", 409);
    }

    const filenameForValidation = (originalFilename || docRows[0].name || "upload.bin").trim();
    stage = "validate_type";
    const typeCheck = deps.validateUploadType({
      filename: filenameForValidation,
      declaredMime: metaOrigCt || docRows[0].content_type || null,
      bytes: uploadedBytes,
    });
    if (!typeCheck.ok) {
      await deps.logSecurityEvent({
        type: "upload_complete_type_validation_failed",
        severity: "high",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "File type validation failed before encryption",
        meta: { error: typeCheck.error, message: typeCheck.message, metaOrigCt, filenameForValidation },
      });
      await cleanupRejectedObject("type_validation_failed_before_encrypt", { error: typeCheck.error });
      return deps.jsonError(typeCheck.error, 409, { message: typeCheck.message });
    }

    if (typeCheck.canonicalMime === "application/pdf") {
      const safety = deps.validatePdfBuffer({
        bytes: uploadedBytes,
        absMaxBytes: absMax,
        maxPdfPages: Number(process.env.PDF_MAX_PAGES || 2000),
      });
      if (!safety.ok) {
        await deps.logSecurityEvent({
          type: "upload_complete_pdf_validation_failed",
          severity: "high",
          ip: ipInfo.ip,
          docId,
          scope: "upload_complete",
          message: "PDF validation failed before encryption",
          meta: { error: safety.error, message: safety.message, details: safety.details ?? null },
        });
        await cleanupRejectedObject("pdf_validation_failed_before_encrypt", { error: safety.error });
        return deps.jsonError(safety.error, 409, { message: safety.message });
      }
      scanStatus = "pending";
      riskLevel = safety.riskLevel;
      riskFlags = { flags: safety.flags, details: safety.details, mode: "server_validation" };
    } else {
      scanStatus = "pending";
      riskLevel = "low";
      riskFlags = { flags: [], details: { mime: typeCheck.canonicalMime, ext: typeCheck.ext }, mode: "server_validation" };
    }

    // 5) Encrypt file server-side and overwrite uploaded plaintext object.
    stage = "encrypt_overwrite";
    let encAlg = "AES-256-GCM";
    let encIv: Buffer | null = null;
    let encKeyVersion = "";
    let encWrappedKey: Buffer | null = null;
    let encWrapIv: Buffer | null = null;
    let encWrapTag: Buffer | null = null;
    try {
      const mk = await deps.getActiveMasterKeyOrThrow();
      const dataKey = deps.generateDataKey();
      encIv = deps.generateIv();
      const wrap = deps.wrapDataKey({ dataKey, masterKey: mk.key });
      const ciphertext = deps.encryptAes256Gcm({ plaintext: uploadedBytes, iv: encIv, key: dataKey });
      await deps.r2Client.send(
        new PutObjectCommand({
          Bucket: docBucket,
          Key: docKey,
          Body: ciphertext,
          ContentType: "application/octet-stream",
          Metadata: {
            "doc-id": docId,
            "orig-content-type": typeCheck.canonicalMime,
            "orig-ext": typeCheck.ext,
          },
        })
      );
      encKeyVersion = mk.id;
      encWrappedKey = wrap.wrapped;
      encWrapIv = wrap.iv;
      encWrapTag = wrap.tag;
    } catch {
      await cleanupRejectedObject("server_side_encrypt_failed");
      return uploadFinalizeFailedWithDeps(deps);
    }
    if (!encIv || !encKeyVersion || !encWrappedKey || !encWrapIv || !encWrapTag) {
      await cleanupRejectedObject("server_side_encrypt_metadata_missing");
      return uploadFinalizeFailedWithDeps(deps);
    }

    stage = "update_doc";
// 6) Mark doc ready + update metadata (best-effort)
    const updatedRows = (await deps.sql`
      update public.docs
      set
        title = coalesce(${title}, title),
        original_filename = coalesce(${originalFilename}, original_filename),
        content_type = ${typeCheck.canonicalMime},
        status = 'ready',
        scan_status = ${scanStatus}::text,
        risk_level = ${riskLevel}::text,
        risk_flags = ${riskFlags}::jsonb,
        enc_alg = ${encAlg},
        enc_iv = ${encIv},
        enc_key_version = ${encKeyVersion},
        enc_wrapped_key = ${encWrappedKey},
        enc_wrap_iv = ${encWrapIv},
        enc_wrap_tag = ${encWrapTag},
        moderation_status = case
          when ${riskLevel}::text = 'high' then 'quarantined'
          when lower(coalesce(moderation_status, 'active')) in ('disabled', 'deleted') then moderation_status
          else 'active'
        end
      where id = ${docId}::uuid
      returning
        coalesce(status::text, 'ready') as doc_state,
        coalesce(scan_status::text, 'pending') as scan_state,
        coalesce(moderation_status::text, 'active') as moderation_status
    `) as unknown as Array<{
      doc_state: string;
      scan_state: string;
      moderation_status: string;
    }>;



stage = "enqueue_scan";
// 4b) Enqueue async malware scan (best-effort; runs via /api/cron/scan)
try {
  await deps.enqueueDocScan({ docId, bucket: docBucket, key: docKey });
} catch (e: unknown) {
  // Non-fatal; upload is still usable unless other rules quarantine it.
  await deps.logSecurityEvent({
    type: "malware_scan_enqueue_failed",
    severity: "medium",
    ip: ipInfo.ip,
    docId,
    scope: "upload_complete",
    message: "Failed to enqueue malware scan job",
    meta: { error: errorMessage(e) },
  });
}
stage = "usage_counters";
// --- Monetization counters (hidden) ---
// Count this as an upload for the doc owner (usually the signed-in user).
try {
  const usageRows = (await deps.sql`
    select owner_id::text as owner_id
         , org_id::text as org_id
         , size_bytes::bigint as size_bytes
    from public.docs
    where id = ${docId}::uuid
    limit 1
  `) as unknown as Array<{ owner_id: string | null; org_id: string | null; size_bytes: number | string | null }>;
  const ownerId = usageRows?.[0]?.owner_id ?? null;
  const orgId = usageRows?.[0]?.org_id ?? null;
  const sizeBytes = Number(usageRows?.[0]?.size_bytes ?? 0);
  if (ownerId) {
    await deps.incrementUploads(ownerId, 1);

    // Storage spike detection (best-effort)
    if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
      await deps.detectStorageSpike({ ownerId, sizeBytes, ip: ipInfo.ip, orgId, docId });
    }
  }
} catch (e) {
  // best-effort; do not block completion
  console.warn("Failed to increment upload usage.");
}


    stage = "create_alias";
    // 4) Generate alias base
    let base = deps.slugify(title || originalFilename || existingName || "document");
    if (!base) base = `doc-${docId.slice(0, 8)}`;

    // 5) Create alias with collision handling
    let finalAlias: string | null = null;

    const aliasTtlDaysRaw = Number(process.env.ALIAS_DEFAULT_TTL_DAYS || 30);
    const aliasTtlDays = Number.isFinite(aliasTtlDaysRaw)
      ? Math.max(1, Math.min(365, Math.floor(aliasTtlDaysRaw)))
      : 30;

    for (let i = 0; i < 50; i++) {
      const candidateAlias = i === 0 ? base : `${base}-${i + 1}`;

      try {
        await deps.sql`
          insert into public.doc_aliases (alias, doc_id, is_active, expires_at, revoked_at)
          values (${candidateAlias}, ${docId}::uuid, true, now() + (${aliasTtlDays}::int * interval '1 day'), null)
        `;
        finalAlias = candidateAlias;
        break;
      } catch (e: unknown) {
        const msg = errorMessage(e);
        const missingCol =
          msg.includes("column") &&
          (msg.includes("expires_at") || msg.includes("revoked_at") || msg.includes("is_active"));
        if (missingCol) {
          try {
            await deps.sql`
              insert into public.doc_aliases (alias, doc_id)
              values (${candidateAlias}, ${docId}::uuid)
            `;
            finalAlias = candidateAlias;
            break;
          } catch {
            // alias collision on legacy schema; continue suffix loop
          }
        }
        // alias collision or transient issue, try next
      }
    }

    if (!finalAlias) {
      return uploadFinalizeFailedWithDeps(deps);
    }

    stage = "build_view_url";
    let baseUrl: string;
    try {
      baseUrl = deps.resolvePublicAppBaseUrl(req.url);
    } catch (e: unknown) {
      // Do not fail upload finalization due to APP_URL/NEXTAUTH_URL configuration.
      // Fallback to request origin so client still receives a usable link.
      const reqOrigin = new URL(req.url).origin;
      await deps.logSecurityEvent({
        type: "upload_complete_base_url_fallback",
        severity: "medium",
        ip: ipInfo.ip,
        docId,
        scope: "upload_complete",
        message: "Fell back to request origin because configured public base URL is invalid",
        meta: { error: errorMessage(e), reqOrigin },
      });
      baseUrl = reqOrigin;
    }

        stage = "done";
        await deps.logSecurityEvent({
          type: "upload_complete_success",
          severity: "low",
          ip: ipInfo.ip,
          scope: "upload_complete",
          message: "Upload finalized successfully",
          docId,
          meta: { sizeBytes: expectedPlain || null },
        });

        return NextResponse.json({
          ok: true,
          doc_id: docId,
          alias: finalAlias,
          view_url: `${baseUrl}/d/${encodeURIComponent(finalAlias)}`,
          doc_state: updatedRows?.[0]?.doc_state ?? "ready",
          scan_state: updatedRows?.[0]?.scan_state ?? "pending",
          moderation_status: updatedRows?.[0]?.moderation_status ?? "active",
        });
        })(),
        timeoutMs
      ),
      { routeKey: "/api/admin/upload/complete" }
    );
  } catch (e: unknown) {
    const msg = errorMessage(e) || "server_error";
    const code = sqlErrorCode(e);
    const missingColumn = extractMissingColumn(msg);
    const authCode = authErrorCode(e);
    if (authCode === "UNAUTHENTICATED") {
      return jsonError("UNAUTHENTICATED", 401, { message: "Sign in to finalize uploads." });
    }
    if (authCode === "FORBIDDEN") {
      return jsonError("FORBIDDEN", 403, { message: "You do not have permission to finalize this upload." });
    }
    if (authCode === "MFA_REQUIRED") {
      return jsonError("MFA_REQUIRED", 403, { message: "Complete MFA to finalize uploads." });
    }
    if (deps.isRuntimeEnvError(e)) {
      await deps.logDbErrorEvent({
        scope: "upload_complete",
        message: "runtime_env_error",
        ip: deps.clientIpKey(req).ip,
        meta: { route: "/api/admin/upload/complete", stage, code: "RUNTIME_ENV_ERROR" },
      });
      return uploadFinalizeUnavailableWithDeps(deps);
    }
    console.error("upload_complete_failed", {
      stage,
      code,
      message: msg,
    });
    if (deps.isRouteTimeoutError(e)) {
      await deps.logSecurityEvent({
        type: "upload_complete_timeout",
        severity: "high",
        ip: deps.clientIpKey(req).ip,
      scope: "upload_complete",
      message: "Upload completion exceeded timeout",
      meta: { timeoutMs },
      });
      return deps.jsonError("UPLOAD_FINALIZE_TIMEOUT", 504);
    }
    if (code === "42703" || missingColumn) {
      await deps.logDbErrorEvent({
        scope: "upload_complete",
        message: msg,
        ip: deps.clientIpKey(req).ip,
        meta: { route: "/api/admin/upload/complete", stage, code: code || "42703", missingColumn },
      });
      return uploadFinalizeUnavailableWithDeps(deps);
    }
    if (code === "42P01") {
      await deps.logDbErrorEvent({
        scope: "upload_complete",
        message: msg,
        ip: deps.clientIpKey(req).ip,
        meta: { route: "/api/admin/upload/complete", stage, code },
      });
      return uploadFinalizeUnavailableWithDeps(deps);
    }
    await deps.logDbErrorEvent({
      scope: "upload_complete",
      message: msg,
      ip: deps.clientIpKey(req).ip,
      meta: { route: "/api/admin/upload/complete", stage, code },
    });
    return deps.jsonError("UPLOAD_FINALIZE_FAILED", 500, { message: "Unable to finalize upload." });
  }
}

export async function POST(req: NextRequest) {
  return postUploadCompleteRoute(req);
}
