# Stage 20 application completion and feature freeze

> Status: the application feature scope is complete and locked on `codex/stage20-application-completion`. Stage 19 PR #24 was accepted and normally merged to `preview` as `3d2daa9135e58600e7a2e8e334e9e4c457c5fa00` before this branch was created. This document does not claim exact-head CI, Vercel Preview, rendered-browser/SQL acceptance, Production readiness, real-data authorization, native store publication or launch approval.

## Boundary

Stage 20 closes bounded application workflow and recovery gaps and records the final Production feature freeze. It remains synthetic Preview work. The owner-approved final expansion intentionally adds migration `0021`, browser-push and Capacitor dependencies, and iOS/Android projects. It does not provision Production, apply a shared migration, enable launch flags, use real member data, change DocLinks, weaken protected PII, publish native apps or authorize launch.

The implementation scope is:

- issue #21: reachable, bounded Data Imports history;
- issue #22: environment-aware account/session and unauthorized recovery;
- an internal page, Route Handler, service, mutation, download, export, worker, and seven-role audit;
- final synthetic desktop/mobile, accessibility, state, and recovery review;
- a frozen native authenticated web-reporting launch contract.
- durable campaign/CAT links, document tags/relationships, import operator cancellation/requeue and browser push;
- native iOS/Android projects that retain the network-only protected-data boundary;
- the final feature lock in `docs/FEATURE_FREEZE.md`.

Stage 22 still requires an independent authorization and organization-isolation review. This Stage 20 audit is an internal completion gate, not a substitute for that independent review.

## Seven-role authority

The live authority remains `src/lib/access.ts`. Navigation is derived from the same permission definitions and is not a separate access-control mechanism.

| Permission | System Owner | Local Admin | Membership Data Manager | CAT Admin | CAT Lead | CAT Member | Report Viewer |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Manage users, Audit, Settings | Yes | Yes | — | — | — | — | — |
| Manage/approve imports and membership corrections | Yes | Yes | Yes | — | — | — | — |
| Assign new hires | Yes | Yes | Yes | Yes | Yes | — | — |
| Manage campaigns and CAT Actions | Yes | Yes | — | Yes | — | — | — |
| Record engagement / Member 360 | Yes | Yes | — | Yes | Yes | Yes | — |
| View Directory | Yes | Yes | Yes | Yes | Yes | Yes | — |
| View personal workspace / To Do | Yes | Yes | Yes | Yes | Yes | Yes | — |
| View documents | Yes | Yes | Yes | Yes | Yes | Yes | — |
| Manage documents | Yes | Yes | Yes | Yes | — | — | — |
| View native reports | Yes | Yes | Yes | Yes | Yes | — | Yes |
| View person-level reports | Yes | Yes | Yes | — | — | — | — |
| Generate managed reports / roster exports | Yes | Yes | Yes | Yes / no roster | — | — | — |

“No” and “—” both mean the role does not receive the permission. The table separates related capabilities only where the live permission policy does. System Owner does not bypass organization scope or receive hidden routes.

## Route and service audit

| Surface family | Page authority | Route Handler / mutation authority | Service and data boundary | Audit outcome |
| --- | --- | --- | --- | --- |
| Home and install | Authenticated role-aware Home; generic install/offline content contains no member data | No protected mutation | Dashboard services authorize and scope each optional panel | Retained |
| Membership, Imports, import review, Contact Updates, Data Issues | `manageImports`; execution decisions additionally require `approveImports` | `requirePreviewUser` with `manageImports` or `approveImports`; authoritative execution remains gated | Organization and batch scoped; protected values hydrated server-side; bounded reads and controlled failures | #21 corrected; remaining contract retained |
| Directory | `viewDirectory`; Member 360 links only with `recordEngagement` | Read only | Organization/assignment scope, protected search/read, bounded keyset pages | Retained |
| New Hires | `assignNewHires`; Member 360 link still needs `recordEngagement` | `assignNewHires`, Preview-only mutation boundary | Opaque handles, active assignee validation, organization scope, transaction and atomic audit | Retained |
| Member 360, outreach, engagements, follow-ups, workload | `recordEngagement` | `recordEngagement`, same-origin and bounded request checks | Organization plus assignment scope, opaque handles, protected reads/writes, transactional audit | Retained |
| To Do and saved views | `viewPersonalWorkspace` | Same permission through work-preference authorization helpers | User/organization scoped, bounded views and notification summaries, no browser persistence | Retained |
| Campaigns | `manageCampaigns` | Campaign mutation authorization helper; Preview-only write policy | Organization/campaign locks, opaque handles, bounded criteria, confirmation revisions, atomic aggregate audit | Retained |
| CAT Actions | `manageCatActions` | CAT Action mutation authorization helper; Preview-only write policy | Organization/action scope, opaque handles, bounded tasks, atomic audit | Retained |
| Documents | `viewDocuments`; upload/delete need `manageDocuments`; visibility adds subtype permissions | Explicit view/manage permission on download, upload, delete | Opaque download handle, organization and visibility recheck, scanner, private encrypted storage, no raw storage URL | Retained |
| Reports and Data Quality report | `viewReports`; person-level drill-down remains separately authorized | No browser report mutation | Organization-scoped reporting views, bounded aggregates, protected organizer hydration, fail-closed unavailable states | Frozen below |
| Team, Audit, Settings, health/readiness probes | `manageUsers` | Team helper or explicit `manageUsers` | Organization scope, opaque user handles, redacted audit/status output, no secret values | Retained |
| Authentication and Preview role selection | Production OIDC/session binding or synthetic Preview cookies | NextAuth guarded by launch policy; Preview selection disabled in Production | Application-scoped cookies, session-version revalidation, no client profile PII | #22 corrected |

Every mutation service repeats authorization and organization checks below the page/navigation layer. Route presence, hidden navigation, or a direct URL never grants authority. Every protected page either renders a truthful empty/unavailable state or redirects through the environment-aware authentication/authorization recovery path.

## Download, export, and worker audit

| Boundary | Authority and scope | Bounded / protected behavior | Stage 20 decision |
| --- | --- | --- | --- |
| Document download | `viewDocuments`, organization, status, visibility | Opaque handle resolves server-side; encrypted object never receives a public URL | Retain |
| Import validation-error CSV | `manageImports`, organization and batch | Hard row bound, formula-safe CSV, safe filename, durable download audit | Retain |
| Rejected-row export | `manageImports`, organization and batch | Bounded validation data only; no unrestricted roster endpoint | Retain |
| Generated report storage/download service | `generateReports` / `viewReports`, plus person-level requirement when marked | Private encrypted storage and authorization recheck | Service retained; no new launch UI or bulk HTML export |
| Roster export permission | Membership-data roles only | No new general browser export was added by Stage 20 | Keep policy; operational acceptance remains later-stage work |
| Durable import worker | Server workflow identity, organization and batch | Canonical encrypted source, scanner/processing gates, bounded controlled state, no browser execution trust | Retain; Stage 21 owns outage/recovery acceptance |
| Protected import worker | Same workflow plus protected-write readiness | Exact indexes/encryption, organization scope, controlled conflict handling | Retain; Stage 21/22 own independent transaction/security acceptance |

## Issue #21 — Data Imports history

The `/imports` queue now requests only one normalized page size (10, 20, 50, or 100) plus one look-ahead row. The SQL predicate is organization-scoped before pagination and keyset-orders by creation time plus a deterministic 64-character digest token. The browser cursor contains only direction, timestamp, and that opaque token; it contains no batch UUID or filename.

Previous and Next are true bidirectional keyset links and preserve page size. Normal browser Back/forward retains the exact URL. Invalid, oversized, or structurally invalid cursors are ignored without being interpolated into SQL. A copied cursor remains constrained by the authenticated organization. First, empty, final, unavailable, desktop, and mobile states use the shared pagination/state components. Import approval and execution semantics are unchanged.

## Issue #22 — account and session recovery

The authenticated header now identifies a synthetic Preview or Production session and exposes an account/session disclosure. It serializes only authentication mode and role label to the client—not email, provider subject, user ID, organization ID, or tokens.

- Synthetic Preview offers role switching and preserves the current path and filters through the existing validated same-origin return-path function.
- The Preview role-selection client uses a credentialed same-origin request with a bounded URL-encoded body. The POST rejects any concrete cross-origin `Origin` and requires a short-lived server-HMAC token bound to the validated return path before setting either application-scoped Preview cookie. The token keeps native, sandboxed (`Origin: null`), and proxied browser navigation safe; tampered, expired, missing, wrong-path, and untrusted cross-origin submissions fail closed.
- Production offers NextAuth sign-out with a local `/sign-in` callback and never displays Preview role switching.
- Escape closes the disclosure and restores trigger focus. Trigger/action targets reach 48 px for coarse pointers; the mobile panel stays within the viewport.
- The mobile navigation and desktop utility links omit Preview switching in production mode.
- Authentication and authorization redirects clear the original query container, then store the complete local path and query as a single `next` value. The sign-in page revalidates it and rejects external origins, protocol-relative paths, backslashes/control characters, authentication loops, API targets, and oversized input.
- The existing request-protection helper is now connected through the Next.js 16 page proxy with an explicit protected-route matcher and complete permission map. Page, Route Handler, and service authorization checks remain in place; the proxy supplies early recovery and does not replace them.
- Unauthorized copy/actions distinguish signed-out, synthetic Preview, and production-account recovery. Production users are directed to their available workspace and the account/session sign-out action instead of a fake Preview role switch.

## Honest state and accessibility contract

Operational list/detail pages retain explicit empty and unavailable states; they do not replace query failures with plausible synthetic totals or records. Mutations retain disabled/submitting, controlled conflict, error, retry, and refresh behavior appropriate to the workflow. Import history distinguishes “no imports” from “no older imports.” Unauthorized recovery states disclose that no protected information was shown.

The final rendered gate must cover 1440×900 and 390×844 layouts, keyboard-only navigation, visible focus, Escape/focus restoration, mobile destination/account sheets, Back/forward, page-size pagination, final pages, signed-out and forbidden routes, console errors, failed network responses, and horizontal overflow. Static/source tests are supporting evidence only; the matching exact-head protected Preview is required for acceptance.

### Preliminary local rendered evidence

The branch was rendered locally on 2026-08-18 with synthetic Preview authentication and deliberately without a database URL. At 1440×900 and 390×844:

- sign-in, seven role switches, and each role’s derived desktop navigation rendered with the expected destinations;
- the mobile account control measured 44 px, opened within the viewport, closed with Escape, and restored trigger focus;
- `/imports?limit=50` rendered the honest unavailable state with no substitute imports and no horizontal overflow;
- CAT Member access to that URL redirected to `/unauthorized?next=%2Fimports%3Flimit%3D50`; the recovery link preserved that destination, switching back to Local Administrator returned there, and browser Back/forward retained it;
- Report Viewer rendered only Home/Reports navigation and the complete frozen report-tab set, with an honest unavailable summary because no database was configured;
- framework error overlays were absent. Development-only CSP/eval diagnostics and expected missing-database/notification failures were observed and are not treated as production-console acceptance.

This local run could not exercise import first/middle/final pages because no authorized database existed. Exact-head protected Preview must supply those data-backed pagination and console/network checks before acceptance.

## Frozen native reporting launch contract

The launch reporting system is the authenticated web workspace at `/reports`. The initial feature freeze includes exactly these views:

1. overview and CAT team coverage;
2. membership totals, changes, department, and work-location breakdowns;
3. new-hire conversion and first-contact progress;
4. recorded Member 360 activity and follow-up workload;
5. campaign population/contact/completion;
6. CAT Action task/deadline/completion;
7. aggregate protected-safe data-quality indicators.

Launch requirements are frozen as follows:

- every report requires `viewReports`; person-level information or work-queue drill-down requires its separate live permission;
- every query is server-side, parameterized, organization-scoped, bounded, and exposes no database credentials;
- report filters use fixed allowlists and bounded time periods; large rosters are never rendered as HTML exports;
- protected member names, emails, identifiers, internal UUIDs, encryption metadata, and storage locations are not aggregate-report fields;
- report query failure renders unavailable, never invented fallback facts; empty datasets render honest empty states;
- refresh/freshness labels remain visible when available;
- no new general report export is required for the initial launch UI. Any managed export continues to require its explicit role, private encrypted storage, retention decision, and later operational acceptance;
- authenticated web reports in this application are the sole reporting direction;
- new report families, scoring, rankings, productivity comparisons, propensity/support predictions, and inferred sensitive traits are outside the feature freeze.

## Schema and dependency decision

The final owner-approved scope requires forward migration `0021` for tenant-qualified campaign/CAT links, document tags/typed relationships and import cancellation lifecycle fields. Browser push uses the pinned `web-push` server package. Native shells use pinned Capacitor 8 core/CLI/iOS/Android packages. No database was modified during local development; migrations remain separately applied and accepted per environment.

## Acceptance checklist

- [x] Stage 19 accepted and merged to `preview` before Stage 20 branching.
- [x] #21 implemented with focused organization/bounds/cursor/UI regressions.
- [x] #22 implemented with focused environment/recovery/focus/target regressions.
- [x] Internal route/service/mutation/download/export/worker and role-policy source audit recorded.
- [x] Native authenticated reporting launch requirements frozen in the repository.
- [x] Local lint, typecheck, all 723 tests, 21-migration verification, full dependency audit (zero vulnerabilities), Capacitor native sync, and production build pass on the combined branch tree; rerun on the final commit before publication.
- [x] No disposable SQL run was attempted: on 2026-08-18 `LOCAL801_SQL_TEST_DATABASE_URL`, `LOCAL801_DATABASE_URL`, `VERCEL_ENV`, and `NODE_ENV` were all absent, so a database named exactly `local801_sql_test` could not be positively authenticated. This is recorded unexecuted, not treated as a pass.
- [ ] Exact-head GitHub CI and matching Vercel Preview succeed.
- [ ] Authenticated desktop/mobile, seven-role, keyboard, recovery, console/network, and pagination evidence is recorded for that exact deployment.
- [ ] Issues #21 and #22 are closed by the accepted implementation.
- [x] Chang Yang explicitly accepts the initial product feature freeze. Production and real data remain separately prohibited.
- [ ] Chang Yang accepts the exact-head Stage 20 merge after CI and Preview acceptance.
