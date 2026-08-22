# Local 801 Engage Production-Readiness Checklist

## Current decision

**Real member data is still prohibited.** The fail-closed production launch interlock and protected-PII implementation exist, but protected-schema deployment acceptance, backup/restore acceptance, final security review, and production infrastructure acceptance are not complete.

The 2026-08-22 authenticated provider inspection found critical Production/Preview variable reuse. The same-day closeout repair reconnected the existing Vercel project to `CYANGPRO/cyang-doclinks`, set Root Directory to `apps/local801-engage`, aligned Vercel to Node.js 22.x, and set all four Production launch/acceptance switches explicitly to `0` without replacing the project, domain, deployment, or environment records. Infrastructure/credential separation still requires owner-controlled remediation before real data or launch.

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

- [ ] Apply and acceptance-test the reviewed PII migration using synthetic data before any real member data is introduced.
- [ ] Complete the authorization/tenant-isolation review for every page, Route Handler, mutation, export, document path, and background task.
- [ ] CAT-local PostgreSQL rate-limit source and disposable SQL concurrency tests are complete; acceptance-test production enablement, thresholds, denials, fail-closed behavior and cleanup for high-risk read/write/search/export/download paths.
- [ ] Complete storage-operation auditing and orphan/cleanup operational procedures.
- [ ] Configure a separate approved production PostgreSQL database and apply every reviewed migration in order.
- [x] Existing CAT Vercel project is connected to `CYANGPRO/cyang-doclinks`, Root Directory is `apps/local801-engage`, Node.js is 22.x, and the existing domain/environment/deployment records were preserved; a new Git-triggered Preview still must pass before Production release.
- [ ] Replace the observed Production/Preview credential and key reuse with approved separate database, storage, identity, scanner, session and key material; validate backup/key recovery before retiring old credentials.
- [ ] Configure a separate production private R2 bucket and least-privilege production credentials.
- [ ] Generate a separate production object-encryption keyring and protected-PII key hierarchy; escrow/rotation procedures must be documented.
- [ ] Configure the approved production OIDC client/callback and verify MFA assurance end-to-end with test production accounts.
- [ ] Provision production Local 801 users through Team & Access; self-service signup remains disabled.
- [ ] Configure the production scanner client secret separately from Preview and pass clean/infected/outage acceptance tests.
- [ ] Configure production monitoring/alerting with sensitive-data filtering and verify an alert path.
- [ ] Configure database/object backups and perform a documented restore exercise; only then set `LOCAL801_BACKUP_RESTORE_VERIFIED=1`.
- [ ] Complete privacy, retention/deletion, incident-response, vendor, access-control, and penetration/deployment reviews.
- [ ] Confirm no real sample/member files or credentials are committed to GitHub and no plaintext member files remain in temporary operational locations.
- [ ] Record final security approval and non-secret review/change reference; only then set `LOCAL801_SECURITY_REVIEW_APPROVED=1` and `LOCAL801_PRODUCTION_SECURITY_REVIEW_ID`.
- [ ] Obtain explicit production launch approval from the accountable owner after the completed review package is presented.
- [ ] Set `LOCAL801_DATABASE_PII_PROTECTION_ENABLED=1` only after acceptance proves the application is actually using the protected schema.
- [ ] Set `LOCAL801_PRODUCTION_LAUNCH_ENABLED=1` **last**, after every other launch blocker is cleared.
- [ ] Verify `npm run security:production-readiness` exits successfully using the final production environment without printing secret values.
- [ ] Verify `cat.cyang.io`, TLS, authenticated access, health/readiness behavior, private R2 access, scanner fail-closed behavior, and production session revocation after the final deployment.

## Production invariants

The following remain mandatory after launch: `SIGNUP_ENABLED=0`, `MFA_ENFORCE_ALL=1`, `LOCAL801_PREVIEW_AUTH_ENABLED=0`, `LOCAL801_ALLOW_SYNTHETIC_SEED=0`, `LOCAL801_DURABLE_IMPORTS_ENABLED=0`, and `LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED=0` unless a later production-specific design explicitly replaces those Preview-only paths.
