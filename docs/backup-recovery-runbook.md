# Backup & Recovery Runbook

Last updated: February 26, 2026

## Scope
- Database: Neon Postgres (`DATABASE_URL`)
- Object storage: Cloudflare R2 (`R2_BUCKET`)
- Application secrets: runtime env vars (`DOC_MASTER_KEYS`, `CRON_SECRET`, etc.)

## 1) Neon Database Recovery
1. Verify automatic backups are enabled in Neon project settings.
2. Select restore target timestamp and create a restored branch/database.
3. Run smoke queries on restored DB:
   - `select count(*) from public.docs;`
   - `select count(*) from public.share_tokens;`
   - `select count(*) from public.immutable_audit_log;`
4. Point a staging deployment at restored DB and validate core flows:
   - upload
   - share create
   - view/download
5. Cut over production only after validation.

### Low-cost automation: Neon -> R2 (GitHub Actions)
Use `.github/workflows/backup-neon-to-r2.yml` for daily logical backups on free/low-cost infrastructure.

Required GitHub Secrets:
- `NEON_DATABASE_URL` (Neon Postgres connection string)
- `R2_ENDPOINT` (e.g. `https://<accountid>.r2.cloudflarestorage.com`)
- `R2_BACKUP_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Optional GitHub Variables:
- `R2_BACKUP_PREFIX` (default: `db-backups/neon`)
- `BACKUP_STATUS_WEBHOOK_URL` (recommended: `https://www.cyang.io/api/backup/status`)

Optional GitHub Secret:
- `BACKUP_STATUS_WEBHOOK_TOKEN` (Bearer token for status webhook)

Required app env for webhook auth:
- `BACKUP_STATUS_WEBHOOK_TOKEN` (must match the GitHub secret above)

Webhook behavior:
- On successful backup upload, workflow posts `status=ok` to `/api/backup/status`.
- On failed backup runs, workflow posts `status=failed`.
- Endpoint writes records into `public.backup_runs`, so dashboard backup health updates from real backup outcomes.
- Optional DB optimization: run `scripts/sql/backup_runs_source_idx.sql` to speed up source-filtered backup health queries.

Recommended free-tier posture:
1. Keep cadence daily.
2. Set an R2 lifecycle rule on backup prefix (e.g. auto-delete after 30 days).
3. Keep Neon native restore window as your fast recovery path, and use dump backups for longer-range recovery.

Manual restore test (from a dump file):
1. Download dump from R2.
2. Restore into a non-production Neon branch:
   - `pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$TARGET_DATABASE_URL" <dump-file>`
3. Run smoke checks before any cutover:
   - `npm run restore:verify -- --require-current-migrations`
   - `LIVE_RESTORE_TARGET_DATABASE_URL="$TARGET_DATABASE_URL" LIVE_RESTORE_EXPECTED_BACKUP_FILE="<dump-file-name>" npm run runtime:proof:live`
4. Record the drill result if desired:
   - success: `npm run restore:verify -- --record-success --notes "quarterly restore drill"`
   - failure: `npm run restore:verify -- --record-failure --notes "restore validation issue"`

What `runtime:proof:live` adds beyond `restore:verify`:

- confirms the recovery target is not the primary DB
- requires the named backup artifact to exist in both source and recovery `backup_runs`
- verifies docs/share/audit counts are non-empty on the restored target
- records a recovery-drill row automatically unless `LIVE_RESTORE_RECORD_RESULT=0`
- optionally checks `/api/health/ready` on `LIVE_RESTORE_TARGET_BASE_URL`

## 2) R2 Object Recovery
1. Confirm bucket retention/versioning configuration in Cloudflare dashboard.
2. For accidental overwrite/delete:
   - restore object version if versioning is enabled
   - otherwise restore from external copy/replication target
3. Validate object metadata:
   - `doc-id`
   - `orig-content-type`
4. Re-run malware scan and integrity checks on restored objects.

## 3) Encryption Key Compromise
1. Immediately revoke compromised key in admin security panel.
2. Switch active key to a non-compromised key.
3. Enqueue key rotation jobs to rewrap all docs off compromised key.
4. Track progress in `key_rotation_jobs` until remaining count is zero.
5. Keep immutable audit exports for incident report.

## 4) Admin Account Breach
1. Revoke impacted sessions/tokens and rotate auth secrets.
2. Review immutable audit log + security events for scope of actions.
3. Revoke suspicious shares and disable suspicious docs.
4. Force key rotation if any key-management actions are suspicious.

## 5) Validation Checklist After Recovery
- Upload + complete flow works.
- Existing share links enforce policy and limits.
- Quarantined docs remain blocked unless override exists.
- Cron endpoints reachable from Cloudflare worker.
- Security event ingestion and alert spikes operating.
- `/api/health/ready` returns `200`.
- `/api/health/deps` shows fresh backups and no critical dependency failures.
- `npm run runtime:proof:live` passes against the named restored backup artifact before cutover.
