# Local 801 Engage Production-Readiness Checklist

## Current decision

**Real member data is still prohibited.** Stage 14A adds a fail-closed production launch interlock, but the database PII-protection migration, backup/restore acceptance, final security review, and production infrastructure acceptance are not complete.

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

## Required before real data or production launch

- [ ] Complete Stage 14B database field-level PII protection and its searchable blind-index design.
- [ ] Apply and acceptance-test the reviewed PII migration using synthetic data before any real member data is introduced.
- [ ] Complete the authorization/tenant-isolation review for every page, Route Handler, mutation, export, document path, and background task.
- [ ] Complete rate-limit coverage for high-risk read/write/search/export/download paths.
- [ ] Complete storage-operation auditing and orphan/cleanup operational procedures.
- [ ] Configure a separate approved production PostgreSQL database and apply every reviewed migration in order.
- [ ] Configure a separate production private R2 bucket and least-privilege production credentials.
- [ ] Generate a separate production object-encryption keyring and the separate Stage 14B PII key hierarchy; escrow/rotation procedures must be documented.
- [ ] Configure the approved production OIDC client/callback and verify MFA assurance end-to-end with test production accounts.
- [ ] Provision production Local 801 users through Team & Access; self-service signup remains disabled.
- [ ] Configure the production scanner client secret separately from Preview and pass clean/infected/outage acceptance tests.
- [ ] Configure production monitoring/alerting with sensitive-data filtering and verify an alert path.
- [ ] Configure database/object backups and perform a documented restore exercise; only then set `LOCAL801_BACKUP_RESTORE_VERIFIED=1`.
- [ ] Complete privacy, retention/deletion, incident-response, vendor, access-control, and penetration/deployment reviews.
- [ ] Confirm no real sample/member files or credentials are committed to GitHub and no plaintext member files remain in temporary operational locations.
- [ ] Record final security approval and non-secret review/change reference; only then set `LOCAL801_SECURITY_REVIEW_APPROVED=1` and `LOCAL801_PRODUCTION_SECURITY_REVIEW_ID`.
- [ ] Obtain explicit production launch approval from Chang Yang after the completed review package is presented.
- [ ] Set `LOCAL801_DATABASE_PII_PROTECTION_ENABLED=1` only after Stage 14B acceptance proves the application is actually using the protected schema.
- [ ] Set `LOCAL801_PRODUCTION_LAUNCH_ENABLED=1` **last**, after every other launch blocker is cleared.
- [ ] Verify `npm run security:production-readiness` exits successfully using the final production environment without printing secret values.
- [ ] Verify `cat.cyang.io`, TLS, authenticated access, health/readiness behavior, private R2 access, scanner fail-closed behavior, and production session revocation after the final deployment.

## Production invariants

The following remain mandatory after launch: `SIGNUP_ENABLED=0`, `MFA_ENFORCE_ALL=1`, `LOCAL801_PREVIEW_AUTH_ENABLED=0`, `LOCAL801_ALLOW_SYNTHETIC_SEED=0`, `LOCAL801_DURABLE_IMPORTS_ENABLED=0`, and `LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED=0` unless a later production-specific design explicitly replaces those Preview-only paths.
