// src/app/s/[token]/actions.ts
"use server";

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { getHashingSalt, readEnvInt } from "@/lib/envConfig";
import { resolveShareGateMeta } from "@/lib/shareGateMeta";
import { rateLimit, stableHash } from "@/lib/rateLimit";
import { normalizeExactPasswordInput } from "@/lib/password";

const UNLOCK_HOURS = 8;
const RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_PER_10MIN = 25;
const MAX_TOKEN_LEN = 128;
const MAX_PASSWORD_LEN = 256;
const MAX_EMAIL_LEN = 320;
// Accept current generated tokens (hex/uuid) and older/manual safe tokens used in fixtures.
const SHARE_TOKEN_RE = /^(?:[a-f0-9]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9_-]{7,127})$/;

function cleanText(raw: unknown, maxLen: number): string {
    const value = String(raw || "");
    if (/[\r\n\0]/.test(value)) return "";
    const trimmed = value.trim();
    if (trimmed.length > maxLen) return "";
    return trimmed;
}

function readExactPassword(raw: unknown): string {
    return normalizeExactPasswordInput(raw, MAX_PASSWORD_LEN) ?? "";
}

function isShareToken(value: string): boolean {
    return SHARE_TOKEN_RE.test(String(value || "").trim());
}

function cookieName(token: string) {
    return `share_unlock_${token}`;
}

function emailCookieName(token: string) {
    return `share_email_${token}`;
}

function randomId() {
    return crypto.randomBytes(24).toString("base64url");
}

function isExpired(expires_at: string | null) {
    if (!expires_at) return false;
    const t = new Date(expires_at).getTime();
    return Number.isFinite(t) && t <= Date.now();
}

function isMaxed(view_count: number, max_views: number | null) {
    if (max_views === null) return false;
    if (max_views === 0) return false; // 0 = unlimited
    return view_count >= max_views;
}

async function getClientIpFromHeaders(readHeaders: typeof headers = headers): Promise<string> {
    const h = await readHeaders();
    const xff = h.get("x-forwarded-for") || "";
    return xff.split(",")[0]?.trim() || "";
}

function hashIp(ip: string) {
    const salt = getHashingSalt("VIEW_SALT", ["SHARE_SALT"]) || "";
    if (!salt || !ip) return null;
    return crypto.createHmac("sha256", salt).update(ip).digest("hex").slice(0, 32);
}

export type SharePasswordActionDeps = {
    sql: typeof sql;
    resolveShareGateMeta: typeof resolveShareGateMeta;
    rateLimit: typeof rateLimit;
    stableHash: typeof stableHash;
    cookies: typeof cookies;
    headers: typeof headers;
    bcryptCompare: typeof bcrypt.compare;
    redirect: typeof redirect;
};

const defaultSharePasswordActionDeps: SharePasswordActionDeps = {
    sql,
    resolveShareGateMeta,
    rateLimit,
    stableHash,
    cookies,
    headers,
    bcryptCompare: bcrypt.compare,
    redirect,
};

export async function isShareUnlockedAction(token: string): Promise<boolean> {
    const safeToken = cleanText(token, MAX_TOKEN_LEN);
    if (!safeToken || !isShareToken(safeToken)) return false;

    const c = await cookies();
    const unlockId = c.get(cookieName(safeToken))?.value || "";
    if (!unlockId) return false;

    const rows = (await sql`
    select 1
    from public.share_unlocks
    where token = ${safeToken}
      and unlock_id = ${unlockId}
      and expires_at > now()
    limit 1
  `) as unknown as Array<{ "?column?": number }>;

    return rows.length > 0;
}

async function throttlePasswordAttempts(
  args: { token: string; ip: string },
  deps: Pick<SharePasswordActionDeps, "rateLimit" | "stableHash">
): Promise<
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; message: string }
> {
  const ipKey = deps.stableHash(args.ip, "VIEW_SALT");
  const tokenKey = deps.stableHash(args.token, "VIEW_SALT");
  const id = `${tokenKey}:${ipKey}`;

  // Fast bucket (burst)
  const rl1 = await deps.rateLimit({
    scope: "pw:share:1m",
    id,
    limit: readEnvInt("RATE_LIMIT_PW_PER_MIN", RATE_LIMIT_PER_MIN, { min: 1 }),
    windowSeconds: 60,
    failClosed: true,
  });
  if (!rl1.ok) {
    return { ok: false, retryAfterSeconds: rl1.resetSeconds, message: "Too many attempts. Try again soon." };
  }

  // Slow bucket (sustained brute force)
  const rl2 = await deps.rateLimit({
    scope: "pw:share:10m",
    id,
    limit: readEnvInt("RATE_LIMIT_PW_PER_10MIN", RATE_LIMIT_PER_10MIN, { min: 1 }),
    windowSeconds: 600,
    failClosed: true,
  });
  if (!rl2.ok) {
    return { ok: false, retryAfterSeconds: rl2.resetSeconds, message: "Too many attempts. Please wait a bit and try again." };
  }

  return { ok: true };
}

type VerifySharePasswordResult =
    | { ok: true }
    | {
        ok: false;
        error:
        | "not_found"
        | "revoked"
        | "expired"
        | "maxed"
        | "rate_limited"
        | "bad_password";
        message: string;
    };

/**
 * Core verifier that returns a structured result.
 */
export async function verifySharePasswordCoreWithDeps(
    formData: FormData,
    deps: SharePasswordActionDeps = defaultSharePasswordActionDeps
): Promise<VerifySharePasswordResult> {
    const token = cleanText(formData.get("token"), MAX_TOKEN_LEN);
    const password = readExactPassword(formData.get("password"));
    const emailInput = cleanText(formData.get("email"), MAX_EMAIL_LEN).toLowerCase();

    if (!token || !isShareToken(token)) return { ok: false, error: "not_found", message: "Missing token." };

    const share = await deps.resolveShareGateMeta(token);
    if (!share.ok) return { ok: false, error: "not_found", message: "Share not found." };

    // Recipient restriction (forward protection)
    if (share.toEmail) {
        const required = String(share.toEmail || "").trim().toLowerCase();
        if (!emailInput) {
            return {
                ok: false,
                error: "bad_password",
                message: "Enter the recipient email for this share.",
            };
        }
        if (emailInput !== required) {
            return {
                ok: false,
                error: "bad_password",
                message: "That email doesn’t match the recipient for this share.",
            };
        }
    }

    if (share.revokedAt) return { ok: false, error: "revoked", message: "This share was revoked." };
    if (isExpired(share.expiresAt)) return { ok: false, error: "expired", message: "This share link has expired." };
    if (isMaxed(share.viewCount, share.maxViews))
        return { ok: false, error: "maxed", message: "This share link has reached its max views." };

    const passwordHash = share.passwordHash;

    // No password set → unlock immediately (still creates DB unlock session + cookie)
    if (!passwordHash) {
        const unlockId = randomId();
        const expiresAt = new Date(Date.now() + UNLOCK_HOURS * 3600 * 1000);

        await deps.sql`
      insert into public.share_unlocks (token, unlock_id, ip_hash, expires_at)
      values (${token}, ${unlockId}, ${null}, ${expiresAt.toISOString()})
    `;

        const c = await deps.cookies();
        c.set(cookieName(token), unlockId, {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: `/s/${token}`,
            maxAge: UNLOCK_HOURS * 3600,
        });

        // Store email used (if any) so /raw can audit it.
        if (share.toEmail) {
            c.set(emailCookieName(token), String(share.toEmail).trim().toLowerCase(), {
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                path: `/s/${token}`,
                maxAge: UNLOCK_HOURS * 3600,
            });
        }

        return { ok: true };
    }

    // Rate limit (best-effort)
    try {
        const ip = await getClientIpFromHeaders(deps.headers);
        const ipHash = hashIp(ip) || "unknown";

        const thr = await throttlePasswordAttempts({ token, ip }, deps);
        if (!thr.ok) return { ok: false, error: "rate_limited", message: thr.message };

        // Keep old table (if present) for admin debugging / history.
        await deps.sql`
          insert into public.share_pw_attempts (token, ip_hash)
          values (${token}, ${ipHash})
        `;
    } catch {
        return { ok: false, error: "rate_limited", message: "Password verification is temporarily unavailable." };
    }

    const match = await deps.bcryptCompare(password, passwordHash);
    if (!match) return { ok: false, error: "bad_password", message: "Incorrect password." };

    const unlockId = randomId();
    const expiresAt = new Date(Date.now() + UNLOCK_HOURS * 3600 * 1000);

    await deps.sql`
    insert into public.share_unlocks (token, unlock_id, ip_hash, expires_at)
    values (${token}, ${unlockId}, ${null}, ${expiresAt.toISOString()})
  `;

    const c = await deps.cookies();
    c.set(cookieName(token), unlockId, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: `/s/${token}`,
        maxAge: UNLOCK_HOURS * 3600,
    });

    if (share.toEmail) {
        c.set(emailCookieName(token), String(share.toEmail).trim().toLowerCase(), {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: `/s/${token}`,
            maxAge: UNLOCK_HOURS * 3600,
        });
    }

    return { ok: true };
}

export async function verifySharePasswordCore(
    formData: FormData
): Promise<VerifySharePasswordResult> {
    return verifySharePasswordCoreWithDeps(formData);
}

/**
 * Use THIS for <form action={...}>.
 * Must return void/Promise<void>. Redirects instead of returning data.
 */
export async function verifySharePasswordAction(formData: FormData): Promise<void> {
    const token = cleanText(formData.get("token"), MAX_TOKEN_LEN);
    const res = await verifySharePasswordCoreWithDeps(formData);

    if (res.ok) {
        defaultSharePasswordActionDeps.redirect(`/s/${encodeURIComponent(token)}/view`);
    }

    defaultSharePasswordActionDeps.redirect(`/s/${encodeURIComponent(token)}?error=${encodeURIComponent(res.message)}`);
}

/**
 * Use THIS from client components (like passwordGate.tsx).
 * Returns a result object; does NOT redirect.
 */
export async function verifySharePasswordResultAction(
    formData: FormData
): Promise<VerifySharePasswordResult> {
    return verifySharePasswordCoreWithDeps(formData);
}
