// src/app/d/[alias]/unlockActions.ts
"use server";

import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { sql } from "@/lib/db";
import {
    DEVICE_TRUST_HOURS,
    aliasTrustCookieName,
    isAliasTrusted,
    makeAliasTrustCookieValue,
} from "@/lib/deviceTrust";
import { deviceHashFrom, getClientIpFromHeaders, getUserAgentFromHeaders, isDeviceTrustedForDoc, trustDeviceForDoc } from "@/lib/audit";
import { rateLimit, stableHash } from "@/lib/rateLimit";
import { MAX_SHARE_PASSWORD_LEN, normalizeExactPasswordInput } from "@/lib/password";

type VerifyAliasPasswordResult =
    | { ok: true }
    | { ok: false; error: "not_found" | "expired" | "revoked" | "bad_password"; message: string };

function normAlias(alias: string): string {
    return decodeURIComponent(String(alias || "")).trim().toLowerCase();
}

function isExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false;
    const t = new Date(expiresAt).getTime();
    return Number.isFinite(t) && t <= Date.now();
}

async function getAliasRow(aliasInput: string): Promise<
    | { ok: true; docId: string; revokedAt: string | null; expiresAt: string | null; passwordHash: string | null }
    | { ok: false }
> {
    const alias = normAlias(aliasInput);
    if (!alias) return { ok: false };

    // Preferred: doc_aliases (new)
    try {
        const rows = (await sql`
      select
        a.doc_id::text as doc_id,
        a.revoked_at::text as revoked_at,
        a.expires_at::text as expires_at,
        a.password_hash::text as password_hash
      from public.doc_aliases a
      where lower(a.alias) = ${alias}
        and coalesce(a.is_active, true) = true
      limit 1
    `) as unknown as Array<{
            doc_id: string;
            revoked_at: string | null;
            expires_at: string | null;
            password_hash: string | null;
        }>;

        if (rows?.length) {
            const r = rows[0];
            return {
                ok: true,
                docId: r.doc_id,
                revokedAt: r.revoked_at ?? null,
                expiresAt: r.expires_at ?? null,
                passwordHash: r.password_hash ?? null,
            };
        }
    } catch {
        // fall through to legacy
    }

    // Legacy: document_aliases
    try {
        const rows = (await sql`
      select
        a.doc_id::text as doc_id,
        null::text as revoked_at,
        a.expires_at::text as expires_at,
        a.password_hash::text as password_hash
      from public.document_aliases a
      where lower(a.alias) = ${alias}
      limit 1
    `) as unknown as Array<{
            doc_id: string;
            revoked_at: string | null;
            expires_at: string | null;
            password_hash: string | null;
        }>;

        if (rows?.length) {
            const r = rows[0];
            return {
                ok: true,
                docId: r.doc_id,
                revokedAt: r.revoked_at ?? null,
                expiresAt: r.expires_at ?? null,
                passwordHash: r.password_hash ?? null,
            };
        }
    } catch {
        // ignore
    }

    return { ok: false };
}

export async function isAliasUnlockedAction(aliasInput: string): Promise<boolean> {
    const alias = normAlias(aliasInput);
    if (!alias) return false;

    // Fast path: cookie trust
    const c = await cookies();
    const v = c.get(aliasTrustCookieName(alias))?.value;
    if (isAliasTrusted(alias, v)) return true;

    // DB trust (requires your trusted_devices table)
    const row = await getAliasRow(alias);
    if (!row.ok) return false;

    const h = await headers();
    const ip = getClientIpFromHeaders(h);
    const ua = getUserAgentFromHeaders(h);
    const dHash = deviceHashFrom(ip, ua);
    if (!dHash) return false;

    return isDeviceTrustedForDoc({ docId: row.docId, deviceHash: dHash });
}

export async function verifyAliasPasswordResultAction(formData: FormData): Promise<VerifyAliasPasswordResult> {
    const alias = normAlias(String(formData.get("alias") || ""));
    const password = normalizeExactPasswordInput(formData.get("password"), MAX_SHARE_PASSWORD_LEN) ?? "";
    if (!alias) return { ok: false, error: "not_found", message: "Missing alias." };

    const row = await getAliasRow(alias);
    if (!row.ok) return { ok: false, error: "not_found", message: "Link not found." };
    if (row.revokedAt) return { ok: false, error: "revoked", message: "This link has been revoked." };
    if (isExpired(row.expiresAt)) return { ok: false, error: "expired", message: "This link has expired." };

    // If no password is set, treat as unlocked.
    if (!row.passwordHash) {
        return { ok: true };
    }

    // Brute-force throttle (best-effort)
    try {
        const h = await headers();
        const ip = getClientIpFromHeaders(h) || "";
        const ipKey = stableHash(ip, "VIEW_SALT");
        const aliasKey = stableHash(alias, "VIEW_SALT");
        const id = `${aliasKey}:${ipKey}`;

        const rl1 = await rateLimit({
            scope: "pw:alias:1m",
            id,
            limit: Number(process.env.RATE_LIMIT_ALIAS_PW_PER_MIN || 10),
            windowSeconds: 60,
            failClosed: true,
        });
        if (!rl1.ok) return { ok: false, error: "bad_password", message: "Too many attempts. Try again soon." };

        const rl2 = await rateLimit({
            scope: "pw:alias:10m",
            id,
            limit: Number(process.env.RATE_LIMIT_ALIAS_PW_PER_10MIN || 25),
            windowSeconds: 600,
            failClosed: true,
        });
        if (!rl2.ok) return { ok: false, error: "bad_password", message: "Too many attempts. Please wait and try again." };
    } catch {
        return { ok: false, error: "bad_password", message: "Password verification is temporarily unavailable." };
    }

    const match = await bcrypt.compare(password, row.passwordHash);
    if (!match) return { ok: false, error: "bad_password", message: "Incorrect password." };

    // DB trust (best-effort)
    try {
        const h = await headers();
        const ip = getClientIpFromHeaders(h);
        const ua = getUserAgentFromHeaders(h);
        const dHash = deviceHashFrom(ip, ua);
        if (dHash) {
            const trustedUntilIso = new Date(Date.now() + DEVICE_TRUST_HOURS * 3600 * 1000).toISOString();
            await trustDeviceForDoc({ docId: row.docId, deviceHash: dHash, trustedUntilIso });
        }
    } catch {
        // ignore
    }

    const expMs = Date.now() + DEVICE_TRUST_HOURS * 3600 * 1000;
    const c = await cookies();
    c.set(aliasTrustCookieName(alias), makeAliasTrustCookieValue(alias, expMs), {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: `/d/${encodeURIComponent(alias)}`,
        maxAge: DEVICE_TRUST_HOURS * 3600,
    });

    return { ok: true };
}
