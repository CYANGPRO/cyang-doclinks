# CAT production closeout addendum — 2026-08-22

## Current recommendation

**FAIL for real member data and production launch.** Database/object/key recovery, identity, monitoring delivery, firewall enforcement, scoped database roles, and release-control evidence now pass, but remaining secret/storage/scanner separation, scanner acceptance, governance, penetration testing, and independent final review are evidence gates rather than authorization gates. `LOCAL801_PRODUCTION_LAUNCH_ENABLED` remains `0`.

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
- Promoted exact Git commit `33fa5fdf4bbb8a73677a28efb0845284ee5037db` to Vercel Production as deployment `dpl_3Q5czVMvZVECRDFJgFWbicpy7qpz` and explicitly verified that `cat.cyang.io` resolves to that deployment. The project intentionally requires explicit promotion because automatic custom-domain assignment is disabled.
- Verified `https://cat.cyang.io/` returns HTTP 200 with HSTS, CSP, and no-store caching. Production `/api/health` remains intentionally unavailable with HTTP 404. No runtime errors were reported in the post-deployment smoke window.
- Recorded accountable-owner confirmation that the complete production Entra identity acceptance flow was exercised with three users, including account onboarding, MFA-backed authentication, CAT role/access confirmation, and the required disabled/revoked/stale-session/recovery negative controls. No user identities or authentication artifacts are retained in this repository evidence.
- Completed CAT recovery workflow runs against commit `6c2f9e99fdeeb82076ff69266ee9ea2f9937b4db`:
  - [database backup run 32597930819](https://github.com/CYANGPRO/cyang-doclinks/actions/runs/32597930819) created a PostgreSQL 18 custom-format dump, checksum, and uploaded both to the private recovery bucket;
  - [R2 inventory run 32597932286](https://github.com/CYANGPRO/cyang-doclinks/actions/runs/32597932286) enumerated all 28 opaque encrypted objects without truncation;
  - [R2 dry-run 32598018680](https://github.com/CYANGPRO/cyang-doclinks/actions/runs/32598018680) accepted all 28 objects;
  - [R2 copy run 32598092186](https://github.com/CYANGPRO/cyang-doclinks/actions/runs/32598092186) copied and HEAD-verified all 28 objects with per-object SHA-256 metadata and size equality. The temporary copy opt-in and typed confirmation variables were removed after the run.
- Created private bucket `local801-engage-recovery-private` with separate bucket-scoped source-read and destination-write credentials. Public access remains disabled.
- Verified Sentry project `local801-cat-production` receives redacted Production errors. Its enabled high-priority email alert has two recorded triggers, including the synthetic acceptance event; runtime Sentry initialization now strips request, user, context, breadcrumb, local-variable, and original-message data before transmission and disables tracing.
- Enabled `main` branch protection with strict required checks `local801-security` and `analyze-local801`, one approval, stale-review dismissal, last-push approval, linear history, conversation resolution, and force-push/deletion denial. Administrator enforcement remains off so the sole recovery owner is not locked out.
- Exact-release checks for `33fa5fd` passed: [CAT CI job](https://github.com/CYANGPRO/cyang-doclinks/actions/runs/32598683811), [CAT CodeQL](https://github.com/CYANGPRO/cyang-doclinks/actions/runs/32598683828), and [repository CodeQL](https://github.com/CYANGPRO/cyang-doclinks/actions/runs/32598683877). The combined CI workflow remains red only because the root DocLinks production dependency audit fails; CAT's dependency audit reports zero vulnerabilities.
- Local verification passed: 587 tests, TypeScript, lint (two non-blocking generated-code warnings), 22-migration verification, zero CAT dependency vulnerabilities, and the production build.
- Guarded encrypted-object recovery run `32642686698` verified the real AES-GCM envelope/key version, independent source read, recovery copy, in-memory plaintext hash, and exact absence from both buckets. The temporary Cloudflare token and four temporary GitHub secrets were deleted.
- Published Preview firewall rule `rule_cat_preview_enforce_authentication_post_oeD9jM` enforces 5 POST requests per 60 seconds per IP under `/api/auth`. A seven-request signed-in Preview burst returned five application 404 responses followed by two Vercel 429 denials with `x-vercel-mitigated: deny`. Vercel's platform denial does not emit `Retry-After`; the CAT application limiter separately returns safe `Retry-After` metadata.
- Fixed two high-severity CAT CodeQL findings in XLSX text parsing in commit `09d7fad`; exact-commit CAT and repository CodeQL completed successfully and CAT open code-scanning alerts are zero.
- Production limiter acceptance found and corrected a stale GitHub migration target. Protected Neon branch `production` now has migrations `0020`–`0022`, private security-definer limiter functions, and distinct non-admin `local801_app`, `local801_migrator`, and `local801_backup` roles. Preview uses separate branch `develoment` and distinct non-admin `local801_preview_app`. Run `32645413253` verified 25 concurrent attempts, 10 allows, 15 denials, and exact synthetic cleanup; the temporary app-role GitHub secret was deleted.

## Acceptance flag state

| Variable | Production value | Evidence decision |
| --- | --- | --- |
| `LOCAL801_DATABASE_PII_PROTECTION_ENABLED` | `1` | Enabled after protected database state and PII acceptance evidence were verified. |
| `LOCAL801_BACKUP_RESTORE_VERIFIED` | `1` | Database restore, ciphertext copy, controlled key read/decrypt, hash verification, and exact cleanup passed. |
| `LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED` | `1` | Enabled after Production run `32645413253` verified scoped-role privileges, atomic concurrency, denial, and cleanup. |
| `LOCAL801_SECURITY_REVIEW_APPROVED` | `0` | Identity, CAT dependency/code scanning, branch controls, and monitoring delivery passed; firewall enforcement, provider separation, governance, and independent review remain incomplete. |
| `LOCAL801_PRODUCTION_LAUNCH_ENABLED` | `0` | Must remain last and may be enabled only after every launch blocker is cleared and recorded. |

## Remaining blockers

1. Complete Production/Preview separation for R2 application storage, object/PII keyrings, `NEXTAUTH_SECRET`, and the scanner HMAC credential. Database branches/roles and Production Entra versus synthetic Preview authentication are now distinct.
2. Configure the separate Production scanner credential and pass clean, infected, outage, invalid-signature, and redacted-signal acceptance without changing the shared DocLinks scanner boundary.
3. Formally disposition the root DocLinks/scanner Dependabot backlog separately from CAT. Do not treat CAT's zero-vulnerability audit as remediation of other workspaces.
4. Complete retention/legal/privacy decisions, privately assign incident roles, run the tabletop, complete external penetration testing/remediation/retest, and obtain accountable final approval with a non-secret review ID.
5. Re-run the production security gate against the final Vercel environment and perform authenticated live scanner, private-storage, session-revocation, monitoring, and limiter response acceptance. Set the production launch flag only after that run has no blockers.

No DocLinks database, storage, session, key, billing, deployment, or application source was changed by this closeout.
