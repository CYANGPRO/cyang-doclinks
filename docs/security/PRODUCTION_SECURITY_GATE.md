# CAT Production Security Gate

Gate status: **NOT SATISFIED** until every required item has dated evidence. `LOCAL801_PRODUCTION_LAUNCH_ENABLED` remains `0`; real member data remains prohibited.

Use `[x]` only with a linked commit, workflow run, test report, provider screenshot/export, change record, or signed operational review. `N/A` requires rationale and accountable approval.

## Code and release

- [x] CAT remains a separate app/deployment with CAT-only variable names and no DocLinks runtime fallback.
- [x] Lint, TypeScript, CAT tests, migration verification, production dependency audit, CodeQL and production build are required CI checks in source.
- [x] Dependabot configuration and lockfile/SBOM generation exist.
- [x] `main` protection requires strict `local801-security` and `analyze-local801` checks, one approval, stale-review dismissal, last-push approval, linear history, conversation resolution, and denies force pushes/deletion. Administrator enforcement remains off for sole-owner recovery.
- [x] No unresolved critical security findings in the 2026-08-21 source assessment; reassess after provider evidence and penetration testing.
- [x] CAT open CodeQL alerts are zero after the two high XLSX-parser findings were fixed in `09d7fad`; CAT production dependencies report zero vulnerabilities.

## Identity and access

- [x] Signup disabled; OIDC verified email + MFA claim; active account/exact role/session version revalidated.
- [x] Server-side organization/RBAC/visibility/assignment enforcement and negative tests exist.
- [x] Production administrator/System Owner test roles and recovery controls were exercised as part of the owner-confirmed three-account acceptance.
- [ ] Dormant/leaver/service-account review completed; no shared accounts.
- [x] Production Entra client/callback, MFA, provisioning, role access, disablement, revocation, stale-session, and recovery behavior were accepted end to end with three test accounts.

## Data and infrastructure

- [x] Protected PII/object encryption, separate keyrings, opaque R2 keys and protected hydration controls implemented/tested.
- [x] Production database launch gate requires explicit TLS mode.
- [ ] Production and Preview secrets, database branches/projects, R2 buckets, auth clients, scanner credentials and monitoring environments proven separate from each other and DocLinks. **Blocked:** 2026-08-22 Vercel inspection reported identical stored values for critical Production/Preview variables.
- [x] CAT application and recovery buckets are private, public `r2.dev`/custom-domain access is disabled, and recovery credentials are bucket scoped.
- [ ] Approved data retention/deletion schedule, export handling and orphan/cleanup procedure completed.
- [x] An owner-controlled Production object keyring completed guarded recovery run `32642686698`; authenticated decryption/hash and exact two-bucket cleanup passed, and all temporary credentials/secrets were deleted.

## Detection, recovery and response

- [x] CAT audit access is scoped/bounded; audit rows append-only; protected document downloads audited.
- [ ] Audit retention approved and weekly review owner assigned.
- [x] CAT-only Sentry Production delivery is redacted and its enabled high-priority email rule records two triggers. Vercel/runtime/firewall and GitHub workflow signals remain on their native provider surfaces; absence of an approved multi-source Vercel drain is recorded as residual risk.
- [x] CAT-local PostgreSQL limiter passed disposable concurrency tests and Production run `32645413253`: scoped-role privilege checks, 25 concurrent attempts, 10 allows, 15 denials, bounded cleanup, and exact synthetic absence. `LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED=1`; final authenticated HTTP smoke remains required at launch.
- [x] Daily CAT database backup workflow is configured and run `32597930819` succeeded with the dedicated private recovery bucket.
- [x] Neon protected Production branch history retention was provider-verified at 604,800 seconds (7 days); independent database dump recovery remains the longer-lived recovery control.
- [x] Database restore, bounded R2 copy, and object/key recovery procedures are documented and the first quarterly-equivalent exercise passed on 2026-08-23.
- [x] CAT-specific incident plan and six required playbooks documented.
- [ ] Incident contacts/roles privately assigned and tabletop exercise completed.

## Provider, assessment and external review

- [x] Asset/software/provider inventories and CIS v8.1 IG2 matrix completed in source.
- [x] GitHub Dependabot/security updates, secret scanning/push protection, branch protection, and CodeQL were provider-verified. CAT has zero dependency and open CodeQL findings; 112 root/Cloudflare alerts remain explicitly outside this CAT-only remediation boundary.
- [x] Vercel deployment protection, Git/root/Node settings, domain/TLS/HSTS, rollback, logs, and firewall were verified. Preview authentication POST enforcement returned Vercel 429 denials after five requests; seven other rules remain intentional live log-only observations. Sentry is the approved CAT application alert destination; no Vercel drain exists.
- [ ] Neon, Cloudflare, IdP and scanner administrator/access/security settings verified.
- [ ] Legal/privacy/contract/retention review completed by accountable parties.
- [ ] Penetration-test status recorded: no test is currently complete; execute plan or record explicit acceptance without describing it as passed.
- [ ] CIS matrix and risk register reviewed/approved with evidence after provider/operational work.

## Final authorization

- [ ] `npm --prefix apps/local801-engage run security:production-readiness` passes in the final secret-safe production environment.
- [ ] All required CI/workflow checks pass for the exact release commit.
- [ ] Explicit production approval and non-secret review/change reference recorded.
- [ ] `LOCAL801_PRODUCTION_LAUNCH_ENABLED=1` set last and live acceptance verifies TLS, auth, revocation, private storage, scanner failure behavior, headers, caching, monitoring and backup status.
