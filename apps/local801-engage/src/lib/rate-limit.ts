import "server-only";

import { createHash, createHmac } from "node:crypto";
import { queryLocal801, type DatabaseQuery } from "./db.ts";

export const rateLimitPolicies = [
  "authentication",
  "upload",
  "import",
  "download_export",
  "search",
  "administrative_mutation",
] as const;
export type RateLimitPolicy = (typeof rateLimitPolicies)[number];

const defaults: Record<RateLimitPolicy, { limit: number; windowSeconds: number }> = {
  authentication: { limit: 10, windowSeconds: 300 },
  upload: { limit: 10, windowSeconds: 600 },
  import: { limit: 20, windowSeconds: 600 },
  download_export: { limit: 60, windowSeconds: 60 },
  search: { limit: 120, windowSeconds: 60 },
  administrative_mutation: { limit: 30, windowSeconds: 300 },
};

const envSuffix: Record<RateLimitPolicy, string> = {
  authentication: "AUTHENTICATION",
  upload: "UPLOAD",
  import: "IMPORT",
  download_export: "DOWNLOAD_EXPORT",
  search: "SEARCH",
  administrative_mutation: "ADMINISTRATIVE_MUTATION",
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error("Local 801 rate-limit configuration is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Local 801 rate-limit configuration is invalid.");
  }
  return parsed;
}

export function getRateLimitPolicy(policy: RateLimitPolicy, env: NodeJS.ProcessEnv = process.env) {
  const configured = defaults[policy];
  const suffix = envSuffix[policy];
  return Object.freeze({
    limit: boundedInteger(env[`LOCAL801_RATE_LIMIT_${suffix}_MAX`], configured.limit, 1, 100000),
    windowSeconds: boundedInteger(env[`LOCAL801_RATE_LIMIT_${suffix}_WINDOW_SECONDS`], configured.windowSeconds, 1, 86400),
  });
}

export function distributedRateLimitsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED === "1";
}

function subjectHash(kind: "user" | "ip", value: string, env: NodeJS.ProcessEnv) {
  if (kind === "ip") {
    const key = env.LOCAL801_RATE_LIMIT_IP_HASH_KEY;
    if (!key || key.length < 32) throw new Error("Local 801 IP rate-limit key is unavailable.");
    return createHmac("sha256", key).update(value).digest("hex");
  }
  return createHash("sha256").update(`local801-user:${value}`).digest("hex");
}

export function buildRateLimitIdentity(input: {
  policy: RateLimitPolicy;
  organizationId: string | null;
  subjectKind: "user" | "ip";
  subjectValue: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const policy = getRateLimitPolicy(input.policy, env);
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(nowSeconds)) throw new Error("Local 801 rate-limit time is invalid.");
  if (input.subjectKind === "user" && !input.organizationId) {
    throw new Error("Authenticated Local 801 rate limits require an organization.");
  }
  const windowStartedSeconds = Math.floor(nowSeconds / policy.windowSeconds) * policy.windowSeconds;
  const hashed = subjectHash(input.subjectKind, input.subjectValue, env);
  const bucketKey = createHash("sha256").update([
    "local801-rate-limit-v1", input.organizationId ?? "public", input.subjectKind,
    hashed, input.policy, String(windowStartedSeconds), String(policy.windowSeconds),
  ].join(":"), "utf8").digest("hex");
  return Object.freeze({
    bucketKey,
    organizationId: input.organizationId,
    subjectKind: input.subjectKind,
    subjectHash: hashed,
    policy: input.policy,
    windowStartedAt: new Date(windowStartedSeconds * 1000).toISOString(),
    windowSeconds: policy.windowSeconds,
    limit: policy.limit,
    now: now.toISOString(),
  });
}

export type RateLimitDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number; currentCount: number }>;

export async function consumeRateLimit(
  input: Parameters<typeof buildRateLimitIdentity>[0],
  query: DatabaseQuery = queryLocal801,
): Promise<RateLimitDecision> {
  const identity = buildRateLimitIdentity(input);
  const [row] = await query<{ allowed: boolean; retry_after_seconds: number | string; current_count: number | string }>(`
    SELECT allowed, retry_after_seconds, current_count
    FROM local801.consume_rate_limit($1, $2::uuid, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz)
  `, [
    identity.bucketKey, identity.organizationId, identity.subjectKind, identity.subjectHash,
    identity.policy, identity.windowStartedAt, identity.windowSeconds, identity.limit, identity.now,
  ]);
  const retryAfterSeconds = Number(row?.retry_after_seconds);
  const currentCount = Number(row?.current_count);
  if (!row || typeof row.allowed !== "boolean" || !Number.isSafeInteger(retryAfterSeconds)
    || retryAfterSeconds < 1 || !Number.isSafeInteger(currentCount) || currentCount < 1) {
    throw new Error("Local 801 distributed rate limiter returned an invalid result.");
  }
  return Object.freeze({ allowed: row.allowed, retryAfterSeconds, currentCount });
}

export function rateLimitDeniedResponse(retryAfterSeconds: number) {
  const safeRetryAfter = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds, 86400)
    : 60;
  return Response.json({ error: "RATE_LIMITED", retryAfterSeconds: safeRetryAfter }, {
    status: 429,
    headers: {
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      "Retry-After": String(safeRetryAfter),
    },
  });
}

export async function enforceAuthenticatedRateLimit(input: {
  organizationId: string;
  userId: string;
  policy: RateLimitPolicy;
}, query: DatabaseQuery = queryLocal801) {
  if (!distributedRateLimitsEnabled()) return { ok: true as const, disabled: true as const };
  try {
    const decision = await consumeRateLimit({
      policy: input.policy,
      organizationId: input.organizationId,
      subjectKind: "user",
      subjectValue: input.userId,
    }, query);
    if (decision.allowed) return { ok: true as const, disabled: false as const };
    console.warn("[local801-security]", JSON.stringify({
      event: "rate_limit.denied", outcome: "denied", policy: input.policy,
      organizationId: input.organizationId, actorId: input.userId,
      retryAfterSeconds: decision.retryAfterSeconds,
    }));
    return { ok: false as const, response: rateLimitDeniedResponse(decision.retryAfterSeconds) };
  } catch {
    console.error("[local801-security]", JSON.stringify({
      event: "rate_limit.failure", outcome: "fail_closed", policy: input.policy,
      organizationId: input.organizationId, actorId: input.userId,
    }));
    return { ok: false as const, response: Response.json({ error: "RATE_LIMIT_UNAVAILABLE" }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate", "Retry-After": "60" },
    }) };
  }
}

export async function enforceAuthenticatedIdentityRateLimit(input: {
  organizationSlug: string;
  userId: string;
  policy: RateLimitPolicy;
}, query: DatabaseQuery = queryLocal801) {
  if (!distributedRateLimitsEnabled()) return { ok: true as const, disabled: true as const };
  try {
    const rows = await query<{ organization_id: string; user_id: string }>(`
      SELECT organization.id::text AS organization_id, app_user.id::text AS user_id
      FROM local801.organizations organization
      JOIN local801.users app_user ON app_user.organization_id = organization.id
      WHERE organization.slug = $1::text
        AND organization.archived_at IS NULL
        AND app_user.id::text = $2::text
        AND app_user.deactivated_at IS NULL
      LIMIT 2
    `, [input.organizationSlug, input.userId]);
    if (rows.length !== 1) throw new Error("Authenticated rate-limit identity is unavailable.");
    return enforceAuthenticatedRateLimit({
      organizationId: rows[0].organization_id,
      userId: rows[0].user_id,
      policy: input.policy,
    }, query);
  } catch {
    console.error("[local801-security]", JSON.stringify({
      event: "rate_limit.failure", outcome: "fail_closed", policy: input.policy,
    }));
    return { ok: false as const, response: Response.json({ error: "RATE_LIMIT_UNAVAILABLE" }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate", "Retry-After": "60" },
    }) };
  }
}

export async function cleanupExpiredRateLimits(batchSize = 250, query: DatabaseQuery = queryLocal801) {
  const [row] = await query<{ deleted_count: number | string }>(
    "SELECT local801.cleanup_expired_rate_limits($1) AS deleted_count",
    [batchSize],
  );
  const deleted = Number(row?.deleted_count);
  if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > batchSize) {
    throw new Error("Local 801 rate-limit cleanup returned an invalid result.");
  }
  return deleted;
}
