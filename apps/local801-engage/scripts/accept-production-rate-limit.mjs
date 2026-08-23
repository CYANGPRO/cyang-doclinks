import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const confirmation = "RUN LOCAL801 PRODUCTION RATE LIMIT ACCEPTANCE";
const databaseUrl = process.env.LOCAL801_MIGRATION_DATABASE_URL;
if (process.env.LOCAL801_PRODUCTION_RATE_LIMIT_ACCEPTANCE !== "1") {
  throw new Error("Production rate-limit acceptance requires explicit opt-in.");
}
if (process.env.LOCAL801_PRODUCTION_RATE_LIMIT_CONFIRMATION !== confirmation) {
  throw new Error("Production rate-limit acceptance confirmation is invalid.");
}
if (process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED !== "0") {
  throw new Error("Production launch must remain disabled during rate-limit acceptance.");
}
if (!databaseUrl) throw new Error("The guarded migration database URL is required.");

const target = new URL(databaseUrl);
const tlsMode = target.searchParams.get("sslmode");
if (!target.hostname.endsWith(".neon.tech") || !["require", "verify-ca", "verify-full"].includes(tlsMode ?? "")) {
  throw new Error("Production rate-limit acceptance requires an approved TLS Neon target.");
}
if (decodeURIComponent(target.username) !== "local801_migrator") {
  throw new Error("Production rate-limit acceptance requires the scoped Local 801 migration role.");
}

const sql = postgres(databaseUrl, { max: 10, prepare: false, onnotice: () => {} });
const startedAt = Date.now();
const bucketKey = createHash("sha256").update(`local801-production-rate-limit:${randomUUID()}`).digest("hex");
const subjectHash = createHash("sha256").update(`local801-production-rate-limit-subject:${randomUUID()}`).digest("hex");
const now = new Date();
const windowSeconds = 60;
const windowStartedAt = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);

let operationError;
let cleanupError;
let operationStage = "target-state";
let safeFailureCodes = [];
try {
  const [targetState] = await sql`
    select
      current_user = 'local801_migrator' as migration_role,
      to_regclass('local801.rate_limit_buckets') is not null as bucket_table,
      to_regprocedure('local801.consume_rate_limit(text,uuid,text,text,text,timestamp with time zone,integer,integer,timestamp with time zone)') is not null as consume_function,
      to_regprocedure('local801.cleanup_expired_rate_limits(integer,timestamp with time zone)') is not null as cleanup_function,
      has_schema_privilege('local801_app', 'local801', 'USAGE') as app_schema_usage,
      has_table_privilege('local801_app', 'local801.rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE') as app_bucket_dml,
      has_function_privilege(
        'local801_app',
        'local801.consume_rate_limit(text,uuid,text,text,text,timestamp with time zone,integer,integer,timestamp with time zone)',
        'EXECUTE'
      ) as app_consume_execute,
      has_function_privilege(
        'local801_app',
        'local801.cleanup_expired_rate_limits(integer,timestamp with time zone)',
        'EXECUTE'
      ) as app_cleanup_execute
  `;
  safeFailureCodes = Object.entries(targetState)
    .filter(([_name, passed]) => passed !== true)
    .map(([name]) => `TARGET_${name.toUpperCase()}`);
  assert.equal(safeFailureCodes.length, 0);

  operationStage = "concurrency-and-denial";
  const decisions = await Promise.all(Array.from({ length: 25 }, () => sql`
    select allowed, retry_after_seconds, current_count
    from local801.consume_rate_limit(
      ${bucketKey}, null, 'ip', ${subjectHash}, 'authentication',
      ${windowStartedAt.toISOString()}::timestamptz, ${windowSeconds}, 10, ${now.toISOString()}::timestamptz
    )
  `));
  const rows = decisions.flat();
  const counts = rows.map((row) => Number(row.current_count)).sort((left, right) => left - right);
  assert.deepEqual(counts, Array.from({ length: 25 }, (_value, index) => index + 1));
  assert.equal(rows.filter((row) => row.allowed).length, 10);
  assert.equal(rows.filter((row) => !row.allowed).length, 15);
  assert.equal(rows.every((row) => Number.isSafeInteger(Number(row.retry_after_seconds)) && Number(row.retry_after_seconds) >= 1), true);
} catch (error) {
  operationError = error;
} finally {
  try {
    await sql`delete from local801.rate_limit_buckets where bucket_key = ${bucketKey} and subject_hash = ${subjectHash}`;
    const [{ remaining }] = await sql`
      select count(*)::integer as remaining
      from local801.rate_limit_buckets
      where bucket_key = ${bucketKey} or subject_hash = ${subjectHash}
    `;
    assert.equal(remaining, 0);
  } catch (error) {
    cleanupError = error;
  }
  await sql.end({ timeout: 1 }).catch(() => undefined);
}

if (operationError || cleanupError) {
  process.stderr.write(`${JSON.stringify({
    status: "failed-safe",
    stage: cleanupError ? "exact-cleanup" : operationStage,
    blockers: safeFailureCodes,
  })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    target: "production-neon",
    role: "local801_migrator",
    applicationRolePrivileges: "verified",
    policy: "authentication",
    attempts: 25,
    allowed: 10,
    denied: 15,
    cleanup: "exact-synthetic-bucket-confirmed-absent",
    durationMs: Date.now() - startedAt,
  })}\n`);
}
