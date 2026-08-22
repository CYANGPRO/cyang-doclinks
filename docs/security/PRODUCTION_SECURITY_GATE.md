# CAT Production Security Gate

Gate status: **NOT SATISFIED** until every required item has dated evidence. `LOCAL801_PRODUCTION_LAUNCH_ENABLED` remains `0`; real member data remains prohibited.

Use `[x]` only with a linked commit, workflow run, test report, provider screenshot/export, change record, or signed operational review. `N/A` requires rationale and accountable approval.

## Code and release

- [x] CAT remains a separate app/deployment with CAT-only variable names and no DocLinks runtime fallback.
- [x] Lint, TypeScript, CAT tests, migration verification, production dependency audit, CodeQL and production build are required CI checks in source.
- [x] Dependabot configuration and lockfile/SBOM generation exist.
- [ ] Protected branch/ruleset requires CAT CI/CodeQL and review; 2026-08-22 inspection found no rule and no successful CAT CodeQL check safe to require.
- [x] No unresolved critical security findings in the 2026-08-21 source assessment; reassess after provider evidence and penetration testing.
- [ ] No unresolved high findings without explicit documented acceptance.

## Identity and access

- [x] Signup disabled; OIDC verified email + MFA claim; active account/exact role/session version revalidated.
- [x] Server-side organization/RBAC/visibility/assignment enforcement and negative tests exist.
- [ ] Production administrator/System Owner roles reviewed and emergency recovery access tested.
- [ ] Dormant/leaver/service-account review completed; no shared accounts.
- [ ] Production IdP client, callback, MFA, disablement and session revocation accepted end to end.

## Data and infrastructure

- [x] Protected PII/object encryption, separate keyrings, opaque R2 keys and protected hydration controls implemented/tested.
- [x] Production database launch gate requires explicit TLS mode.
- [ ] Production and Preview secrets, database branches/projects, R2 buckets, auth clients, scanner credentials and monitoring environments proven separate from each other and DocLinks. **Blocked:** 2026-08-22 Vercel inspection reported identical stored values for critical Production/Preview variables.
- [ ] R2 buckets proven private; public `r2.dev`/custom-domain access disabled; tokens least privilege.
- [ ] Approved data retention/deletion schedule, export handling and orphan/cleanup procedure completed.
- [ ] Encryption-key escrow/recovery/rotation procedure tested by authorized custodians.

## Detection, recovery and response

- [x] CAT audit access is scoped/bounded; audit rows append-only; protected document downloads audited.
- [ ] Audit retention approved and weekly review owner assigned.
- [ ] Centralized production monitoring/alerting configured with sensitive-data filtering; 2026-08-22 inspection found no Vercel Log Drain and alert delivery remains untested.
- [ ] CAT-local PostgreSQL distributed rate limits are implemented and passed disposable SQL concurrency tests; verify production enablement, thresholds, denial responses, fail-closed behavior and bounded cleanup for search, import, export, download and high-impact mutations.
- [ ] Daily CAT backup workflow configured and successful with a dedicated recovery bucket.
- [ ] Neon history/snapshot settings and recovery retention verified for selected plan.
- [ ] Database, R2 object and key recovery procedure documented **and quarterly restore test passed**.
- [x] CAT-specific incident plan and six required playbooks documented.
- [ ] Incident contacts/roles privately assigned and tabletop exercise completed.

## Provider, assessment and external review

- [x] Asset/software/provider inventories and CIS v8.1 IG2 matrix completed in source.
- [ ] GitHub Dependabot alerts/security updates, secret scanning/push protection and CodeQL results verified in provider settings. Dependabot/security updates, secret scanning and push protection were enabled 2026-08-22; the closeout recheck found zero CAT lockfile alerts but 112 out-of-scope repository-wide alerts, and CAT CodeQL results remain unavailable.
- [ ] Vercel deployment protection, firewall, domain/TLS, access, logs/drain and rollback settings verified. Git/root/Node settings are repaired and TLS/HSTS, protection and rollback candidates were observed; no drain exists, a new monorepo Preview has not yet supplied release evidence, and firewall rules remain unpublished log-only drafts.
- [ ] Neon, Cloudflare, IdP and scanner administrator/access/security settings verified.
- [ ] Legal/privacy/contract/retention review completed by accountable parties.
- [ ] Penetration-test status recorded: no test is currently complete; execute plan or record explicit acceptance without describing it as passed.
- [ ] CIS matrix and risk register reviewed/approved with evidence after provider/operational work.

## Final authorization

- [ ] `npm --prefix apps/local801-engage run security:production-readiness` passes in the final secret-safe production environment.
- [ ] All required CI/workflow checks pass for the exact release commit.
- [ ] Explicit production approval and non-secret review/change reference recorded.
- [ ] `LOCAL801_PRODUCTION_LAUNCH_ENABLED=1` set last and live acceptance verifies TLS, auth, revocation, private storage, scanner failure behavior, headers, caching, monitoring and backup status.
