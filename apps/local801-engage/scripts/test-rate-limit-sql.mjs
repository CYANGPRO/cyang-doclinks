import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";

const databaseUrl = process.env.LOCAL801_SQL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("LOCAL801_SQL_TEST_DATABASE_URL is required.");
if (process.env.LOCAL801_SQL_TEST_RESET !== "1") throw new Error("LOCAL801_SQL_TEST_RESET=1 is required.");
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") throw new Error("Rate-limit SQL test is forbidden in Production.");
const parsed = new URL(databaseUrl);
if (decodeURIComponent(parsed.pathname.replace(/^\//, "")) !== "local801_sql_test") throw new Error("Rate-limit SQL test requires exactly local801_sql_test.");
if (process.env.LOCAL801_DATABASE_URL) throw new Error("Rate-limit SQL test refuses a configured CAT application database.");

const migrationSql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
const sql = postgres(databaseUrl, { max: 10, prepare: false, onnotice: () => {} });
const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const subjectHash = "a".repeat(64);
const bucketKey = "b".repeat(64);
const windowStart = "2026-08-21T12:00:00.000Z";
const now = "2026-08-21T12:00:01.000Z";

try {
  const [{ current_database: currentDatabase, has_local801: hasLocal801 }] = await migrationSql`
    select current_database(), to_regnamespace('local801') is not null as has_local801
  `;
  assert.equal(currentDatabase, "local801_sql_test");
  assert.equal(hasLocal801, false, "Disposable database must be empty.");
  const files = (await readdir(migrationsUrl)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await migrationSql.unsafe(await readFile(new URL(file, migrationsUrl), "utf8"));
  await migrationSql.end({ timeout: 1 });
  await sql`insert into local801.organizations (id, slug, name) values (${organizationId}, 'rate-limit-test', 'Synthetic Rate Limit Test'), (${otherOrganizationId}, 'rate-limit-other-test', 'Synthetic Other Test')`;

  const decisions = await Promise.all(Array.from({ length: 25 }, () => sql`
    select allowed, retry_after_seconds, current_count
    from local801.consume_rate_limit(
      ${bucketKey}, ${organizationId}::uuid, 'user', ${subjectHash}, 'import',
      ${windowStart}::timestamptz, 60, 10, ${now}::timestamptz
    )
  `));
  const counts = decisions.map((rows) => Number(rows[0].current_count)).sort((a, b) => a - b);
  assert.deepEqual(counts, Array.from({ length: 25 }, (_value, index) => index + 1));
  assert.equal(decisions.flatMap((rows) => rows).filter((row) => row.allowed).length, 10);
  assert.equal(decisions.flatMap((rows) => rows).filter((row) => !row.allowed).length, 15);

  await assert.rejects(sql`
    select * from local801.consume_rate_limit(
      ${bucketKey}, ${otherOrganizationId}::uuid, 'user', ${subjectHash}, 'import',
      ${windowStart}::timestamptz, 60, 10, ${now}::timestamptz
    )
  `, /bucket identity conflict/);

  await sql`select * from local801.consume_rate_limit(${'c'.repeat(64)}, ${organizationId}::uuid, 'user', ${subjectHash}, 'search', ${windowStart}::timestamptz, 60, 10, ${now}::timestamptz)`;
  const [firstCleanup] = await sql`select local801.cleanup_expired_rate_limits(1, '2026-08-21T12:02:00.000Z'::timestamptz) as deleted_count`;
  const [secondCleanup] = await sql`select local801.cleanup_expired_rate_limits(100, '2026-08-21T12:02:00.000Z'::timestamptz) as deleted_count`;
  assert.equal(Number(firstCleanup.deleted_count), 1);
  assert.equal(Number(secondCleanup.deleted_count), 1);
  const [{ remaining }] = await sql`select count(*)::integer as remaining from local801.rate_limit_buckets`;
  assert.equal(remaining, 0);
  console.log("PASS rate-limit SQL: atomic concurrency, denial, organization conflict, expiry, and bounded cleanup.");
} finally {
  await migrationSql.end({ timeout: 1 }).catch(() => undefined);
  await sql.end({ timeout: 1 });
}
