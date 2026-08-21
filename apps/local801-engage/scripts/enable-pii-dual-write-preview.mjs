import postgres from "postgres";
import { getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const databaseUrl = process.env.LOCAL801_DATABASE_URL;

function fail(message) {
  console.error(`PII dual-write activation blocked: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

if (!databaseUrl) fail("LOCAL801_DATABASE_URL is required.");
if (process.env.VERCEL_ENV === "production") fail("Vercel Production is never allowed.");
if (process.env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1") fail("LOCAL801_PII_DUAL_WRITE_ENABLED must be 1 in this shell.");
if (process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") fail("production launch must remain disabled.");
if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") fail("protected-only production mode must remain disabled.");
if (process.env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1") fail("Stage 12 authoritative import execution must remain disabled during synthetic dual-write activation.");

getPiiKeyConfiguration(process.env);
const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });

try {
  const organizations = await sql`select id::text, slug from local801.organizations order by slug`;
  const preview = organizations.filter((row) => row.slug === "local801-preview");
  if (preview.length !== 1) fail("exactly one local801-preview organization is required.");
  const organizationId = preview[0].id;

  const [before] = await sql`
    select write_mode, backfill_state, protected_read_enabled_at, protected_write_enabled_at
    from local801.pii_protection_state
    where organization_id=${organizationId}::uuid
  `;
  if (before?.protected_read_enabled_at || before?.protected_write_enabled_at) fail("protected read/write cutover is already active.");
  if (before && !['legacy', 'dual'].includes(before.write_mode)) fail("current write mode is not eligible for synthetic dual write.");
  if (before && !['not_started', 'complete', 'failed'].includes(before.backfill_state)) fail("current backfill state is not eligible for dual-write activation.");

  const [state] = await sql`
    insert into local801.pii_protection_state (
      organization_id, schema_version, write_mode, backfill_state,
      protected_read_enabled_at, protected_write_enabled_at, verified_at, updated_at
    ) values (${organizationId}::uuid, 1, 'dual', 'not_started', null, null, null, now())
    on conflict (organization_id) do update set
      write_mode='dual',
      backfill_state=case when local801.pii_protection_state.backfill_state='complete' then 'complete' else 'not_started' end,
      protected_read_enabled_at=null,
      protected_write_enabled_at=null,
      verified_at=null,
      updated_at=now()
    where local801.pii_protection_state.write_mode in ('legacy','dual')
      and local801.pii_protection_state.protected_read_enabled_at is null
      and local801.pii_protection_state.protected_write_enabled_at is null
    returning write_mode, backfill_state,
      protected_read_enabled_at is not null as protected_reads,
      protected_write_enabled_at is not null as protected_writes
  `;
  if (!state || state.write_mode !== 'dual' || state.protected_reads || state.protected_writes) fail("dual-write state did not activate safely.");

  console.log(JSON.stringify({
    organization: 'local801-preview',
    writeMode: state.write_mode,
    backfillState: state.backfill_state,
    protectedReadsEnabled: false,
    protectedWritesEnabled: false,
    authoritativePreviewExecutionRequiredOff: true,
  }, null, 2));
} finally {
  await sql.end({ timeout: 3 });
}
