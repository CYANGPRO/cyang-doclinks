# Local 801 Engage Production-Readiness Checklist

## Current decision

**Real member data is still prohibited.** The fail-closed production launch interlock, protected-PII implementation, recovery acceptance, and Production database-rate-limit acceptance exist, but remaining credential separation, scanner acceptance, governance, penetration testing, and final security approval are not complete.

The 2026-08-22 authenticated provider inspection found critical Production/Preview variable reuse. The closeout repaired the existing Vercel project connection, Root Directory, Node version, and initial fail-closed flags. On 2026-08-23, a follow-up limiter drill exposed a stale GitHub migration target and missing Production migrations `0020` and `0021`. The migration/backup secrets and Vercel Production application URL were replaced with scoped URLs for protected branch `production`; migrations `0020`–`0022` were applied there; and Preview was moved to branch `develoment` using distinct non-admin role `local801_preview_app`. Object/PII keyrings, session secret, scanner credential, and Preview storage separation still require owner-controlled remediation before real data or launch.

The 2026-08-23 guarded key-recovery drill initially stopped before dispatch because Vercel `sensitive` variables cannot be read back. The owner then supplied the exact Production keyring and active version from outside Vercel directly to temporary GitHub Actions secrets. Workflow run `32642686698` verified the real AES-GCM envelope path, independent source read, recovery-bucket copy and metadata, in-memory decryption, and plaintext hash match. It reported key fingerprint `9c0b7787f9f4351a`, encrypted size 288 bytes, duration 855 ms, and `source-and-destination-confirmed-absent`. All four temporary GitHub secrets and the scoped 24-hour Cloudflare token were deleted; source and recovery bucket counts returned to their exact pre-drill baselines.

`LOCAL801_PRODUCTION_LAUNCH_ENABLED` must remain `0` until every required production item below is complete. The launch policy also requires `LOCAL801_DATABASE_PII_PROTECTION_ENABLED=1`, `LOCAL801_BACKUP_RESTORE_VERIFIED=1`, `LOCAL801_SECURITY_REVIEW_APPROVED=1`, and a non-secret `LOCAL801_PRODUCTION_SECURITY_REVIEW_ID` before Vercel Production authentication can run.

## Verified application controls

- [x] Separate Vercel project `cyang-cat-data`; DocLinks is not modified or reused as the application runtime.
- [x] Separate `LOCAL801_DATABASE_URL` and private R2 configuration are required; no generic `DATABASE_URL` fallback exists.
- [x] AES-256-GCM encrypted private object storage with versioned keyring support is implemented.
- [x] Shared malware scanner integration is implemented and fail-closed through `https://scan.cyang.io` with per-app HMAC authentication.
- [x] Production OIDC authentication foundation requires verified email and provider MFA assurance.
- [x] Active user, single Local 801 role, and `auth_session_version` are revalidated against PostgreSQL for protected production sessions.
- [x] Team & Access supports provision, role change, deactivate/reactivate, and session revocation with hierarchy controls and audit events.
- [x] Preview role cookies are denied in Vercel Production.
- [x] Native authenticated web reporting is the reporting architecture; no Power BI runtime connection is required.
- [x] PWA service worker caches static/offline assets only and does not cache authenticated application responses.
- [x] Stage 14A production launch gate blocks production when Preview-only import execution/durable-worker switches or synthetic seed opt-in are enabled.
- [x] Stage 14A response headers include CSP, HSTS in production builds, frame/object restrictions, no-store application caching, COOP/CORP, and noindex directives.
- [x] Protected-PII migrations and application paths provide encrypted companion records, blind indexes, protected read/write gates, import staging, commit constraints, and rotation tracking.

## Required before real data or production launch

- [x] Apply and acceptance-test the reviewed PII migration using synthetic data before any real member data is introduced; Production restore evidence reported protected read/write mode, completed backfill, and verification.
- [x] Complete the source authorization/tenant-isolation review for every page, Route Handler, mutation, export, document path, and background task; independent penetration testing remains separately required below.
- [x] CAT-local PostgreSQL rate-limit source/disposable tests and guarded Production database acceptance passed. Run `32645413253` used the scoped app role for 25 concurrent synthetic attempts (10 allowed, 15 denied), verified private table/function privileges, and confirmed exact cleanup before `LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED=1` was set. Final authenticated HTTP acceptance remains part of the launch smoke test.
- [ ] Complete storage-operation auditing and orphan/cleanup operational procedures.
- [x] Configure the approved protected Production PostgreSQL branch with scoped app/migration/backup roles and apply all 22 reviewed migrations in order.
- [x] Existing CAT Vercel project is connected to `CYANGPRO/cyang-doclinks`, Root Directory is `apps/local801-engage`, Node.js is 22.x, and exact commit `33fa5fd` passed CAT CI/CodeQL before explicit promotion to `cat.cyang.io`.
- [ ] Replace the observed Production/Preview credential and key reuse with approved separate database, storage, identity, scanner, session and key material; validate backup/key recovery before retiring old credentials.
- [x] Configure a separate production private R2 bucket and least-privilege production/recovery credentials; public access is disabled.
- [x] An owner-controlled recovery copy outside Vercel supplied the exact Production object keyring and active version for successful recovery run `32642686698`. Vercel `sensitive` variables remain operational inputs, not the independent escrow.
- [x] Configure the approved production OIDC client/callback and verify MFA assurance end-to-end with three test production accounts, including negative controls.
- [x] Provision three production test users through Team & Access; self-service signup remains disabled. The owner confirmed complete account, role, MFA, disablement, revocation, stale-session, and recovery testing.
- [ ] Configure the production scanner client secret separately from Preview and pass clean/infected/outage acceptance tests.
- [x] Configure CAT-only Sentry application-error monitoring with fail-closed enablement and aggressive sensitive-data filtering; verify redacted Production delivery and two high-priority email-alert triggers.
- [x] Database restore, bounded encrypted-object copy, and guarded synthetic key-read/cleanup drill passed. GitHub Actions run `32642686698` retained non-secret verification evidence and confirmed both synthetic copies absent before `LOCAL801_BACKUP_RESTORE_VERIFIED` was set to `1`.
- [ ] Complete privacy, retention/deletion, incident-response, vendor, access-control, and penetration/deployment reviews.
- [x] Confirm no tracked `local-sensitive-samples` content or open GitHub secret-scanning alerts. The repository check found no tracked CAT spreadsheet/CSV/PDF sample files; operator-owned locations outside the repository remain governed by the retention decision.
- [ ] Record final security approval and non-secret review/change reference; only then set `LOCAL801_SECURITY_REVIEW_APPROVED=1` and `LOCAL801_PRODUCTION_SECURITY_REVIEW_ID`.
- [ ] Obtain explicit production launch approval from the accountable owner after the completed review package is presented.
- [x] Set `LOCAL801_DATABASE_PII_PROTECTION_ENABLED=1` after protected Production state and restore acceptance proved the application uses the protected schema.
- [ ] Set `LOCAL801_PRODUCTION_LAUNCH_ENABLED=1` **last**, after every other launch blocker is cleared.
- [ ] Verify `npm run security:production-readiness` exits successfully using the final production environment without printing secret values.
- [ ] Verify `cat.cyang.io`, TLS, authenticated access, health/readiness behavior, private R2 access, scanner fail-closed behavior, and production session revocation after the final deployment.

## Production invariants

The following remain mandatory after launch: `SIGNUP_ENABLED=0`, `MFA_ENFORCE_ALL=1`, `LOCAL801_PREVIEW_AUTH_ENABLED=0`, `LOCAL801_ALLOW_SYNTHETIC_SEED=0`, `LOCAL801_DURABLE_IMPORTS_ENABLED=0`, and `LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED=0` unless a later production-specific design explicitly replaces those Preview-only paths.
