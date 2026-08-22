# CAT Application Software Security Review

## Secure development process

- Changes use version control, review, locked dependencies, CAT-specific CI/CodeQL definitions, Dependabot, SBOM generation, migration verification, tests and production build. Provider inspection on 2026-08-22 found that branch rules are not yet active and CAT CodeQL has not completed successfully, so those controls remain launch blockers rather than completed protections.
- Security findings use the vulnerability process, severity categories, root-cause analysis for material defects and regression tests where feasible.
- Production and non-production data, secrets, databases, R2 buckets, sessions and deployments remain separate; Preview is synthetic-only.

## Threat review

| Threat | Control/evidence | Residual/action |
| --- | --- | --- |
| Authentication bypass | OIDC state/PKCE, verified email, MFA claim, active user/exact role/session-version revalidation, launch interlock | Provider acceptance and failed-auth alerting pending |
| Privilege escalation/role confusion | Central permission map plus service/SQL hierarchy rechecks; server authority | Maintain route/service negative tests |
| IDOR/cross-organization access | Server-derived organization, parameterized organization joins, opaque handles, visibility/assignment checks | Independent penetration test pending |
| CSRF | Exact Origin on browser mutations; SameSite cookies; NextAuth state/PKCE | Preview login origin check added; test new mutations |
| XSS/output injection | React escaping, no injected HTML path, CSP/object/frame restrictions, validation | Inline CSP allowances are residual risk |
| SQL/injection | Parameter arrays, bounded schemas, no browser SQL fragments; safe error mapping | Continue review of dynamic query builders/PII rewriters |
| SSRF/open redirect | Fixed scanner host/canonical HTTPS validation; no arbitrary server fetch or user redirect target | Reassess every new external URL feature |
| File attack | Type+extension allowlist, filename normalization, size/stream limits, fail-closed scanner, ciphertext-only R2, attachment download | Scanner/provider and endpoint anti-malware remain shared |
| Cryptographic misuse | Node crypto AES-256-GCM envelopes, random IV, authenticated metadata, separate keyrings, integrity hashes, rotation | Key custody/recovery evidence pending |
| Sensitive logging/errors | Redacted audit payloads, generic errors, blocker codes only | Central log filtering/retention pending |
| Stale/race operations | Frozen/fingerprint-bound import/campaign state, explicit confirmation, atomic transactions/audit | Audit predecessor chain not strictly serialized |
| Unsafe dependency/deserialization | Locked dependencies, audit/Dependabot/CodeQL/SBOM; bounded JSON/form/file parsing | External scan and ongoing updates required |

Vetted framework/provider modules are used for OIDC, cryptography primitives, PostgreSQL, R2 and malware scanning rather than custom protocols. Working secure components were not rewritten for this stage.

## Focused authorization acceptance review — 2026-08-22

The review inventoried all 21 page modules, all 31 API Route Handler modules and the durable import workflow. Public pages are limited to sign-in/install/unauthorized presentation; protected pages use server-derived sessions, role permissions and organization workspace context. Authentication callbacks use NextAuth state/PKCE plus production account/session revalidation. Health/readiness functions remain fail-closed and environment-gated.

| Material path | Direct/server control | Negative evidence reviewed | Remaining acceptance |
| --- | --- | --- | --- |
| Directory, membership, new hires, outreach and follow-ups | Server organization/role/assignment scope; opaque person/follow-up handles; protected visibility before hydration | Wrong-role, malformed handle, assignment, cross-organization and protected-companion failure tests | Production OIDC/browser acceptance |
| Team administration | Same-origin route guard; `manageUsers`; SQL hierarchy/organization recheck; session-version revocation; atomic audit | Non-admin, self-change, peer/admin escalation, cross-scope and stale-session tests | Production administrator/account review |
| Campaign and CAT Action mutations | Shared same-origin/role guards; opaque handles; organization/lifecycle rechecks; atomic audit | Wrong role, wrong organization, stale state, invalid transition/handle tests | These mutations remain Preview-disabled; production design/acceptance pending |
| Imports and execution | Same-origin mutations; role/organization binding; fingerprint/review/ownership revalidation; protected-only gates; atomic audit | Unauthorized/cross-organization, stale review/fingerprint, duplicate, workflow ownership and direct API bypass tests | Production upload/execution path and provider workflow acceptance pending |
| Documents | Opaque download handle; organization/visibility authorization before R2; fail-closed scanner/storage/integrity; audit before bytes | Unauthorized visibility, cross-organization references, tampered visibility/object and audit failure tests | Upload/download/delete remain Preview-disabled; production storage acceptance pending |
| Reports and exports | `viewReports`/import permission, server organization scope, protected hydration and distributed read limit; durable report/export audit before success | Protected-companion failures, organization-scoped report queries and formula-safe/fail-closed export tests | Person-level production restriction and alert-volume acceptance pending |
| Durable import background task | Opaque batch/organization input, trusted workflow-run ownership and organization-bound SQL revalidation at each step; safe error codes | Duplicate owner, cross-organization, replay, failure-code and large SQL integration tests | Production workflow provider configuration pending |

No material direct API path was found that intentionally bypasses its server authorization boundary. This is source/test evidence, not an independent penetration test or live Production authorization acceptance. Several sensitive document, outreach, campaign and CAT mutation routes deliberately return not found in Production; keeping them disabled is safe, but their functional production readiness is unresolved.
