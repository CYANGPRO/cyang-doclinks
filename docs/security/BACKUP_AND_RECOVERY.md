# CAT Backup and Recovery

Backup configuration and a successful restore exercise are production blockers. Documentation or provider capability alone does not satisfy `LOCAL801_BACKUP_RESTORE_VERIFIED=1`.

## Recovery inventory

| Item | Backup/recovery approach | Responsibility | Current status |
| --- | --- | --- | --- |
| Neon CAT database | Provider point-in-time/history capability plus daily custom-format `pg_dump` to a dedicated CAT recovery bucket | CAT + Neon + GitHub + Cloudflare | Database restore matched production schema/count fingerprint; run 32597930819 uploaded a PostgreSQL 18 dump and checksum |
| R2 application objects | Manual bounded inventory/dry-run/ciphertext-copy workflow using separate source-read and destination-write credentials; destination size/checksum/metadata verification; separately guarded synthetic key-read/cleanup drill; do not assume ordinary object metadata equals recoverable version history | CAT + Cloudflare | Runs 32597932286, 32598018680, and 32598092186 inventoried, dry-ran, copied, and verified all 28 ciphertext objects; the synthetic key-read/cleanup workflow is implemented but its provider run is still pending |
| Source/configuration | Git history, protected branches, versioned migrations/workflows/docs; provider env export must exclude public storage | CAT + GitHub/Vercel | Source implemented; provider config export procedure pending |
| Object and PII encryption keys | Offline/owner-controlled escrow with versions, access log, recovery test and rotation runbook | System owner/operator | Custody and recovery evidence pending |
| Identity/provider configuration | Provider-owned export/rebuild instructions and two-person recovery access | Organization + provider | Pending |

The CAT backup workflow uses only `LOCAL801_BACKUP_*` secrets, requires database TLS, creates a compressed PostgreSQL custom archive and SHA-256 checksum, and uploads them to a separately named recovery bucket. It must not use DocLinks database or R2 credentials.

The 2026-08-22 exercise used private bucket `local801-engage-recovery-private`, a source-read token scoped only to `local801-engage-private`, and a separate destination-write token scoped only to the recovery bucket. Copy authorization was removed after the verified run. This proves ciphertext recoverability, not authorized key custody or plaintext recovery.

The synthetic key-read drill is a separate, explicit workflow mode. It requires a temporary source-bucket drill credential distinct from the source-read and recovery-destination credentials, an exact bucket-name confirmation, and the authorized object-encryption keyring. It creates only one random synthetic encrypted object, copies and authenticates it, decrypts it in memory, compares the synthetic plaintext hash, then deletes and HEAD-confirms absence of that exact opaque object key from both buckets. Do not retain the temporary source-write credential after a successful drill.

## Restore authorization

Only an explicitly authorized recovery operator may restore. Production restoration requires incident/change authorization. A routine test must use a new disposable non-production Neon project/branch and isolated validation credentials. Never point the drill at the production target and never use destructive `--clean` operations against production.

## Quarterly restore test

1. Select a completed backup and verify its recorded workflow run, object size and checksum.
2. Create an empty disposable CAT recovery database whose resolved target is demonstrably different from production, preview and DocLinks.
3. Configure TLS and apply least-privilege temporary credentials.
4. Run `pg_restore --list <archive>` and then restore into the empty disposable target.
5. Run all 21 CAT migrations/manifest verification and inspect migration/schema consistency.
6. Validate counts and synthetic sentinel records without exporting protected plaintext. Verify protected PII envelopes, audit rows and key versions are present.
7. With authorized recovery keys in a controlled environment, verify a small synthetic protected read and one encrypted-object recovery path.
8. Record date, backup identifier, recovery point, duration, operator, target, validation results, exceptions and cleanup evidence.
9. Destroy the disposable target and temporary credentials through the provider console after resolving the exact target.
10. Set `LOCAL801_BACKUP_RESTORE_VERIFIED=1` only after the production-equivalent database and object/key recovery dependencies have passed.

The 2026-08-22 read-only Neon inspection observed a seven-day project history window. This is capability evidence, not a restore test or an approved recovery point objective. Neon plan/history/snapshot capabilities and retention are provider settings that may change; verify the selected production plan in the Neon console during each test.
