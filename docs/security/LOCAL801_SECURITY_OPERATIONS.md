# CAT Security Operations Closeout

These procedures are CAT-only. Real member data remains prohibited and `LOCAL801_PRODUCTION_LAUNCH_ENABLED=0` remains mandatory until the production gate is independently satisfied.

## Fresh production initialization

The Preview seed, backfill, and cutover tools remain Preview-only. The separate `security:initialize-production` command is for a fresh, fully migrated CAT production database. Do not run it until the CAT database target and key custody are approved.

1. Keep launch and synthetic seeding disabled. Set `LOCAL801_DATABASE_ENVIRONMENT=production`, the exact `LOCAL801_PRODUCTION_DATABASE_HOST`, exact `LOCAL801_PRODUCTION_DATABASE_NAME`, `LOCAL801_ORGANIZATION_SLUG`, and TLS-required `LOCAL801_DATABASE_URL`.
2. Inspect without owner PII: `npm --prefix apps/local801-engage run security:initialize-production -- --mode=inspect`. Pass only when every CAT table is empty and the reviewed migration set is present.
3. In an authorized controlled session, provide the organization name, individually attributable System Owner email/display name, protected-PII encryption and blind-index keyrings, `LOCAL801_PRODUCTION_INITIALIZE=1`, and the exact typed confirmation printed in the private change record.
4. Run `npm --prefix apps/local801-engage run security:initialize-production -- --mode=initialize` once. Inside one transaction the command creates one organization, the seven role definitions, one protected-only System Owner and email blind index; decrypts and compares the protected companions; recomputes the blind index; verifies the owner role and absence of plaintext shortcuts; and only then records protected-only state, a non-sensitive audit event and a one-time marker. It refuses populated, mismatched, Preview/test, DocLinks/reused legacy targets or repeated targets and never prints the owner identity or key material.
5. Retain secret-free command output, change authorization, migration evidence, target identity evidence, audit-event identifier from an authorized database review, and a screenshot showing launch remains disabled. Do not set the application PII-protection acceptance flag until independent synthetic acceptance passes.

On 2026-08-22 the initializer completed and refused a second invocation against a fresh disposable database populated only with synthetic `example.test` identity data. This proves the code path, transaction and refusal behavior; it is not production initialization evidence and does not authorize either production PII-protection flag.

## Distributed rate limits

Migration `0020` supplies atomic PostgreSQL buckets and bounded expired-bucket cleanup. Policies are separate for authentication, uploads, imports, downloads/exports, search, and administrative mutations. Current defaults are documented in `.env.example`; approve production values through change control.

Set `LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED=1` only after migration application and a disposable-database concurrency test. Use a separate random `LOCAL801_RATE_LIMIT_IP_HASH_KEY` only for a future reviewed unauthenticated edge; raw IP addresses must never be stored or logged. OIDC callbacks and health checks are deliberately not wrapped by application rate limiting. The launch policy remains blocked while distributed limiting is disabled.

## Encrypted R2 object recovery

The manual `local801-r2-recovery` workflow has no schedule and cannot delete. It uses source-read credentials and distinct destination-write credentials, refuses shared access-key identifiers, retries bounded requests, never decrypts content, verifies destination size and SHA-256 metadata, preserves encrypted-object metadata, and zeroes its ciphertext buffer after use. Inventory and dry-run are the default modes. Copy mode additionally requires the repository variables `LOCAL801_R2_RECOVERY_COPY=1` and exact `LOCAL801_R2_RECOVERY_CONFIRMATION`.

Cloudflare setup, using only existing/free controls:

1. Cloudflare Dashboard -> R2 Object Storage -> create or select a distinct private CAT recovery bucket named with the `local801-` prefix. Keep `r2.dev` and custom-domain public access disabled.
2. R2 -> Manage R2 API Tokens: create one token restricted to read/list the CAT application bucket and another restricted to write/head the CAT recovery bucket. Do not grant delete permission. Record token IDs/permissions, not values.
3. GitHub -> repository -> Settings -> Secrets and variables -> Actions: add only the `LOCAL801_R2_RECOVERY_SOURCE_*` and `LOCAL801_R2_RECOVERY_DESTINATION_*` names referenced by the workflow. Keep the copy variables unset for inventory.
4. Actions -> `local801-r2-recovery` -> Run workflow with `inventory`, then `dry-run`. Review bounded opaque key fingerprints and sizes. For an approved copy, set the exact confirmation variables temporarily, run one bounded `copy`, retain the run log, and remove the enabling variables.
5. Restore validation: upload one synthetic encrypted `example.test` object through an isolated non-production CAT target using an opaque generated CAT key. Run inventory, dry-run, then one approved bounded copy. Verify source/destination size, source checksum, recovery SHA-256 metadata and encrypted-object metadata count. Retrieve it with temporary destination-read credentials in the controlled test and decrypt only with the synthetic test key. Record checksum/size/result and remove the disposable object and credentials only after exact target review.

## Retention inventory; deletion disabled

No retention period is approved, so no automatic deletion exists. The read-only inventory command requires the exact production target guard, CAT application-bucket credentials, explicit `LOCAL801_RETENTION_INVENTORY=1`, and a batch of at most 1,000:

`npm --prefix apps/local801-engage run security:retention-inventory`

It reports only counts/fingerprints for cleanup-pending documents, expired generated reports, import source files, failed temporary import jobs, and possible orphaned CAT objects. Orphan classification is limited to the exact bounded R2 page and asks the database for references to those exact keys within the exact organization; off-page keys cannot be classified. Treat possible orphans as review candidates and never delete based on one run. After Local 801 approves retention periods, design and separately review a destructive mode with exact target confirmation, disabled-launch plus maintenance checks, a typed confirmation, bounded batches, first-run dry output, durable per-item evidence, retry-safe state, backups, legal/privacy approval, cross-organization refusal tests and restore testing.
