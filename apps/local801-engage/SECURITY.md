# Engaging Local 801 security

Engaging Local 801 is private, invitation-only, MFA-required, and independently deployed from DocLinks. Preview role cookies and all seeded records are synthetic-only test mechanisms. **Real member data remains prohibited until the remaining production-readiness gates in `docs/ROADMAP_TO_COMPLETION.md` are complete and final approval is explicit.**

## Implemented controls

- server-only database, R2, encryption, metrics, document-service, import, and authorization modules;
- no `DATABASE_URL` fallback and no public R2 URLs;
- versioned AES-256-GCM encryption before object upload, random IVs, authenticated envelope metadata, plaintext SHA-256 verification, and rotation-compatible key lookup;
- generated object keys that do not trust filenames;
- role, document-visibility, person-level-report, organization, and assignment/scope checks before protected reads or writes;
- organization-scoped validation and atomic/audited mutation patterns for sensitive workflows;
- production OIDC authentication requiring a verified provider email and configured MFA assurance claim;
- protected production sessions revalidated against the live Local 801 user, exactly one role, deactivation state, and `auth_session_version`;
- Team & Access controls for provisioning, role changes, deactivation/reactivation, and session revocation, with Local Administrator hierarchy restrictions and System Owner protection;
- Preview authentication disabled in Vercel Production;
- shared malware scanning through `https://scan.cyang.io` with per-application HMAC authentication, bounded requests, scanner fail-closed behavior, and no scanner-side file retention;
- Stage 12 authoritative import execution remains Preview-only, synthetic-only, fingerprint-bound, and disabled by default;
- Stage 14A production launch interlock: Vercel Production authentication cannot run unless the explicit launch flag and every coded security prerequisite are satisfied;
- Stage 23 synthetic Production-origin pilot interlock: real-origin identity/device acceptance can run only after every other launch prerequisite passes, while final launch and Production durable imports remain closed;
- atomic PostgreSQL rate-limit buckets for high-risk search, import, export, download, and mutation paths, with Production fail-closed behavior;
- redacted durable document-download auditing and read-only R2/database object reconciliation;
- secret-safe Stage 14 production-readiness reporting in Settings and `npm run security:production-readiness`; blocker output contains status codes only, never credentials or raw configuration values;
- CSP, frame/object restrictions, no-store application response caching, noindex directives, COOP/CORP, and HSTS on production builds;
- the service worker caches only fixed static/offline assets, not authenticated application responses;
- synthetic seed production guards, explicit opt-in, transactional writes, stable identifiers, and fictional `example.test` identities.

## Database PII protection

Object/R2 encryption does **not** encrypt ordinary PostgreSQL columns. Migrations `0012` through `0018` and the protected PII server modules add encrypted companion records, blind indexes, guarded dual-write/protected-read modes, protected import staging and commit constraints, rotation tracking, and member contact/employment coverage. Production remains fail-closed unless the protected schema has been applied and synthetic acceptance has passed.

Before real member data, operators must apply the reviewed migrations to the isolated CAT database, run the synthetic read/write/search/import/report acceptance suite against that database, verify key custody and rotation procedures, and confirm the organization is in protected read/write mode. Only then may `LOCAL801_DATABASE_PII_PROTECTION_ENABLED` be set to `1`.

## Production launch interlock

`LOCAL801_PRODUCTION_LAUNCH_ENABLED` defaults to `0`. In Vercel Production, enabling OIDC alone is insufficient. The launch policy also requires, among other checks:

- `LOCAL801_PRODUCTION_AUTH_ENABLED=1` with valid HTTPS OIDC configuration;
- `LOCAL801_PREVIEW_AUTH_ENABLED=0`, `SIGNUP_ENABLED=0`, and `MFA_ENFORCE_ALL=1`;
- the canonical `https://cat.cyang.io` application/auth origin;
- a production organization that is not `local801-preview`;
- a valid private Local 801 database and R2 configuration isolated from any DocLinks variables;
- object-encryption configuration;
- the shared malware scanner enabled with the expected `scan.cyang.io` HMAC client configuration;
- `LOCAL801_DATABASE_PII_PROTECTION_ENABLED=1` only after protected-schema acceptance;
- `LOCAL801_BACKUP_RESTORE_VERIFIED=1` only after a real restore exercise;
- `LOCAL801_SECURITY_REVIEW_APPROVED=1` and a non-secret production review/change reference;
- Preview-only durable import and authoritative execution switches disabled;
- synthetic seed opt-in disabled.

If any condition is missing, production authentication remains runtime-disabled and protected application access fails closed. Preview can continue using synthetic test authentication independently.

## Preview diagnostic boundary

`/api/health` is read-only. `/api/readiness/document-roundtrip` changes private Preview storage briefly and therefore must be exercised only behind Vercel Deployment Protection / Vercel Authentication, in addition to its Preview-only flag, production `404`, required exact-match `Origin` header, and Local Administrator role check. The synthetic role cookie is not a production identity mechanism and is not sufficient protection for an internet-accessible deployment.

Document deletion first archives and marks the database record as cleanup-pending, then deletes the private object and finally removes metadata. Failures remain retryable and are reported as cleanup-pending rather than silently treated as success.

## Remaining blockers for real data

- Apply and pass synthetic acceptance for the implemented protected-PII migrations, read/write paths, search, import, and reporting behavior.
- Complete a formal authorization/tenant-isolation review for every page, Route Handler, mutation, export, and background task.
- Apply/accept migration `0024` and exercise limiter threshold/outage behavior in the isolated target.
- Run private-storage reconciliation and rehearse orphan/cleanup recovery against the dedicated bucket.
- Configure production monitoring/alerting with sensitive-data filtering and verify alert delivery.
- Configure backups and complete a documented restore exercise.
- Document and test object-key and PII-key rotation procedures.
- Complete incident response, privacy, retention/deletion, vendor, access-control, penetration, and deployment reviews.
- Complete final production OIDC/MFA, scanner, R2, database, TLS/domain, and session-revocation acceptance.
- Present the completed production review package for explicit launch approval.

Real member data remains prohibited until these controls are implemented, tested, and approved. Native authenticated web reporting is the sole application reporting architecture.
