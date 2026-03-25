import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { postV1SharesRoute, type V1SharesRouteDeps } from "../src/app/api/v1/shares/route";
import { verifySharePasswordCoreWithDeps, type SharePasswordActionDeps } from "../src/app/s/[token]/actions";
import { verifyAliasPasswordResultWithDeps, type AliasPasswordActionDeps } from "../src/app/d/[alias]/unlockActions";
import { aliasTrustCookieName } from "../src/lib/deviceTrust";

type CookieRecord = Map<string, { value: string; options?: Record<string, unknown> }>;

function cookieStore(seed?: CookieRecord) {
  const jar = seed ?? new Map<string, { value: string; options?: Record<string, unknown> }>();
  return {
    jar,
    store: {
      get(name: string) {
        const found = jar.get(name);
        return found ? { name, value: found.value } : undefined;
      },
      set(name: string, value: string, options?: Record<string, unknown>) {
        jar.set(name, { value, options });
      },
    },
  };
}

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

function shareRouteSql(state: {
  docOwnerId: string;
  insertedShares: Array<Record<string, unknown>>;
}): V1SharesRouteDeps["sql"] {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("from public.docs") && text.includes("owner_id::text as owner_id")) {
      return [
        {
          owner_id: state.docOwnerId,
          doc_state: "ready",
          scan_state: "clean",
          moderation_status: "active",
        },
      ];
    }
    if (text.includes("insert into public.share_tokens")) {
      state.insertedShares.push({
        token: values[0],
        docId: values[1],
        toEmail: values[2],
        expiresAt: values[3],
        maxViews: values[4],
        passwordHash: values[5],
      });
      return [];
    }
    throw new Error(`Unhandled share SQL: ${text}`);
  }) as V1SharesRouteDeps["sql"];
}

function makeShareRouteDeps(state: {
  docOwnerId: string;
  insertedShares: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
}): V1SharesRouteDeps {
  const deps = {
    sql: shareRouteSql(state),
    verifyApiKeyFromRequest: async () => ({ ok: true, ownerId: state.docOwnerId, status: 200 }),
    emitWebhook: async () => {},
    assertCanCreateShare: async () => ({ ok: true }),
    getPlanForUser: async () => ({ id: "pro" } as { id: string }),
    normalizeExpiresAtForPlan: ({ requestedExpiresAtIso }: { requestedExpiresAtIso?: string | null }) =>
      requestedExpiresAtIso ?? null,
    normalizeMaxViewsForPlan: ({ requestedMaxViews }: { requestedMaxViews?: number | null }) =>
      requestedMaxViews ?? null,
    clientIpKey: () => ({ ip: "203.0.113.40", ipHash: "iphash" }),
    enforceGlobalApiRateLimit: async () => ({ ok: true, status: 200, retryAfterSeconds: 0 }),
    appendImmutableAudit: async (entry: unknown) => {
      state.audits.push(entry as Record<string, unknown>);
    },
    resolvePublicAppBaseUrl: () => "https://app.example.test",
    DEFAULT_SHARE_SETTINGS: {
      expiresAt: null,
      expiresInSeconds: null,
      maxViews: null,
      allowDownload: true,
      watermarkEnabled: false,
    },
    PRO_PACK_UPSELL_MESSAGE: "upgrade",
    applyPack: (settings: unknown) => settings,
    getPackById: () => ({ id: "default", version: 1, label: "Default" }),
    isPackAvailableForPlan: () => true,
    getShareEligibility: () => ({ canCreateLink: true, warning: null, blockedReason: null }),
    getRouteTimeoutMs: () => 20_000,
    isRouteTimeoutError: ((_: unknown): _ is never => false),
    withRouteTimeout: async <T>(work: Promise<T>) => work,
    withRequestTelemetry: async <T>(_req: NextRequest, fn: () => Promise<T>) => fn(),
    bcryptHash: bcrypt.hash,
  };
  return deps as unknown as V1SharesRouteDeps;
}

function makeSharePasswordDeps(opts: {
  meta:
    | {
        ok: true;
        token: string;
        docId: string;
        toEmail: string | null;
        createdAt: string;
        expiresAt: string | null;
        maxViews: number | null;
        viewCount: number;
        revokedAt: string | null;
        hasPassword: boolean;
        passwordHash: string | null;
        watermarkEnabled: boolean;
        watermarkText: string | null;
        allowDownload: boolean;
        packId: string | null;
        packVersion: number | null;
        sharedByEmail: string | null;
        docStatus: string;
        docModerationStatus: string;
        scanStatus: string;
        riskLevel: string;
        isActive: boolean;
      }
    | { ok: false };
  rateLimited?: boolean;
}) {
  const { jar, store } = cookieStore();
  const attempts: Array<{ token: unknown; ipHash: unknown }> = [];
  const unlocks: Array<{ token: unknown; unlockId: unknown }> = [];
  const deps = {
    sql: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(" ");
      if (text.includes("insert into public.share_unlocks")) {
        unlocks.push({ token: values[0], unlockId: values[1] });
        return [];
      }
      if (text.includes("insert into public.share_pw_attempts")) {
        attempts.push({ token: values[0], ipHash: values[1] });
        return [];
      }
      throw new Error(`Unhandled share password SQL: ${text}`);
    }) as SharePasswordActionDeps["sql"],
    resolveShareGateMeta: async () => opts.meta,
    rateLimit: async () =>
      opts.rateLimited ? ({ ok: false, resetSeconds: 60 }) : ({ ok: true, resetSeconds: 60 }),
    stableHash: (value: string) => `hash:${value}`,
    cookies: async () => store,
    headers: async () => new Headers({ "x-forwarded-for": "203.0.113.50" }) as unknown as Awaited<ReturnType<typeof import("next/headers").headers>>,
    bcryptCompare: bcrypt.compare,
    redirect: () => {
      throw new Error("unexpected redirect");
    },
  };
  return { deps: deps as unknown as SharePasswordActionDeps, jar, attempts, unlocks };
}

function makeAliasDeps(opts: {
  aliasRow:
    | {
        ok: true;
        docId: string;
        revokedAt: string | null;
        expiresAt: string | null;
        passwordHash: string | null;
      }
    | { ok: false };
}) {
  const { jar, store } = cookieStore();
  const trusted: Array<Record<string, unknown>> = [];
  const deps = {
    sql: (async () => []) as AliasPasswordActionDeps["sql"],
    cookies: async () => store,
    headers: async () => new Headers({ "x-forwarded-for": "203.0.113.60", "user-agent": "pw-test" }) as unknown as Awaited<ReturnType<typeof import("next/headers").headers>>,
    rateLimit: async () => ({ ok: true, resetSeconds: 60 }),
    stableHash: (value: string) => `hash:${value}`,
    bcryptCompare: bcrypt.compare,
    trustDeviceForDoc: async (entry: unknown) => {
      trusted.push(entry as Record<string, unknown>);
    },
    getAliasRow: async () => opts.aliasRow,
  };
  return { deps: deps as unknown as AliasPasswordActionDeps, jar, trusted };
}

test.describe("share runtime proofs", () => {
  test("creates password-protected shares without trimming exact unicode input", async () => {
    const state = {
      docOwnerId: "user-1",
      insertedShares: [] as Array<Record<string, unknown>>,
      audits: [] as Array<Record<string, unknown>>,
    };
    const req = new NextRequest("https://app.example.test/api/v1/shares", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "256",
      },
      body: JSON.stringify({
        doc_id: "11111111-1111-4111-8111-111111111111",
        password: "  Paß🔐word  ",
      }),
    });

    const res = await postV1SharesRoute(req, makeShareRouteDeps(state));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBeTruthy();
    expect(state.insertedShares).toHaveLength(1);
    const storedHash = String(state.insertedShares[0].passwordHash || "");
    expect(storedHash.length).toBeGreaterThan(0);
    expect(await bcrypt.compare("  Paß🔐word  ", storedHash)).toBeTruthy();
    expect(await bcrypt.compare("Paß🔐word", storedHash)).toBeFalsy();
    expect(state.audits).toHaveLength(1);
  });

  test("rejects invalid share passwords at creation time and allows empty password as no-password share", async () => {
    const invalidState = {
      docOwnerId: "user-1",
      insertedShares: [] as Array<Record<string, unknown>>,
      audits: [] as Array<Record<string, unknown>>,
    };
    const invalidReq = new NextRequest("https://app.example.test/api/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "128" },
      body: JSON.stringify({
        doc_id: "11111111-1111-4111-8111-111111111111",
        password: "bad\tpassword",
      }),
    });
    const invalidRes = await postV1SharesRoute(invalidReq, makeShareRouteDeps(invalidState));
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json()).error).toBe("INVALID_PASSWORD");

    const emptyState = {
      docOwnerId: "user-1",
      insertedShares: [] as Array<Record<string, unknown>>,
      audits: [] as Array<Record<string, unknown>>,
    };
    const emptyReq = new NextRequest("https://app.example.test/api/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "128" },
      body: JSON.stringify({
        doc_id: "11111111-1111-4111-8111-111111111111",
        password: "",
      }),
    });
    const emptyRes = await postV1SharesRoute(emptyReq, makeShareRouteDeps(emptyState));
    expect(emptyRes.status).toBe(200);
    expect(emptyState.insertedShares[0].passwordHash).toBeNull();
  });

  test("grants access only to the exact share password and records failed attempts without leaking internals", async () => {
    const passwordHash = await bcrypt.hash("🔐Exact Café", 10);
    const liveMeta = {
      ok: true as const,
      token: "tok_live",
      docId: "doc-1",
      toEmail: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxViews: 5,
      viewCount: 0,
      revokedAt: null,
      hasPassword: true,
      passwordHash,
      watermarkEnabled: false,
      watermarkText: null,
      allowDownload: true,
      packId: null,
      packVersion: null,
      sharedByEmail: null,
      docStatus: "ready",
      docModerationStatus: "active",
      scanStatus: "clean",
      riskLevel: "low",
      isActive: true,
    };

    const wrong = makeSharePasswordDeps({ meta: liveMeta });
    const wrongResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_live", password: "🔐Exact Cafe" }),
      wrong.deps
    );
    expect(wrongResult).toEqual({ ok: false, error: "bad_password", message: "Incorrect password." });
    expect(wrong.attempts).toHaveLength(1);
    expect(JSON.stringify(wrongResult)).not.toContain("password_hash");

    const correct = makeSharePasswordDeps({ meta: liveMeta });
    const okResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_live", password: "🔐Exact Café" }),
      correct.deps
    );
    expect(okResult).toEqual({ ok: true });
    expect(correct.unlocks).toHaveLength(1);
    expect(correct.jar.get("share_unlock_tok_live")?.value).toBeTruthy();
  });

  test("requires both recipient email and password when that share policy is enabled", async () => {
    const passwordHash = await bcrypt.hash("open-sesame", 10);
    const meta = {
      ok: true as const,
      token: "tok_combo",
      docId: "doc-1",
      toEmail: "person@example.com",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxViews: null,
      viewCount: 0,
      revokedAt: null,
      hasPassword: true,
      passwordHash,
      watermarkEnabled: false,
      watermarkText: null,
      allowDownload: true,
      packId: null,
      packVersion: null,
      sharedByEmail: null,
      docStatus: "ready",
      docModerationStatus: "active",
      scanStatus: "clean",
      riskLevel: "low",
      isActive: true,
    };

    const missingEmail = makeSharePasswordDeps({ meta });
    const emailResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_combo", password: "open-sesame", email: "" }),
      missingEmail.deps
    );
    expect(emailResult).toEqual({
      ok: false,
      error: "bad_password",
      message: "Enter the recipient email for this share.",
    });

    const correct = makeSharePasswordDeps({ meta });
    const okResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_combo", password: "open-sesame", email: "person@example.com" }),
      correct.deps
    );
    expect(okResult).toEqual({ ok: true });
    expect(correct.jar.get("share_email_tok_combo")?.value).toBe("person@example.com");
  });

  test("fails safely for invalid, expired, and revoked share tokens", async () => {
    const missing = makeSharePasswordDeps({ meta: { ok: false } });
    await expect(verifySharePasswordCoreWithDeps(formData({ token: "tok_missing", password: "x" }), missing.deps)).resolves.toEqual({
      ok: false,
      error: "not_found",
      message: "Share not found.",
    });

    const expired = makeSharePasswordDeps({
      meta: {
        ok: true,
        token: "tok_expired",
        docId: "doc-1",
        toEmail: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        maxViews: null,
        viewCount: 0,
        revokedAt: null,
        hasPassword: false,
        passwordHash: null,
        watermarkEnabled: false,
        watermarkText: null,
        allowDownload: true,
        packId: null,
        packVersion: null,
        sharedByEmail: null,
        docStatus: "ready",
        docModerationStatus: "active",
        scanStatus: "clean",
        riskLevel: "low",
        isActive: true,
      },
    });
    await expect(verifySharePasswordCoreWithDeps(formData({ token: "tok_expired", password: "" }), expired.deps)).resolves.toEqual({
      ok: false,
      error: "expired",
      message: "This share link has expired.",
    });

    const revoked = makeSharePasswordDeps({
      meta: {
        ok: true,
        token: "tok_revoked",
        docId: "doc-1",
        toEmail: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        maxViews: null,
        viewCount: 0,
        revokedAt: new Date().toISOString(),
        hasPassword: false,
        passwordHash: null,
        watermarkEnabled: false,
        watermarkText: null,
        allowDownload: true,
        packId: null,
        packVersion: null,
        sharedByEmail: null,
        docStatus: "ready",
        docModerationStatus: "active",
        scanStatus: "clean",
        riskLevel: "low",
        isActive: true,
      },
    });
    const revokedResult = await verifySharePasswordCoreWithDeps(formData({ token: "tok_revoked", password: "" }), revoked.deps);
    expect(revokedResult).toEqual({
      ok: false,
      error: "revoked",
      message: "This share was revoked.",
    });
    expect(JSON.stringify(revokedResult)).not.toContain("public.");
  });

  test("unlocks password-protected aliases and blocks revoked or expired aliases safely", async () => {
    const passwordHash = await bcrypt.hash("alias 🔑", 10);
    const live = makeAliasDeps({
      aliasRow: {
        ok: true,
        docId: "doc-1",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        passwordHash,
      },
    });
    const ok = await verifyAliasPasswordResultWithDeps(
      formData({ alias: "Quarterly-Report", password: "alias 🔑" }),
      live.deps
    );
    expect(ok).toEqual({ ok: true });
    const cookieName = aliasTrustCookieName("quarterly-report");
    expect(live.jar.get(cookieName)?.value).toBeTruthy();
    expect(live.trusted).toHaveLength(1);

    const revoked = makeAliasDeps({
      aliasRow: {
        ok: true,
        docId: "doc-1",
        revokedAt: new Date().toISOString(),
        expiresAt: null,
        passwordHash,
      },
    });
    await expect(
      verifyAliasPasswordResultWithDeps(formData({ alias: "Quarterly-Report", password: "alias 🔑" }), revoked.deps)
    ).resolves.toEqual({
      ok: false,
      error: "revoked",
      message: "This link has been revoked.",
    });

    const expired = makeAliasDeps({
      aliasRow: {
        ok: true,
        docId: "doc-1",
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        passwordHash,
      },
    });
    const expiredResult = await verifyAliasPasswordResultWithDeps(
      formData({ alias: "Quarterly-Report", password: "alias 🔑" }),
      expired.deps
    );
    expect(expiredResult).toEqual({
      ok: false,
      error: "expired",
      message: "This link has expired.",
    });
    expect(JSON.stringify(expiredResult)).not.toContain("password_hash");
  });
});
