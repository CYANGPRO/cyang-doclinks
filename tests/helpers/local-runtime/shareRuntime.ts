import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import type { V1SharesRouteDeps } from "../../../src/app/api/v1/shares/route";
import type { SharePasswordActionDeps } from "../../../src/app/s/[token]/actions";
import type { AliasPasswordActionDeps } from "../../../src/app/d/[alias]/unlockActions";

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

export function formData(entries: Record<string, string>) {
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

export function createShareRouteHarness() {
  const state = {
    docOwnerId: "user-1",
    insertedShares: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
  };

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

  return {
    state,
    deps: deps as unknown as V1SharesRouteDeps,
    makeRequest(body: Record<string, unknown>) {
      return new NextRequest("https://app.example.test/api/v1/shares", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(JSON.stringify(body), "utf8")),
        },
        body: JSON.stringify(body),
      });
    },
  };
}

export function createSharePasswordHarness(opts: {
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

  return {
    deps: deps as unknown as SharePasswordActionDeps,
    jar,
    attempts,
    unlocks,
  };
}

export function createAliasPasswordHarness(opts: {
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
    headers: async () =>
      new Headers({ "x-forwarded-for": "203.0.113.60", "user-agent": "pw-test" }) as unknown as Awaited<
        ReturnType<typeof import("next/headers").headers>
      >,
    rateLimit: async () => ({ ok: true, resetSeconds: 60 }),
    stableHash: (value: string) => `hash:${value}`,
    bcryptCompare: bcrypt.compare,
    trustDeviceForDoc: async (entry: unknown) => {
      trusted.push(entry as Record<string, unknown>);
    },
    getAliasRow: async () => opts.aliasRow,
  };

  return {
    deps: deps as unknown as AliasPasswordActionDeps,
    jar,
    trusted,
  };
}
