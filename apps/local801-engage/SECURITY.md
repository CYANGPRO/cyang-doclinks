# Local 801 Engage Security

Local 801 Engage is private, invitation-only, MFA-required, and independently deployed from DocLinks. Preview role cookies and all seeded records are synthetic-only test mechanisms. **Real member data remains prohibited until the Stage 14 production-readiness gates are complete and final approval is explicit.**

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
- secret-safe Stage 14 production-readiness reporting in Settings and `npm run security:production-readiness`; blocker output contains status codes only, never credentials or raw configuration values;
- CSP, frame/object restrictions, no-store application response caching, noindex directives, COOP/CORP, and HSTS on production builds;
- the service worker caches only fixed static/offline assets, not authenticated application responses;
- synthetic seed production guards, explicit opt-in, transactional writes, stable identifiers, and fictional `example.test` identities.

## Database PII limitation — Stage 14B blocker

Object/R2 encryption does **not** encrypt ordinary PostgreSQL columns. Migration `0001` still contains potentially sensitive plaintext fields such as names, person identifiers, contact values, import `normalized_json`, correction values, selected report parameters, and notification/subscription JSON. Engagement narrative notes have a separate encrypted path, but that does not solve the broader member-data threat model.

Before real member data, Stage 14B must implement a separate database-PII protection design. It must identify protected fields, searchable/unique blind indexes, a key hierarchy separate from object-storage encryption, key rotation, additive migration/backfill, authorization and audit behavior, and the consequences for directory search, outreach queues, imports, reports, and exports. The application must prove synthetic read/write/search/report acceptance against the protected schema before `LOCAL801_DATABASE_PII_PROTECTION_ENABLED` can be set to `1`.

## Production launch interlock

`LOCAL801_PRODUCTION_LAUNCH_ENABLED` defaults to `0`. In Vercel Production, enabling OIDC alone is insufficient. The launch policy also requires, among other checks:

- `LOCAL801_PRODUCTION_AUTH_ENABLED=1` with valid HTTPS OIDC configuration;
- `LOCAL801_PREVIEW_AUTH_ENABLED=0`, `SIGNUP_ENABLED=0`, and `MFA_ENFORCE_ALL=1`;
- the canonical `https://cat.cyang.io` application/auth origin;
- a production organization that is not `local801-preview`;
- a valid private Local 801 database and R2 configuration isolated from any DocLinks variables;
- object-encryption configuration;
- the shared malware scanner enabled with the expected `scan.cyang.io` HMAC client configuration;
- `LOCAL801_DATABASE_PII_PROTECTION_ENABLED=1` only after Stage 14B acceptance;
- `LOCAL801_BACKUP_RESTORE_VERIFIED=1` only after a real restore exercise;
- `LOCAL801_SECURITY_REVIEW_APPROVED=1` and a non-secret production review/change reference;
- Preview-only durable import and authoritative execution switches disabled;
- synthetic seed opt-in disabled.

If any condition is missing, production authentication remains runtime-disabled and protected application access fails closed. Preview can continue using synthetic test authentication independently.

## Preview diagnostic boundary

`/api/health` is read-only. `/api/readiness/document-roundtrip` changes private Preview storage briefly and therefore must be exercised only behind Vercel Deployment Protection / Vercel Authentication, in addition to its Preview-only flag, production `404`, required exact-match `Origin` header, and Local Administrator role check. The synthetic role cookie is not a production identity mechanism and is not sufficient protection for an internet-accessible deployment.

Document deletion first archives and marks the database record as cleanup-pending, then deletes the private object and finally removes metadata. Failures remain retryable and are reported as cleanup-pending rather than silently treated as success.

## Remaining blockers for real data

- Complete Stage 14B database field-level protection and synthetic migration/search/report acceptance.
- Complete a formal authorization/tenant-isolation review for every page, Route Handler, mutation, export, and background task.
- Complete rate-limit coverage for high-risk search, import, export, download, and mutation paths.
- Complete audit coverage for private storage operations and operational orphan/cleanup procedures.
- Configure production monitoring/alerting with sensitive-data filtering and verify alert delivery.
- Configure backups and complete a documented restore exercise.
- Document and test object-key and PII-key rotation procedures.
- Complete incident response, privacy, retention/deletion, vendor, access-control, penetration, and deployment reviews.
- Complete final production OIDC/MFA, scanner, R2, database, TLS/domain, and session-revocation acceptance.
- Present the completed production review package for explicit launch approval.

Real member data remains prohibited until these controls are implemented, tested, and approved. Native authenticated web reporting is the application reporting architecture; there is no Power BI runtime dependency.
