export async function readRestoreVerificationSnapshot({ sql }) {
  const rows = await sql.unsafe(`
    select
      (select count(*)::bigint from public.docs) as docs_count,
      (select count(*)::bigint from public.share_tokens) as share_tokens_count,
      (select count(*)::bigint from public.immutable_audit_log) as immutable_audit_count,
      to_regclass('public.recovery_drills')::text as recovery_drills_ready,
      to_regclass('public.schema_migrations')::text as schema_migrations_ready
  `);
  const row = rows[0] || {};
  return {
    docsCount: Number(row.docs_count || 0),
    shareTokensCount: Number(row.share_tokens_count || 0),
    immutableAuditCount: Number(row.immutable_audit_count || 0),
    recoveryDrillsReady: Boolean(row.recovery_drills_ready),
    schemaMigrationsReady: Boolean(row.schema_migrations_ready),
  };
}

export async function assertRestoreVerificationReady({
  sql,
  requireCurrentMigrations = false,
  getMigrationStatus,
}) {
  if (!requireCurrentMigrations) return;
  const status = await getMigrationStatus({ sql });
  if (status.pending.length || status.drift.length) {
    throw new Error("Restore verification failed because migrations are not current.");
  }
}

export async function recordRecoveryDrill({
  sql,
  status,
  notes,
  requireCurrentMigrations = false,
  now = new Date(),
}) {
  await sql.unsafe(
    `
      insert into public.recovery_drills (status, notes, details)
      values ($1, $2, $3::jsonb)
    `,
    [
      status,
      notes || null,
      JSON.stringify({
        verifiedAt: now.toISOString(),
        requireCurrentMigrations,
      }),
    ]
  );
}
