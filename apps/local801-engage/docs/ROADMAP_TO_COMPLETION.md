# Engaging Local 801 roadmap to completion

This is the authoritative post-Stage-18 roadmap for Engaging Local 801. Earlier stage plans and acceptance notes remain evidence, but when their future-work statements conflict with this document, this document controls.

## Project finish line

Project completion means more than merged code. Engaging Local 801 is complete when an approved, production-ready PWA operates at `cat.cyang.io`; invitation-only users authenticate through production OIDC with MFA; approved real member data uses the protected-PII architecture; all seven roles and essential workflows are accepted; a limited pilot has completed; and monitoring, restoration, incident response, training, support, and ownership are operating reliably.

Chang Yang remains System Owner and final launch approver unless a later written transfer agreement records a different owner. Native Apple/Android shells are included in the feature freeze. Authenticated custom web reports are the sole reporting system.

## Non-negotiable boundaries

- Preview remains synthetic-data-only. Use fictional `example.test` identities and generated records.
- Production deployment, production authentication, real member data, and production launch flags remain unauthorized until the applicable later-stage gates and explicit owner approval are complete.
- DocLinks is a separate application. Its routes, database, storage, authentication, billing, secrets, document records, and production deployment are outside this project.
- Migrations are forward-only and are never applied to a shared Preview or Production database merely to satisfy a development gate.
- Role, organization, protected-PII, encryption, scanner, audit, no-store, and service-worker restrictions may not be weakened.
- Opaque member scoring, rankings, propensity predictions, political profiling, or other hidden sensitive inference are not product work.

## Current baseline

| Item | Baseline on 2026-08-19 |
| --- | --- |
| Last accepted product stage | Stage 20 — Application completion and feature freeze; consolidated into `preview` by PR #31 |
| Stage 18 accepted head | `2514a457f1ddf09770fac1cabff7482b3771d20c` |
| Stage 18 merge | PR #23, merge commit `5ae0b64b77bbda83880a5a3bc43fa0936cae48b7` into `stage17h-pwa-field-mode` |
| Current integration branch | Protected `main` at `78d51ffe858d27856aba38796f5a0f36cf6a7157` (PR #52); every change remains pull-request and required-check gated |
| Stage 19 integration commit | `1fead9fdf0e86c487d12c40dd643c53db6070bab` |
| Development target | Protected `main`; synthetic acceptance continues on isolated Vercel Preview deployments |
| Preview status | Synthetic-only acceptance environment; deployment protection and application authentication are separate controls |
| Production status | Latest code is deployed at `cat.cyang.io`, but application launch and real data remain locked; the exact-tree preflight reports only `SECURITY_REVIEW_NOT_APPROVED` with database and storage `ok` |
| Database chain | 24 checked-in forward migrations, `0001` through `0024`; target databases still require environment-specific verification |
| Application areas | Home/command center, Membership, Directory, Imports, Member 360/outreach, follow-ups/workload, campaigns, CAT Actions, new hires, contact/data-quality corrections, documents, reports, audit, notifications/saved views, Team & Access, Settings, PWA/install and field views |
| Product scope | Feature complete and locked on `main`; #21 and #22 are implemented; only security, operations, pilot, and release work is allowed |
| Known document limitation | Pre-Stage-19 documents combine historical snapshots with future plans. Their exact evidence remains useful, but stale planning statements are superseded by this roadmap. |

## Evidence-based capability status

The status labels in this table are deliberately constrained. “Complete in synthetic Preview only” is not Production approval or authorization for real data.

| Capability or requirement | Status | Evidence | Remaining work | Target stage |
| --- | --- | --- | --- | --- |
| Stage 14B protected-PII application path | Complete in synthetic Preview only | PR #5; migrations `0012`–`0017`; `docs/ACCEPTANCE_2026-08.md`; protected read/write/search/report/import and key-rotation tests | Provision production keys/resources, independently re-accept, and authorize real data | 22–24 |
| Durable scanner-backed CSV/XLSX import processing | Accepted in synthetic Preview | Migration `0006`; durable worker/scanner tests; isolated Preview R2 and scanner credentials; 2026-08-19 live clean scan, three-row Workflow completion, cooperative running cancellation, audited requeue, second-attempt completion, cross-deployment persistence, protected 25,000-row XLSX completion after the upload client exited, and deployment-pinned runless recovery | Complete the remaining dependency-outage and reconciliation exercises | 21–22 |
| Protected authoritative import execution | Complete in synthetic Preview only | Protected executor, approval/preflight gates, Stage 14B acceptance evidence and tests | Production-specific enablement decision and transaction/reconciliation acceptance; keep disabled by default | 21–24 |
| Production import operation | Code complete; substantial Preview acceptance complete | Separate protected durable worker gate; protected-only/launch coupling; CSV/XLSX bounds and operator controls; Preview batch `c4674e31-8fd6-4c25-8d38-07b7c1436628` proved running cancellation plus requeue to `ready_for_review` with an incremented attempt and audit events; batch `bf3bb27a-fcfa-46ac-8cd6-8627c58cb3b5` proved protected 25K XLSX processing | Finish the remaining outage/reconciliation exercises and keep authoritative execution disabled during the synthetic pilot | 21–24 |
| XLSX asynchronous parsing | Accepted in synthetic Preview | Shared parser preflights ZIP metadata, streams emitted-byte counters, enforces archive/XML/cell/row bounds and stages multiple included sheets after a clean malware verdict; local 25K benchmark passed; protected Preview deployment `dpl_4XADbBjbkRx7hVjycXu9Xk5jCWuZ` completed Workflow run `wrun_01M0E1DF3CTQDAM7ZSS6VZA30X` with 25,000 rows and `ready_for_review` after the upload client exited | Complete the remaining abuse/outage/recovery cases and independent review before launch | 21 |
| Membership and Directory | Complete in synthetic Preview only | Current routes/services, protected reads, organization/role scopes, Stage 15–17 tests | Final seven-role, mobile, accessibility, error/recovery, and Production-like acceptance | 20, 23 |
| Member 360, outreach, engagements, follow-ups and workload | Complete in synthetic Preview only | Current routes/services and Stage 17 Member 360/workflow tests | Final role/route, recovery, mobile and pilot acceptance | 20, 23 |
| Campaigns and Stage 18 bulk population/assignment | Complete in synthetic Preview only | PR #23; bounded preview/apply services; deterministic selection/revisions; 20K synthetic acceptance | Final workflow review and pilot acceptance; optional future assignment enhancements remain separate | 20, 23 |
| CAT Actions and new-hire workflows | Complete in synthetic Preview only | Current pages/APIs/services, authorization and Stage 15/17 tests | Final seven-role, recovery, mobile and pilot acceptance | 20, 23 |
| Contact and direct data-quality corrections | Complete in synthetic Preview only | Migrations `0019`–`0020`; current routes/services; Stage 17I/J tests | Final authorization/transaction audit and Production-like acceptance | 20, 22–23 |
| Documents, tags, relationships and encrypted private object storage | Code complete; environment acceptance pending | AES-256-GCM envelope, private R2 services, scanner boundary, archive/cleanup state, migration `0021`, metadata services/UI/tests | Apply/accept migration in protected Preview; Production bucket/keys, audit, orphan cleanup and recovery | 21–23 |
| Native authenticated web reporting | Complete in synthetic Preview only | `/reports` and data-quality/campaign/CAT reporting services and tests | Freeze final launch requirements, verify role/data minimization, exports, limits and pilot usability | 20, 22–23 |
| Audit trail | Partially complete | Organization-scoped redacted audit services/UI and workflow mutation tests | Complete coverage review and protected export acceptance; owner approved the standard non-serialized integrity model | 20–22 |
| PWA, browser push and static offline behavior | Code complete; environment acceptance pending | Manifest/install flow; encrypted push subscriptions and generic delivery; service worker caches only generic offline/static assets | Configure owner VAPID keys and accept delivery in protected Preview/Production; never cache protected data | 20, 22–23 |
| Production OIDC, session control and policy acknowledgment | Code foundation complete; environment acceptance pending | Verified-email/MFA claim checks, database session revalidation, Team & Access controls, versioned first-sign-in policy gate and fail-closed Production policy | Configure approved Entra provider/Conditional Access and test every role, acknowledgment and account/session lifecycle at the Production origin | 20, 22–23 |
| All seven role definitions | Complete | `src/lib/access.ts`: System Owner, Local Administrator, Membership Data Manager, CAT Administrator, CAT Lead, CAT Member, Report Viewer | End-to-end matrix acceptance with Production identity is still required | 20, 23 |
| Independent authorization and organization-isolation review | Required before production | Existing authorization tests and source controls are internal evidence only | Independent page/API/service/worker/export/download review and correction package | 22 |
| Rate limiting | Code complete; environment acceptance pending | Migration `0024`; atomic organization/user buckets for search/import/export/download/mutation; Production fail-closed behavior and tests | Apply migration and exercise thresholds/outage behavior in the isolated target | 22 |
| Storage auditing and orphan cleanup | Code complete; environment acceptance pending | Redacted document download audit, existing upload/delete/import/report audits and compensation, read-only R2/database reconciliation command | Apply/rehearse against private Preview/Production buckets and resolve every discrepancy | 21–22 |
| Backup, PITR, disaster recovery and restoration | Required before production | Launch policy requires a verified restore flag; owner approved one-hour RPO/four-hour RTO and eight-hour document recovery | Configure backups/PITR, perform and document restoration against the approved objectives | 21–22 |
| Safe logging, monitoring, alerting and SLOs | Required before production | Secret-safe readiness output and safe error-code patterns exist | Production telemetry, filters, alerts, dashboards, SLOs and response rehearsal | 22–24 |
| Retention, deletion, correction, privacy, vendor, incident and access-control procedures | Decisions approved; operational documents/exercises pending | Technical controls plus `docs/OWNER_DECISIONS_2026-08-18.md` | Publish counsel-reviewed policies/runbooks, assign named operators and complete exercises | 21–22 |
| Security, dependency, CSP, threat-model and penetration review | Required before production | Automated tests, audit/build checks and hardened headers are internal evidence | Independent reviews, findings closure, accessibility evidence and final security package | 22 |
| Dedicated production infrastructure and secrets | Decisions approved; provisioning pending | Approved Vercel Cleveland, Neon Ohio, R2 `enam`, Entra, Sentry, push and owner VPS scanner in `docs/OWNER_DECISIONS_2026-08-18.md` | Provision isolated resources, owner credentials, least privilege, monitoring and the USD 300/month controls | 22–23 |
| Training, support, ownership and handoff | Required before production | Chang Yang is current owner/final approver | Name pilot/support participants, train users, approve runbooks and record long-term ownership | 23–25 |
| Native iOS/Android packaging | Code complete; feature-locked and deferred | Capacitor 8 iOS/Android projects, HTTPS-only canonical app, no native protected offline store | Post-launch only: owner signing identities, app links, device acceptance and App Store/Play review | Deferred |
| Durable Campaign-to-CAT-Action links | Code complete; environment acceptance pending | Migration `0021`, bidirectional workspace reads, opaque same-tenant mutations and atomic audit | Disposable SQL and protected Preview concurrency/role acceptance | 20–22 |
| Expanded import operator controls | Accepted in synthetic Preview | Migration `0021`; queued/running cancel semantics; safe-boundary acknowledgement; live 2026-08-19 running cancel, audited requeue, second-attempt completion and deployment-rollover evidence | Retain race/outage checks in the final independent review | 21 |
| Opaque scoring and sensitive inference | Permanently excluded | Stage 17 product guardrails and this roadmap | Preserve exclusions in future design/review | Permanent |
| Earlier scattered future-stage plans | Superseded | This roadmap reconciles current implementation, accepted PRs and current blockers | Retain historical evidence but direct all future planning here | 19 |
| Production readiness of current exact tree | Code and infrastructure preflight accepted; launch still blocked | Exact `main` commit `78d51ff` passed GitHub CI, matching Vercel Preview acceptance, and Production build preflight in deployment `dpl_5hpxQbC2sCAC3gdTNmNphhNmSuZc`; database and storage are `ok` and the sole coded blocker is `SECURITY_REVIEW_NOT_APPROVED` | Complete independent review, Entra/MFA and push acceptance, the three-day synthetic pilot, and explicit launch/real-data approval | 22–24 |

## Remaining stages

### Stage 19 — Roadmap, branch, and documentation consolidation

Purpose: reconcile accepted history and create a single evidence-based plan without adding major functionality.

Exit criteria:

- Stage 18 is merged into its intended development chain.
- The Stage 17/18 chain is normally merged into a branch created from exact `preview`, preserving the `preview`-only commit.
- This authoritative roadmap exists and contradictory current documents are corrected or marked superseded.
- Remaining Stages 20–25 are represented by bounded GitHub tracking issues.
- The draft Stage 19 PR targets `preview`, and its exact head passes CI, matching Vercel Preview deployment verification, and representative desktop/mobile integration checks.

### Stage 20 — Application completion and final workflow acceptance

Required scope:

- Implement #21 bounded Data Imports history pagination and #22 production-aware account/session controls.
- Complete a page, Route Handler, service, mutation, download, export, worker and all-seven-role audit.
- Perform final desktop/mobile UI/UX and accessibility review.
- Complete empty, loading, unavailable, error, retry and recovery states without plausible fallback data.
- Freeze and accept launch reporting requirements using native authenticated web reports.
- Correct only verified integration/workflow defects, then enter the initial production feature freeze.

### Stage 21 — Import and data-operations readiness

Required scope:

- Accept the implemented CSV plus safely bounded asynchronous XLSX path in protected Preview.
- Review the implemented pre-allocation ZIP/worksheet/shared-string/cell/row/compression bounds and generated abuse cases; repeat the recorded local 25K benchmark in protected Preview.
- Exercise scanner, Neon, R2 and Workflow failures; retries; browser close; deployment rollover; runless-job recovery; failed-job recovery; processing-version compatibility; and observability.
- Independently accept the protected authoritative import transaction, replay/idempotency, concurrency, reconciliation, audit and rollback behavior.
- Approve retention, correction, archive, deletion and export procedures.
- Perform backup and restoration exercises and publish operator runbooks.

### Stage 22 — Security and production infrastructure

Required scope:

- Complete an independent authorization and organization-isolation review.
- Complete high-risk route/search/import/export/download/mutation rate limits.
- Complete private-storage audit coverage, orphan reconciliation and cleanup recovery.
- Provision dedicated Production Neon, private R2 and related Vercel resources, with approved regions and least-privilege credentials isolated from Preview and DocLinks.
- Generate and escrow separate Production object-encryption, PII-encryption and blind-index keys; rehearse rotation and recovery.
- Implement PII-safe logging, monitoring, alerting, dashboards and SLOs.
- Configure backup, PITR and disaster recovery; prove restoration against approved RPO/RTO.
- Approve privacy, retention/deletion, incident-response, vendor and access-control procedures.
- Complete dependency, CSP, accessibility, threat-model and penetration reviews; close findings; assemble the final security evidence package.

### Stage 23 — Production identity and synthetic pilot

Required scope:

- Configure Production OIDC, verified-email assurance, MFA and invitation-only provisioning.
- Verify all seven roles, sign-in/sign-out, unauthorized recovery, deactivation/reactivation, role changes and session revocation.
- Accept the production scanner clean/infected/unavailable paths.
- Configure and verify `cat.cyang.io` and TLS without authorizing real data.
- Run a limited synthetic-data pilot with named participants, training, feedback collection and launch-blocker corrections.

### Stage 24 — Controlled real-data launch

Required scope:

- Present the complete evidence package and obtain explicit final approval from Chang Yang or the written successor owner.
- Run `npm run security:production-readiness` against the final environment and resolve every blocker without exposing secrets.
- Set database-PII, security-review, backup/restore and production-launch flags only in the approved sequence; set the launch flag last.
- Record explicit real-data authorization, load the initial approved roster and reconcile it to the approved source.
- Begin with limited CAT leadership access, then expand access only through an approved control point.
- Monitor launch, staff support, and keep tested rollback/suspension procedures ready.

### Stage 25 — Stabilization, training, and handoff

Required scope:

- Complete administrator and user training, operating runbooks and access-request procedures.
- Assign support ownership and rehearse incident, correction and escalation handling.
- Close launch-period defects and record accepted residual risks.
- Decide and document long-term ownership, including a potential MAPE transfer package.
- Record intellectual-property/licensing status and reimbursement/value documentation if requested.
- Approve the maintenance, dependency-update, backup-test and release policy.
- Formally transition from development to maintenance.

## Stage entry and exit gates

### Stage 19 gate

| Gate | Requirement |
| --- | --- |
| Entry | Stage 18 exact head accepted and normally merged; user approval to reconcile branches |
| Allowed scope | Git history reconciliation, roadmap/docs, trackers, verification, integration regression fixes only |
| Prohibited scope | Stage 20 features, real data, Production, migrations, secrets, dependencies, DocLinks, native packaging |
| Evidence | Ancestry record, preserved divergent commit, branch inventory, reconciled documents and tracking issues |
| CI | Install, lint, typecheck, full tests, migration verification, production dependency audit, build, diff check; disposable SQL when safely available |
| Database/migration decision | No new migration and no shared-database application |
| Rendered browser | Exact-head synthetic desktop and mobile representative-route integration acceptance |
| Security/approval | Boundaries unchanged; draft PR remains unmerged until explicit approval |
| Next-stage dependency | Stage 20 begins only after Stage 19 acceptance and merge to `preview` |

### Stage 20 gate

| Gate | Requirement |
| --- | --- |
| Entry | Stage 19 accepted into `preview`; #21/#22 and route/role audit scope confirmed |
| Allowed scope | Bounded workflow completion, UI/accessibility/recovery corrections, reporting freeze |
| Prohibited scope | Production provisioning, real data, launch flags, unrelated enhancements |
| Evidence | Route/service/role matrix, issue acceptance, rendered UI/accessibility report, frozen launch requirements |
| CI | Full local and exact-head CI; focused regression and role tests for every change |
| Database/migration decision | Prefer none; any essential forward migration needs separate review and disposable-DB acceptance |
| Rendered browser | Desktop/mobile all major routes, seven roles, failures/recovery, console/network review |
| Security/approval | Internal auth/data-minimization review; owner accepts feature freeze |
| Next-stage dependency | Stable frozen application tree is the base for data-operations acceptance |

### Stage 21 gate

| Gate | Requirement |
| --- | --- |
| Entry | Stage 20 workflow acceptance and feature freeze; explicit CSV/XLSX decision |
| Allowed scope | Import safety/recovery, authoritative transaction evidence, data lifecycle, restore and runbooks |
| Prohibited scope | Shared/Production migration application, real data, general product expansion |
| Evidence | Generated 25K/abuse/outage/replay/recovery results, reconciliations, restoration report and runbooks |
| CI | Full CI plus disposable SQL concurrency/integration and bounded parser suites |
| Database/migration decision | Forward migrations only if essential; independent review, rollback/compatibility plan, isolated DB first |
| Rendered browser | Import lifecycle, progress/failure/retry/review/apply/reconciliation at desktop/mobile sizes |
| Security/approval | Scanner fail-closed, PII-safe workflow state/logs, destructive lifecycle procedures approved |
| Next-stage dependency | Accepted data operations and restore evidence feed Stage 22 security review |

### Stage 22 gate

| Gate | Requirement |
| --- | --- |
| Entry | Frozen application/data paths and Stage 21 recovery evidence |
| Allowed scope | Security findings, rate limits, dedicated infrastructure, keys, telemetry, DR and policy controls |
| Prohibited scope | Real data, broad access, production launch, feature expansion |
| Evidence | Independent reports/findings closure, resource/isolation inventory, alerts, rotation and restore evidence, final security package |
| CI | Full CI, dependency/secret checks, security suites and Production-like synthetic acceptance |
| Database/migration decision | Reviewed chain applied only to isolated approved Production resources under change control; still no real data |
| Rendered browser | CSP/auth/error/accessibility verification in Production-like synthetic environment |
| Security/approval | Independent authorization, threat and penetration reviewers sign off; owner accepts residual risk |
| Next-stage dependency | Cleared security package and ready isolated infrastructure permit synthetic Production pilot |

### Stage 23 gate

| Gate | Requirement |
| --- | --- |
| Entry | Stage 22 security acceptance, isolated Production resources, named synthetic pilot participants |
| Allowed scope | Production identity/domain/scanner configuration and synthetic pilot corrections |
| Prohibited scope | Real member data, broad CAT access, launch authorization |
| Evidence | Seven-role identity/session matrix, TLS/domain/scanner evidence, training and pilot report |
| CI | Exact release-head CI and deployment metadata; no unreviewed post-freeze changes |
| Database/migration decision | Verify reviewed chain/state; no new migration without restarting applicable evidence gates |
| Rendered browser | Authenticated desktop/mobile pilot across every launch-critical workflow and role |
| Security/approval | MFA/invitation/session controls and deployment protection accepted; owner closes pilot blockers |
| Next-stage dependency | Successful synthetic pilot and complete launch package permit Stage 24 approval request |

### Stage 24 gate

| Gate | Requirement |
| --- | --- |
| Entry | All Production readiness blockers cleared; explicit written launch and real-data authorization |
| Allowed scope | Controlled roster load, reconciliation, limited access, monitoring and blocker corrections |
| Prohibited scope | Unapproved data, uncontrolled access expansion, optional enhancements |
| Evidence | Approval/change record, readiness output, initial roster reconciliation, access log, monitoring and support record |
| CI | Exact launch SHA green and immutable; emergency corrections use the approved release process |
| Database/migration decision | No launch-time schema improvisation; only already-reviewed/applied chain |
| Rendered browser | Final `cat.cyang.io` desktop/mobile, roles, scanner, session revocation and critical workflows |
| Security/approval | Launch flags set last; continuous monitoring; rollback/suspension authority named |
| Next-stage dependency | Stable controlled access and reconciled data begin the stabilization window |

### Stage 25 gate

| Gate | Requirement |
| --- | --- |
| Entry | Controlled launch operating within accepted SLOs and no unresolved launch blocker |
| Allowed scope | Defect closure, training, runbooks, support, ownership/licensing/maintenance decisions |
| Prohibited scope | Silent scope expansion or removal of launch security controls |
| Evidence | Training attendance, runbooks, support rota, defect/risk record, ownership and maintenance documents |
| CI | Maintenance baseline remains green; release/update policy is demonstrated |
| Database/migration decision | Normal controlled maintenance process; restoration cadence retained |
| Rendered browser | Regression/smoke acceptance after launch-period fixes |
| Security/approval | Access recertification and incident/escalation ownership accepted |
| Next-stage dependency | Formal owner sign-off transitions the project to maintenance |

## Definition of done levels

| Level | Meaning |
| --- | --- |
| Code complete | Implemented, reviewed, tested and documented on a branch; no environment acceptance implied |
| Preview accepted | Exact head passes CI, matching protected Vercel Preview and synthetic browser/database evidence; no Production or real-data approval implied |
| Production ready | Independent security/operations evidence, isolated infrastructure, identity, recovery, policies and launch package are complete; launch still requires explicit approval |
| Launched | Explicit owner and real-data authorization are recorded, launch flags are set in order, initial data reconciles, and controlled users operate at `cat.cyang.io` |
| Operationally stable | Stabilization SLOs hold, launch defects are closed/accepted, restoration/support/incident processes operate, and access is controlled |
| Formally handed off | Long-term owner, support, maintenance, access, licensing and transfer records are signed and development has transitioned to maintenance |

## Feature freeze

The final expansion requested by the System Owner is implemented and the product scope is now locked. `docs/FEATURE_FREEZE.md` controls when older documents describe native applications, durable campaign/CAT links, document metadata, import controls or browser push as optional or deferred. Deterministic round-robin assignment, campaign templates, additional saved-view families and other product enhancements are outside the freeze unless the owner explicitly unlocks scope.

## Permanent exclusions

- opaque member scoring;
- organizer rankings;
- propensity or support-likelihood predictions;
- political profiling;
- hidden sensitive inference;
- weakening role or organization scope;
- browser storage or service-worker caching of protected member data.

## Branch inventory

The feature-complete tree and subsequent production-readiness hardening are consolidated on protected `main` at `78d51ff`. No release-engineering feature branch remains active. Vercel may deploy reviewed `main` commits, but application launch, Production identity, authoritative imports and real data remain independently gated. Accepted Stage 14–19 evidence branches remain; obsolete/temporary branches were removed after ancestry review. Two unique historical Stage 7 tips are preserved as `archive/2026-08-18/*` tags.

## Owner decisions

The product, identity, infrastructure, recovery, pilot, governance, distribution, support and ownership choices needed before Stage 21/22 execution are resolved in `docs/OWNER_DECISIONS_2026-08-18.md`. Operational names, credentials, independent evidence, real-data authorization and final launch approval remain deliberately deferred release gates rather than unanswered product decisions.

## Planning and evidence links

- Completed feature-lock issues: [#21 Data Imports history pagination](https://github.com/cyangprojects-sys/cyang-cat-data/issues/21), [#22 account/session controls](https://github.com/cyangprojects-sys/cyang-cat-data/issues/22), and [#25 Stage 20](https://github.com/cyangprojects-sys/cyang-cat-data/issues/25).
- Stage trackers: [#25 Stage 20](https://github.com/cyangprojects-sys/cyang-cat-data/issues/25), [#26 Stage 21](https://github.com/cyangprojects-sys/cyang-cat-data/issues/26), [#27 Stage 22](https://github.com/cyangprojects-sys/cyang-cat-data/issues/27), [#28 Stage 23](https://github.com/cyangprojects-sys/cyang-cat-data/issues/28), [#29 Stage 24](https://github.com/cyangprojects-sys/cyang-cat-data/issues/29), and [#30 Stage 25](https://github.com/cyangprojects-sys/cyang-cat-data/issues/30).
- Milestones: [Stage 20](https://github.com/cyangprojects-sys/cyang-cat-data/milestone/1), [Stage 21](https://github.com/cyangprojects-sys/cyang-cat-data/milestone/2), [Stage 22](https://github.com/cyangprojects-sys/cyang-cat-data/milestone/3), [Stage 23](https://github.com/cyangprojects-sys/cyang-cat-data/milestone/4), [Stage 24](https://github.com/cyangprojects-sys/cyang-cat-data/milestone/5), and [Stage 25](https://github.com/cyangprojects-sys/cyang-cat-data/milestone/6). Issues #21 and #22 are mapped to Stage 20.
- Stage 14B evidence: `docs/STAGE14B_PROTECTED_CUTOVER.md` and `docs/ACCEPTANCE_2026-08.md`.
- Import design/evidence: `docs/IMPORT_BACKGROUND_PROCESSING.md`.
- Stage 17 evidence: `docs/STAGE17_ADVANCED_WORKFLOWS.md`.
- Stage 18 evidence: `docs/STAGE18_CAMPAIGN_SCALABILITY.md`.
- Stage 20 implementation, route/role audit, and reporting freeze: `docs/STAGE20_APPLICATION_COMPLETION.md`.
- Owner-approved launch decisions: `docs/OWNER_DECISIONS_2026-08-18.md`.
- Production controls: `SECURITY.md`, `PRODUCTION_READINESS.md`, and `DEPLOYMENT_CHECKLIST.md`.

The Stage 20–25 trackers are intentionally bounded parent issues. Create child issues later only for independently executable work that cannot be tracked clearly in the parent.
