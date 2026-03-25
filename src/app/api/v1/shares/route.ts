export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { verifyApiKeyFromRequest } from "@/lib/apiAuth";
import { emitWebhook } from "@/lib/webhooks";
import { assertCanCreateShare, getPlanForUser, normalizeExpiresAtForPlan, normalizeMaxViewsForPlan } from "@/lib/monetization";
import crypto from "crypto";
import { clientIpKey, enforceGlobalApiRateLimit } from "@/lib/securityTelemetry";
import { appendImmutableAudit } from "@/lib/immutableAudit";
import { resolvePublicAppBaseUrl } from "@/lib/publicBaseUrl";
import { DEFAULT_SHARE_SETTINGS, PRO_PACK_UPSELL_MESSAGE, applyPack, getPackById, isPackAvailableForPlan } from "@/lib/packs";
import { getShareEligibility } from "@/lib/documentStatus";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { withRequestTelemetry } from "@/lib/perfTelemetry";
import { MAX_SHARE_PASSWORD_LEN, parseOptionalExactPasswordInput } from "@/lib/password";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SHARE_BODY_BYTES = 64 * 1024;
const MAX_TO_EMAIL_LEN = 320;
const MAX_COUNTRY_ITEMS = 64;
const MAX_WATERMARK_TEXT_LEN = 400;
const MAX_PACK_ID_LEN = 64;
const MAX_ISO_LEN = 64;
const MAX_MAX_VIEWS = 1_000_000;

function newToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

function isUuid(value: string): boolean {
  return UUID_RE.test(String(value || "").trim());
}

function parseJsonBodyLength(req: NextRequest): number {
  const raw = String(req.headers.get("content-length") || "").trim();
  const out = Number(raw);
  return Number.isFinite(out) ? Math.max(0, Math.floor(out)) : 0;
}

function parseOptionalEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > MAX_TO_EMAIL_LEN || /[\r\n\0]/.test(email)) return null;
  return BASIC_EMAIL_RE.test(email) ? email : null;
}

function parseSharePassword(value: unknown): string | null | "INVALID" {
  return parseOptionalExactPasswordInput(value, MAX_SHARE_PASSWORD_LEN);
}

export async function POST(req: NextRequest) {
  const ipInfo = clientIpKey(req);
  const timeoutMs = getRouteTimeoutMs("ROUTE_TIMEOUT_API_V1_SHARES_MS", 20_000);
  try {
    return await withRequestTelemetry(
      req,
      () => withRouteTimeout(
        (async () => {
        if (parseJsonBodyLength(req) > MAX_SHARE_BODY_BYTES) {
          return NextResponse.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
        }

        const rl = await enforceGlobalApiRateLimit({
          req,
          scope: "ip:api",
          limit: Number(process.env.RATE_LIMIT_API_IP_PER_MIN || 240),
          windowSeconds: 60,
          strict: true,
        });
        if (!rl.ok) {
          return NextResponse.json(
            { ok: false, error: "RATE_LIMIT" },
            { status: rl.status, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
          );
        }

        const auth = await verifyApiKeyFromRequest(req);
        if (!auth.ok) {
          return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
        }

        let body: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = await req.json();
          body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
        }
        if (!body) {
          return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
        }

  const docId = String(body?.doc_id || body?.docId || "").trim();
  if (!docId) return NextResponse.json({ ok: false, error: "MISSING_DOC_ID" }, { status: 400 });
  if (!isUuid(docId)) return NextResponse.json({ ok: false, error: "INVALID_DOC_ID" }, { status: 400 });

  const docRows = (await sql`
    select
      owner_id::text as owner_id,
      coalesce(status::text, 'ready') as doc_state,
      coalesce(scan_status::text, 'unscanned') as scan_state,
      coalesce(moderation_status::text, 'active') as moderation_status
    from public.docs
    where id = ${docId}::uuid
    limit 1
  `) as unknown as Array<{
    owner_id: string | null;
    doc_state: string;
    scan_state: string;
    moderation_status: string;
  }>;
  const docRow = docRows?.[0];
  if (!docRow || docRow.owner_id !== auth.ownerId) {
    return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
  }

  const shareEligibility = getShareEligibility({
    docStateRaw: docRow.doc_state,
    scanStateRaw: docRow.scan_state,
    moderationStatusRaw: docRow.moderation_status,
  });
  if (!shareEligibility.canCreateLink) {
    return NextResponse.json(
      { ok: false, error: "SHARE_BLOCKED", message: shareEligibility.blockedReason || "Document cannot be shared yet." },
      { status: 409 }
    );
  }

  // --- Monetization / plan limits (hidden) ---
  const shareAllowed = await assertCanCreateShare(auth.ownerId);
  if (!shareAllowed.ok) {
    return NextResponse.json(
      { ok: false, error: "PAYMENT_REQUIRED", message: shareAllowed.message || "Upgrade required for more active shares." },
      { status: 402 }
    );
  }
  const plan = await getPlanForUser(auth.ownerId);

  const rawEmailInput = body?.to_email ?? body?.toEmail ?? "";
  const toEmail = parseOptionalEmail(rawEmailInput);
  if (String(rawEmailInput || "").trim() && !toEmail) {
    return NextResponse.json({ ok: false, error: "INVALID_TO_EMAIL" }, { status: 400 });
  }

  const passwordRaw = parseSharePassword(body?.password);
  if (passwordRaw === "INVALID") {
    return NextResponse.json({ ok: false, error: "INVALID_PASSWORD" }, { status: 400 });
  }
  const passwordHash = passwordRaw ? await bcrypt.hash(passwordRaw, 12) : null;

  const allowedCountriesRaw = body?.allowed_countries ?? body?.allowedCountries ?? null;
  const blockedCountriesRaw = body?.blocked_countries ?? body?.blockedCountries ?? null;

  const normCountries = (v: unknown): string[] | null => {
    if (v == null) return null;
    const raw = String(v ?? "");
    if (raw.length > 4096 || /[\r\n\0]/.test(raw)) return [];
    const arr = Array.isArray(v) ? v : raw.split(/[,\s]+/g);
    const out = arr
      .map((x) => String(x || "").trim().toUpperCase())
      .filter((x) => /^[A-Z]{2}$/.test(x))
      .slice(0, MAX_COUNTRY_ITEMS);
    return out.length ? Array.from(new Set(out)) : [];
  };

  const allowedCountries = normCountries(allowedCountriesRaw);
  const blockedCountries = normCountries(blockedCountriesRaw);

  const overrides =
    body?.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
      ? (body.overrides as Record<string, unknown>)
      : null;

  const parseOptionalBoolean = (v: unknown): boolean | null => {
    if (v == null) return null;
    const input = String(v);
    if (/[\r\n\0]/.test(input)) return null;
    const raw = input.trim().toLowerCase();
    if (!raw) return null;
    if (["1", "true", "on", "yes"].includes(raw)) return true;
    if (["0", "false", "off", "no"].includes(raw)) return false;
    return null;
  };

  const parseOptionalIso = (v: unknown): string | null => {
    const raw = String(v ?? "").trim();
    if (raw.length > MAX_ISO_LEN || /[\r\n\0]/.test(raw)) return null;
    if (!raw) return null;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString();
  };

  const parseOptionalMaxViews = (v: unknown): number | null => {
    const raw = String(v ?? "").trim();
    if (!raw || raw.length > 16 || /[\r\n\0]/.test(raw)) return null;
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(MAX_MAX_VIEWS, Math.floor(n)));
  };

  const packInput = String(body?.pack_id ?? body?.packId ?? "").trim();
  const safePackInput = /[\r\n\0]/.test(packInput) ? "" : packInput.slice(0, MAX_PACK_ID_LEN);
  const selectedPack = getPackById(safePackInput);
  if (!isPackAvailableForPlan(selectedPack, plan.id)) {
    return NextResponse.json(
      { ok: false, error: "PACK_REQUIRES_PRO", message: PRO_PACK_UPSELL_MESSAGE },
      { status: 402 }
    );
  }
  let resolvedSettings = applyPack(DEFAULT_SHARE_SETTINGS, selectedPack.id);

  const expiresFieldPresent =
    (overrides ? ("expires_at" in overrides || "expiresAt" in overrides) : false) ||
    body?.expires_at !== undefined ||
    body?.expiresAt !== undefined;
  const maxViewsFieldPresent =
    (overrides ? ("max_views" in overrides || "maxViews" in overrides) : false) ||
    body?.max_views !== undefined ||
    body?.maxViews !== undefined;

  const expiresOverrideRaw = overrides?.expires_at ?? overrides?.expiresAt ?? body?.expires_at ?? body?.expiresAt;
  if (expiresFieldPresent) {
    resolvedSettings = {
      ...resolvedSettings,
      expiresAt: parseOptionalIso(expiresOverrideRaw),
      expiresInSeconds: null,
    };
  }

  const maxViewsOverrideRaw = overrides?.max_views ?? overrides?.maxViews ?? body?.max_views ?? body?.maxViews;
  if (maxViewsFieldPresent) {
    resolvedSettings = {
      ...resolvedSettings,
      maxViews: parseOptionalMaxViews(maxViewsOverrideRaw),
    };
  }

  const allowDownloadOverride =
    parseOptionalBoolean(overrides?.allow_download ?? overrides?.allowDownload ?? body?.allow_download ?? body?.allowDownload);
  if (allowDownloadOverride != null) {
    resolvedSettings = { ...resolvedSettings, allowDownload: allowDownloadOverride };
  }

  const watermarkEnabledOverride =
    parseOptionalBoolean(overrides?.watermark_enabled ?? overrides?.watermarkEnabled ?? body?.watermark_enabled ?? body?.watermarkEnabled);
  if (watermarkEnabledOverride != null) {
    resolvedSettings = { ...resolvedSettings, watermarkEnabled: watermarkEnabledOverride };
  }

  let normalizedExpiresAt = resolvedSettings.expiresAt;
  const requestedMaxViews = resolvedSettings.maxViews;
  let maxViews = requestedMaxViews;
  const allowDownload = resolvedSettings.allowDownload;
  const watermarkEnabled = resolvedSettings.watermarkEnabled;

  const planExpiresAt = normalizeExpiresAtForPlan({
    plan,
    requestedExpiresAtIso: normalizedExpiresAt,
    defaultDaysIfNotAllowed: 7,
  });
  const planMaxViews = normalizeMaxViewsForPlan({ plan, requestedMaxViews });
  const adjustedForPlan =
    planExpiresAt !== normalizedExpiresAt ||
    planMaxViews !== maxViews;
  normalizedExpiresAt = planExpiresAt;
  maxViews = planMaxViews;

  const watermarkTextRaw = String(body?.watermark_text ?? body?.watermarkText ?? "");
  const watermarkTextClean = watermarkTextRaw.replace(/[\r\n]+/g, " ").trim();
  const watermarkText = watermarkTextClean && !/[\0]/.test(watermarkTextClean)
    ? watermarkTextClean.slice(0, MAX_WATERMARK_TEXT_LEN)
    : null;

  const token = newToken();
  // Newer schema supports geo + watermark columns; fall back silently if not present.
  try {
    await sql`
      insert into public.share_tokens
        (token, doc_id, to_email, expires_at, max_views, password_hash, allow_download, allowed_countries, blocked_countries, watermark_enabled, watermark_text, pack_id, pack_version)
      values
        (${token}, ${docId}::uuid, ${toEmail}, ${normalizedExpiresAt}, ${maxViews}, ${passwordHash}, ${allowDownload}, ${allowedCountries}, ${blockedCountries}, ${watermarkEnabled}, ${watermarkText}, ${selectedPack.id}, ${selectedPack.version})
    `;
  } catch {
    try {
      await sql`
        insert into public.share_tokens
          (token, doc_id, to_email, expires_at, max_views, password_hash, allow_download, allowed_countries, blocked_countries, watermark_enabled, watermark_text)
        values
          (${token}, ${docId}::uuid, ${toEmail}, ${normalizedExpiresAt}, ${maxViews}, ${passwordHash}, ${allowDownload}, ${allowedCountries}, ${blockedCountries}, ${watermarkEnabled}, ${watermarkText})
      `;
    } catch {
      await sql`
        insert into public.share_tokens (token, doc_id, to_email, expires_at, max_views, password_hash)
        values (${token}, ${docId}::uuid, ${toEmail}, ${normalizedExpiresAt}, ${maxViews}, ${passwordHash})
      `;
    }
  }

  let base: string;
  try {
    base = resolvePublicAppBaseUrl(req.url);
  } catch {
    return NextResponse.json({ ok: false, error: "ENV_MISCONFIGURED" }, { status: 500 });
  }
  const url = `${base}/s/${token}`;

  emitWebhook("share.created", {
    token,
    doc_id: docId,
    to_email: toEmail,
    expires_at: normalizedExpiresAt,
    max_views: maxViews,
    has_password: !!passwordHash,
    allow_download: allowDownload,
    watermark_enabled: watermarkEnabled,
    pack_id: selectedPack.id,
    pack_version: selectedPack.version,
    created_via: "api",
  });

  await appendImmutableAudit({
    streamKey: `doc:${docId}`,
    action: "share.create",
    actorUserId: auth.ownerId,
    docId,
    subjectId: token,
    ipHash: ipInfo.ipHash,
    payload: {
      toEmail,
      expiresAt: normalizedExpiresAt,
      maxViews,
      hasPassword: Boolean(passwordHash),
      allowDownload,
      allowedCountries,
      blockedCountries,
      watermarkEnabled,
      watermarkText: watermarkText ?? null,
      packId: selectedPack.id,
      packVersion: selectedPack.version,
      adjustedForPlan,
      via: "api",
    },
  });

        return NextResponse.json({
          ok: true,
          token,
          url,
          pack_id: selectedPack.id,
          pack_version: selectedPack.version,
          adjusted_for_plan: adjustedForPlan,
        });
        })(),
        timeoutMs
      ),
      { routeKey: "/api/v1/shares" }
    );
  } catch (e: unknown) {
    if (isRouteTimeoutError(e)) {
      return NextResponse.json({ ok: false, error: "TIMEOUT" }, { status: 504 });
    }
    return NextResponse.json({ ok: false, error: "SERVER_ERROR" }, { status: 500 });
  }
}
