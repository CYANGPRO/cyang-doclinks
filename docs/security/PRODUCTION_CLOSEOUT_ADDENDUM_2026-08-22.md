# CAT production closeout addendum — 2026-08-22

## Current recommendation

**FAIL for real member data and production launch.** The database, deployment, restore, branch-hygiene, and firewall work below is complete, but the remaining acceptance items are evidence gates rather than authorization gates. `LOCAL801_PRODUCTION_LAUNCH_ENABLED` remains `0`.

## Completed provider work

- Created separate Neon login roles for the CAT production database:
  - `local801_app`: application DML and reporting reads; no schema creation or table truncation.
  - `local801_migrator`: owns the application/reporting objects and can perform migration DDL.
  - `local801_backup`: read-only access with `default_transaction_read_only=on`; a write attempt was rejected.
- Replaced Vercel Production `LOCAL801_DATABASE_URL` with the pooled TLS app-role URL.
- Added separate GitHub Actions secrets for the migration and backup role URLs.
- Rotated all three scoped credentials after verification and rotated `neondb_owner` after the restricted-role deployment was live. Previous owner and first-pass scoped credentials are invalid.
- Completed a disposable Neon branch restore exercise:
  - zero schema diff against production;
  - 78 application/reporting tables and 25 reporting views;
  - 54,937 total rows on both branches;
  - matching exact table-count fingerprint `854b388c67e457c55d2357732ebebdc7`;
  - PII state reported protected read/write mode, completed backfill, and verification for the production organization.
- Deleted the three approved stale branches and the task-created restore branch. Only protected `production` and the existing `develoment` branch remain.
- Published seven Vercel Firewall observation rules. Every rule is live and valid, uses an IP-keyed fixed window, and has exceeded-threshold action `log`. There are no pending firewall changes and no deny/challenge/redirect action in this rule set.
- Built and deployed the CAT-only source bundle to Vercel Production as deployment `dpl_5tMcboZqnpqsNif9X2bV4k3mdSSx` and explicitly assigned `cat.cyang.io` to it.
- Verified `https://cat.cyang.io/` returns HTTP 200 with HSTS, CSP, and no-store caching. Production `/api/health` remains intentionally unavailable with HTTP 404. No runtime errors were reported in the post-deployment smoke window.
- Recorded accountable-owner confirmation that the complete production Entra identity acceptance flow was exercised with three users, including account onboarding, MFA-backed authentication, CAT role/access confirmation, and the required disabled/revoked/stale-session/recovery negative controls. No user identities or authentication artifacts are retained in this repository evidence.
- Local verification passed: 578 tests, TypeScript, lint (two non-blocking generated-code warnings), and the production build.

## Acceptance flag state

| Variable | Production value | Evidence decision |
| --- | --- | --- |
| `LOCAL801_DATABASE_PII_PROTECTION_ENABLED` | `1` | Enabled after protected database state and PII acceptance evidence were verified. |
| `LOCAL801_BACKUP_RESTORE_VERIFIED` | `0` | Database restore passed, but encrypted R2 object recovery and key-read recovery have not been executed end to end. |
| `LOCAL801_SECURITY_REVIEW_APPROVED` | `0` | Final monitoring, identity, dependency/code-scanning, governance, and independent-review acceptance is incomplete. |
| `LOCAL801_PRODUCTION_LAUNCH_ENABLED` | `0` | Must remain last and may be enabled only after every launch blocker is cleared and recorded. |

## Remaining blockers

1. Execute and retain evidence for encrypted R2 source-to-recovery-bucket recovery, checksum/metadata verification, recovery-key access, and cleanup.
2. Configure an approved CAT-only monitoring destination and prove delivery/acknowledgement for runtime, build, firewall, workflow-failure, and integrity signals without sensitive fields.
3. Resolve or formally accept material dependency alerts; obtain successful CAT security and CodeQL checks for the exact release; then enforce the reviewed branch ruleset.
4. Complete firewall observation review and Preview 429/`Retry-After` enforcement testing before changing any rule from log-only behavior.
5. Complete retention/legal/privacy decisions, incident/tabletop evidence, external penetration testing, remediation/retest, and accountable final approval with a non-secret review ID.
6. Re-run the production security gate against the final Vercel environment and perform live scanner, private-storage, monitoring, and recovery acceptance. Set the production launch flag only after that run has no blockers.

No DocLinks database, storage, session, key, billing, deployment, or application source was changed by this closeout.
