import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRateLimitIdentity,
  cleanupExpiredRateLimits,
  consumeRateLimit,
  distributedRateLimitsEnabled,
  getRateLimitPolicy,
  rateLimitDeniedResponse,
} from "../src/lib/rate-limit.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";

test("rate-limit policies are independently configurable and bounded", () => {
  assert.deepEqual(getRateLimitPolicy("upload", {}), { limit: 10, windowSeconds: 600 });
  assert.deepEqual(getRateLimitPolicy("search", {
    LOCAL801_RATE_LIMIT_SEARCH_MAX: "25",
    LOCAL801_RATE_LIMIT_SEARCH_WINDOW_SECONDS: "30",
  }), { limit: 25, windowSeconds: 30 });
  assert.throws(() => getRateLimitPolicy("import", { LOCAL801_RATE_LIMIT_IMPORT_MAX: "0" }), /invalid/);
  assert.equal(distributedRateLimitsEnabled({ LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED: "1" }), true);
  assert.equal(distributedRateLimitsEnabled({}), false);
});

test("authenticated bucket identity is stable, windowed, and organization separated", () => {
  const now = new Date("2026-08-21T12:03:04.000Z");
  const first = buildRateLimitIdentity({ policy: "download_export", organizationId, subjectKind: "user", subjectValue: userId, now, env: {} });
  const same = buildRateLimitIdentity({ policy: "download_export", organizationId, subjectKind: "user", subjectValue: userId, now: new Date("2026-08-21T12:03:59.000Z"), env: {} });
  const otherOrganization = buildRateLimitIdentity({ policy: "download_export", organizationId: "33333333-3333-4333-8333-333333333333", subjectKind: "user", subjectValue: userId, now, env: {} });
  assert.equal(first.bucketKey, same.bucketKey);
  assert.notEqual(first.bucketKey, otherOrganization.bucketKey);
  assert.match(first.subjectHash, /^[0-9a-f]{64}$/);
  assert.equal(first.subjectHash.includes(userId), false);
});

test("unauthenticated identity uses a keyed IP hash and never exposes the raw IP", () => {
  const rawIp = "192.0.2.44";
  const identity = buildRateLimitIdentity({
    policy: "authentication", organizationId: null, subjectKind: "ip", subjectValue: rawIp,
    now: new Date("2026-08-21T12:00:00.000Z"), env: { LOCAL801_RATE_LIMIT_IP_HASH_KEY: "k".repeat(32) },
  });
  assert.equal(JSON.stringify(identity).includes(rawIp), false);
  assert.throws(() => buildRateLimitIdentity({ policy: "authentication", organizationId: null, subjectKind: "ip", subjectValue: rawIp, env: {} }), /key is unavailable/);
});

test("database decisions include safe retry metadata and deny after concurrency-safe count", async () => {
  const parameters = [];
  const decision = await consumeRateLimit({ policy: "import", organizationId, subjectKind: "user", subjectValue: userId, now: new Date("2026-08-21T12:00:00.000Z"), env: {} }, async (_sql, values) => {
    parameters.push(values);
    return [{ allowed: false, retry_after_seconds: 41, current_count: 21 }];
  });
  assert.deepEqual(decision, { allowed: false, retryAfterSeconds: 41, currentCount: 21 });
  assert.equal(parameters[0][1], organizationId);
  const response = rateLimitDeniedResponse(decision.retryAfterSeconds);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "41");
  assert.equal(response.headers.get("Cache-Control")?.includes("no-store"), true);
});

test("expiry and bounded cleanup are delegated to reviewed database functions", async () => {
  let statement = "";
  const deleted = await cleanupExpiredRateLimits(250, async (sql) => {
    statement = sql;
    return [{ deleted_count: "250" }];
  });
  assert.equal(deleted, 250);
  assert.match(statement, /cleanup_expired_rate_limits/);
  await assert.rejects(cleanupExpiredRateLimits(250, async () => [{ deleted_count: "251" }]), /invalid result/);
});
