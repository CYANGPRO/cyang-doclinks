// src/app/d/[alias]/actions.ts
"use server";

import { sql } from "@/lib/db";
import { requireDocWrite } from "@/lib/authz";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { emitWebhook } from "@/lib/webhooks";
import { assertCanCreateShare, getPlanForUser, normalizeExpiresAtForPlan, normalizeMaxViewsForPlan } from "@/lib/monetization";
import { resolveConfiguredPublicAppBaseUrl } from "@/lib/publicBaseUrl";
import { DEFAULT_SHARE_SETTINGS, PRO_PACK_UPSELL_MESSAGE, applyPack, getPackById, isPackAvailableForPlan } from "@/lib/packs";
import { getShareEligibility } from "@/lib/documentStatus";
import { sendHtmlEmail } from "@/lib/email";
import { MAX_SHARE_PASSWORD_LEN, normalizeExactPasswordInput, passwordCharLength } from "@/lib/password";

/**
 * NOTE:
 * SharePanel synthesizes a ShareRow immediately after creating a token,
 * before it can hydrate real stats from the DB. For that reason `doc_id`
 * is optional here.
 */
export type ShareRow = {
  token: string;
  doc_id?: string;
  to_email: string | null;
  created_at: string;
  expires_at: string | null;
  max_views: number | null;
  view_count: number | null;
  revoked_at: string | null;
  last_viewed_at: string | null;
  pack_id?: string | null;
  pack_version?: number | null;
};

export type CreateShareResult =
  | { ok: true; token: string; url: string; packId: string; packVersion: number; adjustedForPlan: boolean }
  | { ok: false; error: string; message?: string };

export type ShareStatsResult =
  | { ok: true; row: ShareRow }
  | { ok: false; error: string; message?: string };

type RevokeShareResult =
  | { ok: true; token: string }
  | { ok: false; error: string; message?: string };

type SendShareEmailResult =
  | { ok: true }
  | { ok: false; error: string; message?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_TOKEN_RE =
  /^(?:[a-f0-9]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_DOC_ID_LEN = 64;
const MAX_ALIAS_LEN = 160;
const MAX_TOKEN_LEN = 128;
const MAX_EMAIL_LEN = 320;
const MAX_PACK_ID_LEN = 64;
const MAX_DATE_OVERRIDE_LEN = 64;
const MAX_COUNTRY_FIELD_LEN = 2048;
const MAX_SHARE_TITLE_LEN = 240;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readFormText(formData: FormData, key: string, maxLen: number): string {
  const raw = String(formData.get(key) || "");
  if (/[\r\n\0]/.test(raw)) return "";
  const value = raw.trim();
  if (value.length > maxLen) return "";
  return value;
}

function readExactPasswordField(formData: FormData, key: string, maxLen: number): string {
  const raw = String(formData.get(key) || "");
  if (passwordCharLength(raw) > maxLen || /[\u0000-\u001F\u007F]/u.test(raw)) return "";
  return raw;
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

function isUuid(value: string): boolean {
  return UUID_RE.test(String(value || "").trim());
}

function isShareToken(value: string): boolean {
  return SHARE_TOKEN_RE.test(String(value || "").trim());
}

function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(String(value || "").trim().toLowerCase());
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function baseUrlFromEnv(): string {
  return resolveConfiguredPublicAppBaseUrl();
}

function buildShareUrl(token: string): string {
  // IMPORTANT: link users to /s/<token> (NOT /raw) so they hit the gate UI.
  const base = baseUrlFromEnv().replace(/\/+$/, "");
  return `${base}/s/${token}`;
}

export async function sendShareLinkEmail(form: FormData): Promise<SendShareEmailResult> {
  try {
    const token = readFormText(form, "token", MAX_TOKEN_LEN).toLowerCase();
    const toEmail = readFormText(form, "toEmail", MAX_EMAIL_LEN).toLowerCase();
    if (!isShareToken(token)) {
      return { ok: false, error: "invalid_token", message: "Invalid share token." };
    }
    if (!isValidEmail(toEmail)) {
      return { ok: false, error: "invalid_email", message: "Enter a valid recipient email." };
    }

    let rows: Array<{
      doc_id: string;
      title: string | null;
      restricted_email: string | null;
      password_hash: string | null;
      expires_at: string | null;
      revoked_at: string | null;
    }> = [];

    try {
      rows = (await sql`
        select
          st.doc_id::text as doc_id,
          d.title::text as title,
          st.to_email::text as restricted_email,
          st.password_hash::text as password_hash,
          st.expires_at::text as expires_at,
          st.revoked_at::text as revoked_at
        from public.share_tokens st
        left join public.docs d on d.id = st.doc_id
        where st.token = ${token}
        limit 1
      `) as unknown as typeof rows;
    } catch {
      rows = (await sql`
        select
          st.doc_id::text as doc_id,
          d.title::text as title,
          st.to_email::text as restricted_email,
          null::text as password_hash,
          st.expires_at::text as expires_at,
          st.revoked_at::text as revoked_at
        from public.share_tokens st
        left join public.docs d on d.id = st.doc_id
        where st.token = ${token}
        limit 1
      `) as unknown as typeof rows;
    }

    const row = rows[0];
    if (!row?.doc_id) {
      return { ok: false, error: "not_found", message: "Share link not found." };
    }

    await requireDocWrite(row.doc_id);

    if (row.revoked_at) {
      return { ok: false, error: "revoked", message: "This link is revoked." };
    }
    if (row.expires_at) {
      const expiresAtMs = Date.parse(row.expires_at);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        return { ok: false, error: "expired", message: "This link is already expired." };
      }
    }

    const url = buildShareUrl(token);
    const title = row.title?.trim() || "Document";
    const gates: string[] = [];
    if (row.restricted_email) {
      gates.push(`Recipient restriction: <b>${escapeHtml(row.restricted_email)}</b>`);
    }
    if (row.password_hash) {
      gates.push("Password required");
    }

    const html = `
      <div style="font-family: ui-sans-serif, system-ui; line-height:1.45;">
        <h2 style="margin:0 0 10px 0;">${escapeHtml(title)}</h2>
        <p style="margin:0 0 10px 0;">A protected document link has been shared with you.</p>
        <p style="margin:0 0 10px 0;">${gates.length ? `Access rules: ${gates.join(" · ")}` : "Access rules: standard protected link"}</p>
        <p style="margin:12px 0;">
          <a href="${url}" style="display:inline-block;padding:10px 14px;border-radius:10px;text-decoration:none;border:1px solid #ddd;">
            Open document
          </a>
        </p>
        <p style="color:#666;font-size:12px;margin:12px 0 0 0;">If you did not expect this link, you can ignore this email.</p>
      </div>
    `;

    try {
      await sendHtmlEmail({
        to: toEmail,
        subject: `Cyang Docs: ${title}`,
        html,
        tags: [
          { name: "template", value: "share_link_manual" },
          { name: "channel", value: "document_share" },
        ],
      });
    } catch {
      return { ok: false, error: "email_failed", message: "Failed to send email" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "exception", message: "Unable to send email." };
  }
}

export async function createAndEmailShareToken(
  form: FormData
): Promise<CreateShareResult> {
  try {
    const docId = readFormText(form, "docId", MAX_DOC_ID_LEN);
    const alias = readFormText(form, "alias", MAX_ALIAS_LEN);
    const shareTitleRaw = readFormText(form, "shareTitle", MAX_SHARE_TITLE_LEN);
    const shareTitle = shareTitleRaw ? shareTitleRaw.slice(0, MAX_SHARE_TITLE_LEN) : null;
    const toEmailRaw = readFormText(form, "toEmail", MAX_EMAIL_LEN);
    const passwordRaw = readExactPasswordField(form, "password", MAX_SHARE_PASSWORD_LEN);
    const selectedPackRaw = readFormText(form, "packId", MAX_PACK_ID_LEN);
    const selectedPack = getPackById(selectedPackRaw);

    const parseOptionalBoolean = (raw: string): boolean | null => {
      const v = raw.trim().toLowerCase();
      if (!v) return null;
      if (["1", "true", "on", "yes"].includes(v)) return true;
      if (["0", "false", "off", "no"].includes(v)) return false;
      return null;
    };

    const parseOptionalIso = (raw: string): string | null => {
      const v = raw.trim();
      if (!v) return null;
      const t = Date.parse(v);
      if (Number.isNaN(t)) return null;
      return new Date(t).toISOString();
    };

    const parseOptionalMaxViews = (raw: string): number | null => {
      const v = raw.trim();
      if (!v) return null;
      if (!/^\d+$/.test(v)) return null;
      return Number(v);
    };

    const overrideExpiresAtRaw = String(form.get("overrideExpiresAt") ?? form.get("expiresAt") ?? "")
      .trim()
      .slice(0, MAX_DATE_OVERRIDE_LEN);
    const overrideMaxViewsRaw = String(form.get("overrideMaxViews") ?? form.get("maxViews") ?? "")
      .trim()
      .slice(0, 16);
    const overrideAllowDownloadRaw = String(form.get("overrideAllowDownload") ?? form.get("allowDownload") ?? "")
      .trim()
      .slice(0, 16);
    const overrideWatermarkEnabledRaw = String(form.get("overrideWatermarkEnabled") ?? form.get("watermarkEnabled") ?? "")
      .trim()
      .slice(0, 16);

    const allowedCountriesRaw = readFormText(form, "allowedCountries", MAX_COUNTRY_FIELD_LEN)
      || readFormText(form, "allowed_countries", MAX_COUNTRY_FIELD_LEN);
    const blockedCountriesRaw = readFormText(form, "blockedCountries", MAX_COUNTRY_FIELD_LEN)
      || readFormText(form, "blocked_countries", MAX_COUNTRY_FIELD_LEN);

    if (!docId)
      return { ok: false, error: "bad_request", message: "Missing docId" };
    if (!isUuid(docId))
      return { ok: false, error: "invalid_doc_id", message: "Invalid docId" };

    await requireDocWrite(docId);

    const toEmail = toEmailRaw ? toEmailRaw.toLowerCase() : null;

    let resolvedSettings = applyPack(DEFAULT_SHARE_SETTINGS, selectedPack.id);

    if (form.has("overrideExpiresAt") || form.has("expiresAt")) {
      const parsedExpiresAt = parseOptionalIso(overrideExpiresAtRaw);
      resolvedSettings = {
        ...resolvedSettings,
        expiresAt: parsedExpiresAt,
        expiresInSeconds: null,
      };
    }

    if (form.has("overrideMaxViews") || form.has("maxViews")) {
      resolvedSettings = {
        ...resolvedSettings,
        maxViews: parseOptionalMaxViews(overrideMaxViewsRaw),
      };
    }

    const overrideAllowDownload = parseOptionalBoolean(overrideAllowDownloadRaw);
    if (overrideAllowDownload != null) {
      resolvedSettings = { ...resolvedSettings, allowDownload: overrideAllowDownload };
    }

    const overrideWatermarkEnabled = parseOptionalBoolean(overrideWatermarkEnabledRaw);
    if (overrideWatermarkEnabled != null) {
      resolvedSettings = { ...resolvedSettings, watermarkEnabled: overrideWatermarkEnabled };
    }

    let expiresAt = resolvedSettings.expiresAt;
    const requestedMaxViews = resolvedSettings.maxViews;
    let maxViews: number | null = requestedMaxViews;
    const allowDownload = resolvedSettings.allowDownload;
    const watermarkEnabled = resolvedSettings.watermarkEnabled;

    const password = normalizeExactPasswordInput(passwordRaw, MAX_SHARE_PASSWORD_LEN) ?? "";
    if (passwordRaw && !password) {
      return { ok: false, error: "INVALID_PASSWORD", message: "Password contains unsupported characters or is too long." };
    }
    if (password && passwordCharLength(password) < 4) {
      return { ok: false, error: "INVALID_PASSWORD", message: "Password must be at least 4 characters." };
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const parseCountries = (raw: string): string[] | null => {
      if (!raw) return null;
      const out = raw
        .split(/[,\s]+/g)
        .map((x) => x.trim().toUpperCase())
        .filter((x) => /^[A-Z]{2}$/.test(x));
      return out.length ? out : [];
    };
    const allowedCountries = parseCountries(allowedCountriesRaw);
    const blockedCountries = parseCountries(blockedCountriesRaw);

    const docRows = (await sql`
      select
        id::text as id,
        title::text as title,
        owner_id::text as owner_id,
        coalesce(status::text, 'ready') as doc_state,
        coalesce(scan_status::text, 'unscanned') as scan_state,
        coalesce(moderation_status::text, 'active') as moderation_status
      from public.docs
      where id = ${docId}::uuid
      limit 1
    `) as unknown as Array<{
      id: string;
      title: string | null;
      owner_id: string | null;
      doc_state: string;
      scan_state: string;
      moderation_status: string;
    }>;

    if (!docRows || docRows.length === 0) {
      return { ok: false, error: "not_found", message: "Document not found" };
    }
    const shareEligibility = getShareEligibility({
      docStateRaw: docRows[0].doc_state,
      scanStateRaw: docRows[0].scan_state,
      moderationStatusRaw: docRows[0].moderation_status,
    });
    if (!shareEligibility.canCreateLink) {
      return { ok: false, error: "DOC_NOT_SHAREABLE", message: shareEligibility.blockedReason || "Document cannot be shared yet." };
    }


    const ownerId = docRows?.[0]?.owner_id ?? null;
    let ownerPlan: Awaited<ReturnType<typeof getPlanForUser>> | null = null;
    let adjustedForPlan = false;
    if (ownerId) {
      ownerPlan = await getPlanForUser(ownerId);
      const shareAllowed = await assertCanCreateShare(ownerId);
      if (!shareAllowed.ok) {
        return { ok: false, error: shareAllowed.error, message: shareAllowed.message };
      }
    }
    if (ownerPlan && !isPackAvailableForPlan(selectedPack, ownerPlan.id)) {
      return { ok: false, error: "PACK_REQUIRES_PRO", message: PRO_PACK_UPSELL_MESSAGE };
    }

    // Free plan cannot mutate document title from share creation flow.
    if (shareTitle && ownerPlan?.id !== "free") {
      await sql`
        update public.docs
        set title = ${shareTitle}
        where id = ${docId}::uuid
      `;
    }

    // Server-side source of truth:
    // defaults -> pack partial -> client overrides -> tier normalization.
    if (ownerPlan) {
      const normalizedExpiresAt = normalizeExpiresAtForPlan({
        plan: ownerPlan,
        requestedExpiresAtIso: expiresAt,
        defaultDaysIfNotAllowed: 7,
      });
      const normalizedMaxViews = normalizeMaxViewsForPlan({ plan: ownerPlan, requestedMaxViews });
      adjustedForPlan =
        normalizedExpiresAt !== expiresAt ||
        normalizedMaxViews !== maxViews;
      expiresAt = normalizedExpiresAt;
      maxViews = normalizedMaxViews;
    }

    const token = newToken();

    try {
      await sql`
        insert into public.share_tokens
          (token, doc_id, to_email, expires_at, max_views, password_hash, allow_download, allowed_countries, blocked_countries, watermark_enabled, pack_id, pack_version)
        values
          (${token}, ${docId}::uuid, ${toEmail}, ${expiresAt}, ${maxViews}, ${passwordHash}, ${allowDownload}, ${allowedCountries}, ${blockedCountries}, ${watermarkEnabled}, ${selectedPack.id}, ${selectedPack.version})
      `;
    } catch {
      try {
        await sql`
          insert into public.share_tokens
            (token, doc_id, to_email, expires_at, max_views, password_hash, allow_download, allowed_countries, blocked_countries, watermark_enabled)
          values
            (${token}, ${docId}::uuid, ${toEmail}, ${expiresAt}, ${maxViews}, ${passwordHash}, ${allowDownload}, ${allowedCountries}, ${blockedCountries}, ${watermarkEnabled})
        `;
      } catch {
        try {
          await sql`
            insert into public.share_tokens
              (token, doc_id, to_email, expires_at, max_views, password_hash, allow_download, allowed_countries, blocked_countries)
            values
              (${token}, ${docId}::uuid, ${toEmail}, ${expiresAt}, ${maxViews}, ${passwordHash}, ${allowDownload}, ${allowedCountries}, ${blockedCountries})
          `;
        } catch {
          // Backward compatibility for older schema versions.
          await sql`
            insert into public.share_tokens (token, doc_id, to_email, expires_at, max_views, password_hash)
            values (${token}, ${docId}::uuid, ${toEmail}, ${expiresAt}, ${maxViews}, ${passwordHash})
          `;
        }
      }
    }

    // Webhook (best-effort)
    emitWebhook("share.created", {
      token,
      doc_id: docId,
      alias: alias ?? null,
      to_email: toEmail,
      expires_at: expiresAt,
      max_views: maxViews,
      has_password: !!passwordHash,
      allow_download: allowDownload,
      watermark_enabled: watermarkEnabled,
      pack_id: selectedPack.id,
      pack_version: selectedPack.version,
    });

    const url = buildShareUrl(token);

    // no recipient email → just return
    if (!toEmail) {
      return {
        ok: true,
        token,
        url,
        packId: selectedPack.id,
        packVersion: selectedPack.version,
        adjustedForPlan,
      };
    }

    const title = (ownerPlan?.id === "free" ? null : shareTitle) || docRows[0]?.title || "Document";
    const pretty = alias ? `/d/${alias}` : title;

    const subject = `Cyang Docs: ${title}`;

    const gates: string[] = [];
    gates.push(`Email required: <b>${toEmail}</b>`);
    if (passwordHash) gates.push(`Password required`);

    const html = `
      <div style="font-family: ui-sans-serif, system-ui; line-height:1.4;">
        <h2>${title}</h2>
        <p>You’ve been sent a private link to view: <b>${pretty}</b></p>
        <p>${gates.length ? `Access rules: ${gates.join(" · ")}` : ""}</p>
        <p>
          <a href="${url}" style="display:inline-block;padding:10px 14px;border-radius:10px;text-decoration:none;border:1px solid #ddd;">
            Open document
          </a>
        </p>
        <p style="color:#777;font-size:12px;margin-top:14px;">
          Tip: This link will open a secure gate page first, then load the PDF.
        </p>
      </div>
    `;

    try {
      await sendHtmlEmail({
        to: toEmail,
        subject,
        html,
        tags: [
          { name: "template", value: "share_link_created" },
          { name: "channel", value: "document_share" },
        ],
      });
    } catch {
      // Share creation should still succeed even if email delivery fails.
    }
    return {
      ok: true,
      token,
      url,
      packId: selectedPack.id,
      packVersion: selectedPack.version,
      adjustedForPlan,
    };
  } catch (e: unknown) {
    return { ok: false, error: "exception", message: "Unable to create share." };
  }
}

export async function getShareStatsByToken(
  token: string
): Promise<ShareStatsResult> {
  try {
    const tokenValue = String(token || "").trim().slice(0, MAX_TOKEN_LEN);
    if (!isShareToken(tokenValue)) {
      return { ok: false, error: "invalid_token", message: "Invalid token" };
    }

    let rows: Array<{
      token: string;
      doc_id: string;
      to_email: string | null;
      created_at: string;
      expires_at: string | null;
      max_views: number | null;
      views_count: number | null;
      revoked_at: string | null;
      pack_id: string | null;
      pack_version: number | null;
    }> = [];

    try {
      rows = (await sql`
        select
          token::text as token,
          doc_id::text as doc_id,
          to_email,
          created_at::text as created_at,
          expires_at::text as expires_at,
          max_views,
          views_count,
          revoked_at::text as revoked_at,
          pack_id::text as pack_id,
          pack_version::int as pack_version
        from public.share_tokens
        where token = ${tokenValue}
        limit 1
      `) as unknown as typeof rows;
    } catch {
      rows = (await sql`
        select
          token::text as token,
          doc_id::text as doc_id,
          to_email,
          created_at::text as created_at,
          expires_at::text as expires_at,
          max_views,
          views_count,
          revoked_at::text as revoked_at,
          null::text as pack_id,
          null::int as pack_version
        from public.share_tokens
        where token = ${tokenValue}
        limit 1
      `) as unknown as typeof rows;
    }

    const r = rows[0];
    if (!r) return { ok: false, error: "not_found", message: "Token not found" };

    await requireDocWrite(r.doc_id);

    const row: ShareRow = {
      token: r.token,
      doc_id: r.doc_id,
      to_email: r.to_email,
      created_at: r.created_at,
      expires_at: r.expires_at,
      max_views: r.max_views,
      view_count: r.views_count ?? 0,
      revoked_at: r.revoked_at,
      last_viewed_at: null,
      pack_id: r.pack_id ?? null,
      pack_version: r.pack_version ?? null,
    };

    return { ok: true, row };
  } catch (e: unknown) {
    return { ok: false, error: "exception", message: "Unable to load share stats." };
  }
}

export async function revokeShareToken(
  token: string
): Promise<RevokeShareResult> {
  try {
    const tokenValue = String(token || "").trim().slice(0, MAX_TOKEN_LEN);
    if (!isShareToken(tokenValue)) {
      return { ok: false, error: "invalid_token", message: "Invalid token" };
    }

    // Lookup doc_id first so we can enforce ownership.
    const rows = (await sql`
      select doc_id::text as doc_id
      from public.share_tokens
      where token = ${tokenValue}
      limit 1
    `) as unknown as Array<{ doc_id: string }>;

    const docId = rows?.[0]?.doc_id ?? null;
    if (!docId) return { ok: false, error: "not_found", message: "Token not found" };

    await requireDocWrite(docId);

    await sql`
      update public.share_tokens
      set revoked_at = now()
      where token = ${tokenValue}
    `;

    return { ok: true, token: tokenValue };
  } catch (e: unknown) {
    return { ok: false, error: "exception", message: "Unable to revoke share." };
  }
}
