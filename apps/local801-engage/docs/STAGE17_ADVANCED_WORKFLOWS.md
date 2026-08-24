# Stage 17 — Advanced Workflow Functionality & Automation

> Historical scope note: Stage 17’s migration-free campaign/CAT handoff was later superseded by the owner-approved durable relationship in migration `0021` and `FEATURE_FREEZE.md`. Stage 17 evidence remains valid for its original context, but its future-work deferrals do not control the final feature scope.

> Closure status: Stage 17J was accepted through PR #20 at head `116789cc46216cd5d2efdee47d817a1c5aa08910` and merge commit `f5500ae27e1e48d90d19232f5ec7a5b334028e27`, with exact-head CI, matching Vercel Preview, and authenticated desktop/mobile evidence. The “snapshot contains no deployment record” limitation retained later in this document is historical and superseded by that closure evidence. Preview remained synthetic-only; Production and real data were not authorized. Future planning is in `ROADMAP_TO_COMPLETION.md`.

## Purpose

Stage 17 added higher-value workflow functionality after Stage 16 stabilized the application's visual and accessibility foundation.

The goal was to reduce organizer/admin memory work, duplicate entry, manual interpretation, and unnecessary navigation while preserving the protected PII, authorization, scanner/import, audit, and production-launch controls proven in synthetic Preview.

## Permanent exclusion: opaque scoring

Engaging Local 801 will not add hidden or opaque scores that attempt to rank a member, organizer, leader, political/union propensity, support likelihood, or similar sensitive inferred characteristic.

When the product prioritizes work, it must use understandable facts that the authorized user can inspect, such as due dates, assignment state, recorded outcomes, lifecycle events, campaign participation, user-entered Action Readiness, explicit workflow state, and data-quality exceptions.

No silent sensitive inference is permitted.

## Guardrails

- Preview remains synthetic-only.
- No Production provisioning or launch changes.
- No DocLinks changes.
- Protected PII stays protected-only and fail-closed.
- Scanner-backed imports and authoritative execution controls remain unchanged unless a separately reviewed workflow enhancement requires a safe extension.
- New automated actions must be visible, explainable, authorized, and audited where they mutate durable state.
- Suggestions are not mutations. The user confirms creation, assignment, rescheduling, or other durable actions.
- New persistence is added only when existing data cannot represent the workflow safely and usefully.

## Implementation waves

### 17A — Transparent workflow assistance — complete

- factual New Hire onboarding lifecycle;
- user-approved outcome-aware follow-up timing suggestions;
- protected import review explanations using safe reason categories and field names only.

### 17B — Command center and drill-through — complete

Schema changes: **none**.

Home is a role-aware command center using explicit assignments, due dates, engagement history, lifecycle events, import state, campaigns, and CAT Actions. Drill-through scope matches the scope used to calculate each aggregate. Urgent work and future work are separated. No hidden scoring or “since your last visit” tracking was added.

### 17C — Campaign and CAT Action integration — complete

Schema changes: **none**.

Campaign progress is a factual population → assigned → contacted → completed funnel with direct coverage rates and visible gaps. An authorized campaign manager can open a non-closed CAT Action with validated opaque campaign context. The CAT Action displays the source campaign funnel and campaign-scoped Action Readiness beside its own tasks/readiness.

The handoff does not copy member responses, people, assignments, commitments, or tasks. Any CAT Action task or CAT Action-specific readiness response still requires an explicit authorized mutation. Durable campaign↔CAT Action linkage and templates remain deferred until repeated usage justifies persistence.

### 17D — Member 360 expansion — complete

Schema changes: **none**.

Member 360 remains the existing Outreach employee workspace rather than creating a second person-detail system.

Added connected context:

- **Open work at a glance** — active assignments, open/overdue follow-ups, active campaign participation, and current campaign/CAT Action-scoped readiness counts;
- **Record completeness** — simple presence checks for work email, department, classification, and work location after the existing protected-PII hydration; this is explicitly not a quality score and never guesses missing values;
- **Campaign participation** — current/historical campaign population or assignment relationships, campaign status, assignment status, and due date;
- **Campaign & CAT Action readiness context** — current scoped Action Readiness with its parent campaign/CAT Action named and linked only when the viewer already has management permission.

Security/privacy contract:

- the `member360` relationship query resolves a person only by the existing opaque employee handle plus current role/assignment scope;
- constrained CAT roles require the same active assignment relationship as Outreach;
- the connected query reads relationship/workflow metadata and does not select direct person-name/contact PII;
- core-field completeness is computed only from the already-authorized workspace after protected-PII hydration;
- missing identity/contact information directs the user to the approved roster/import correction workflow rather than adding an ad-hoc edit path;
- campaign/CAT Action responses stay scoped to their original context and are not silently converted into another commitment.

### 17E — Operational data quality — complete

Schema changes: **none**.

Operational data quality is split into two intentional layers instead of creating another general-purpose member database:

- **Aggregate report** — every `viewReports` role can see protected-safe counts for explicit operational gaps, but never names, emails, identifiers, person IDs, or person-level rows;
- **Action queue** — only `manageImports` roles can see affected people and use the existing protected name companions to identify the record that needs correction.

The actionable issue vocabulary is small and inspectable:

- missing employee/member identifier record;
- missing active work email;
- missing department;
- missing classification;
- missing work location;
- unknown/unrecognized membership status;
- active Engaging Local 801 record absent from the latest approved membership snapshot.

The latest-roster comparison is a source discrepancy only. Absence is never interpreted as a drop, separation, archive, or other lifecycle event. If no approved snapshot exists, that comparison is reported as unavailable rather than guessed.

Identity conflicts discovered during import remain in the existing protected Import review workflow. Stage 17E does not introduce fuzzy/name matching, duplicate likelihood scores, or a second identity-resolution system. Exact matching continues to use protected keyed indexes and established import evidence.

At the close of Stage 17E, correction remained deliberately indirect and authoritative: its historical contract was **the queue is read-only**, sending authorized users to Data Imports so changes were scanner-backed, validated, reviewed, protected, and audited. Stage 17E added no ad-hoc person edit endpoint or mutation. Stage 17J later added a narrowly bounded direct-fix path for individual missing or unresolved fields; the aggregate report, issue definitions, protected queue read, identity-conflict handling, and latest-roster interpretation established in 17E remain unchanged.

The former plaintext-era `Reports > Data quality` destination is redirected to the new aggregate protected-safe report. The old `missing_names` reporting-view metric is no longer treated as authoritative after protected cutover.

### 17F — Workload and calendar operations — complete

Schema changes: **none**.

Stage 17F adds a read-only operations calendar that composes existing trusted workflow services rather than creating another task store or direct-PII query path.

- Follow-ups use the same role/assignment scope and protected-PII hydration as the existing Follow-ups queue.
- System Owner, Local Administrator, and CAT Administrator roles use their existing authorized organization-wide follow-up scope; CAT Lead and CAT Member remain limited to their own current assigned scope.
- Campaign end dates appear only for roles that already have `manageCampaigns`.
- CAT Action due context appears only for roles that already have `manageCatActions`, using the earliest currently open task due date for each active action.
- Calendar entries are grouped into Overdue, Today, Next 7 days, and Later using America/Chicago calendar semantics.
- Exact follow-up totals remain sourced from the existing role-aware dashboard metrics; the detailed calendar is deliberately bounded and clearly discloses when a complete source queue must be opened.
- Workload information represents scheduled work and operational capacity, never a performance score, organizer ranking, member score, or productivity evaluation.

The new `/workload` page is read-only. It does not create, complete, reassign, or reschedule follow-ups, campaigns, CAT Actions, or tasks.

Detailed organizer distribution is not duplicated in the calendar service. The existing protected `Reports > Overview > CAT team coverage` view remains the authoritative team-capacity detail for authorized report viewers, including assigned employees, outstanding follow-ups, and overdue follow-ups. Workload links directly to that report. This keeps one reporting definition rather than creating competing workload calculations.

Bulk mutation remains deferred. The existing single follow-up update path resolves opaque handles, re-checks role/assignment scope, validates reassignment targets, updates in a transaction, and writes an atomic audit event. Stage 17F does not replace those guarantees with repeated browser/API loops. A future bulk action is acceptable only if it has a set-based authorization model, bounded selection, atomic or explicitly resumable execution, and durable audit evidence.

### 17G — Notifications and saved work views — complete

Schema changes: **migration `0023__user_work_preferences.sql`**, applied to the synthetic Preview Neon development branch only.

Stage 17G adds a private personal workspace for operational roles. Report Viewer is intentionally excluded because it has no operational work queue to notify or save.

Notifications remain **derived**, not copied into another work database. Current reminders are calculated from already-authorized workflow facts:

- overdue, due-today, and near-term follow-ups;
- imports currently ready for review;
- new hires past the explicit first-engagement timing target;
- protected-safe data-quality exceptions;
- active campaign deadlines approaching within seven America/Chicago calendar days;
- overdue or near-term CAT Action work.

Role and assignment boundaries are inherited from the existing source services. Constrained CAT roles continue to receive only their assigned protected Follow-up scope; campaign and CAT Action reminders are generated only for roles that already manage those areas.

Notification persistence is deliberately minimal:

- notification messages, member names, person IDs, notes, email addresses, and workflow payloads are **not** stored in the acknowledgement table;
- dismissal persists only a user/org-scoped 64-character SHA-256 acknowledgement key and timestamp;
- item-specific keys include opaque item/date state, so a changed due date becomes a new reminder;
- aggregate reminders are versioned by America/Chicago calendar day, so a dismissed count does not suppress future work indefinitely.

Saved views are also intentionally narrow:

- each view belongs to one organization/user and has a user-supplied label, approved destination, small allowlisted filter JSON, and timestamps;
- server canonicalization strips free-text searches, pagination cursors, person handles, names, member identifiers, notes, and any non-allowlisted filter state before persistence;
- the first save-enabled UI is Workload; the server-side destination contract also supports the approved operational destinations `/follow-ups`, `/outreach`, `/new-hires`, `/imports`, and `/membership/data-quality` for later entry points;
- destination access is rechecked against the user's current role every time a saved view is read or created;
- users are capped at 20 saved views and duplicate names within a user/org are rejected.

Mutation/security contract:

- saved-view create/delete and notification acknowledgement require exact same-origin authenticated requests plus `viewPersonalWorkspace`;
- organization/user identity is resolved server-side and is never trusted from request JSON;
- saved-view changes and notification acknowledgements write durable audit evidence;
- API responses are `no-store`, request JSON is size-bounded, and unexpected failures use safe diagnostics;
- the browser does not persist this state in `localStorage`, `sessionStorage`, IndexedDB, or the PWA cache;
- no opaque scoring or hidden inference was added.

Preview database acceptance:

- pre-migration WAL marker: `0/1B120190` at `2026-08-17T05:29:54Z`;
- both new tables were confirmed absent before migration;
- the existing protected users composite unique index was reused rather than creating a redundant index;
- migration was applied atomically to Neon development branch `br-proud-queen-awyaq4ag` only;
- both new tables started with zero rows;
- constraints for user/org ownership, destination allowlisting, filter-object/size limits, acknowledgement hash shape, and cascade cleanup were verified;
- a synthetic `/workload` saved view plus 64-character acknowledgement key were inserted/read/deleted in one acceptance transaction;
- both tables returned to zero rows after the acceptance transaction;
- post-migration WAL marker: `0/1B134930` at `2026-08-17T05:34:24Z`.

### 17H — PWA field mode — complete

Schema changes: **none**.

Stage 17H optimizes the existing authorized Outreach workflow for phone use without creating an offline member database, a cached person sequence, or a second mutation layer.

The field loop is:

`live authorized queue → employee → conversation → Action Readiness → optional follow-up → live queue / next current priority`

Field queue contract:

- organizers explicitly start Field mode from the existing Outreach queue;
- Field mode carries only bounded `scope`, `focus`, and `25|50` row settings plus `field=1`;
- free-text search, pagination cursor state, names, emails, and member identifiers are deliberately not carried through the field workflow;
- each employee link uses the existing 64-character opaque SHA-256 handle;
- the queue is re-read from the server after each employee instead of persisting a next-person list, so current authorization, assignments, due dates, and priority ordering are re-evaluated;
- CAT Lead and CAT Member remain constrained to current assigned scope, and their field return URLs are canonicalized to `assigned` even if a broader scope parameter is manually supplied.

The lightweight `/outreach/[handle]/field` workspace reuses the proven application paths:

- `getOutreachWorkspace` and `getEngagementFormOptions` for authorized workspace/form context;
- the existing protected PII hydration adapters for names/contact/workspace data;
- the existing `EngagementRecorder` for conversation, Action Readiness, and optional follow-up mutations;
- no direct SQL, transaction, or new field-mode mutation endpoint is introduced;
- a Full Member 360 link remains available when deeper history/context is needed.

The field page intentionally does **not** auto-advance immediately after saving a conversation. The existing recorder allows Action Readiness to be updated after the engagement save and linked to that just-recorded conversation. After that step, the explicit **Done / next current priority** action returns to the live queue.

PWA/privacy contract:

- field member records require a live network connection;
- `FieldConnectionStatus` reports browser online/offline state but persists nothing;
- member records, notes, form state, queue results, API responses, and next-person state are not stored in `localStorage`, `sessionStorage`, IndexedDB, cookies, or the service-worker cache by Field mode;
- the service worker remains static-shell-only: `/offline.html` and approved icon assets are installed into the static cache;
- navigation requests remain network-first and may fall back only to the generic offline page;
- no dynamic `cache.put()` or post-fetch cache-opening path is used for protected member/API responses;
- push notification body content remains generic and contains no member, follow-up, campaign, or contact detail;
- no opaque scoring, hidden ranking, or new inferred member characteristic is added.

Stage 17H adds no migration and makes no Production, real-data, or DocLinks changes.

### 17I — Protected contact correction and organizer workflow closure — implementation merged

Purpose: close the loop between an organizer discovering incorrect contact information and an authorized membership-data reviewer changing the official record, without giving the organizer a general member-edit capability or weakening protected-PII controls.

Schema and migration contract:

- **migration `0024__protected_contact_corrections.sql`** adds three protected-mode database functions: submit, reject, and approve;
- Stage 17 closure migration **`0025__stage17_correction_integrity.sql`** hardens those functions with active-person revalidation, stale/replay SQLSTATEs, serialized primary-contact decisions, same-contact revision checks, one-active-primary enforcement, and protected active work-email uniqueness. It also adds the in-transaction Data Quality eligibility guard described in 17J;
- it adds no table or column. It reuses `contact_correction_requests` from migration `0001`, its encrypted `contact_correction_request_pii` companion from migration `0012`, the protected-companion constraint from migration `0016`, existing protected contact companions, and existing exact blind indexes;
- submit accepts only `work_email`, `personal_email`, `phone`, or `mailing_address`, writes an opaque placeholder to the legacy column, and writes the proposed value only as an encrypted companion payload;
- approval locks a still-submitted request and active person, serializes decisions for the person/contact type, and rechecks an opaque database-computed authoritative revision captured in the authorized review row. A field mismatch or contact changed after the reviewer loaded that row is stale; otherwise approval updates or creates the sole primary contact method, writes its encrypted companion, replaces its exact blind index, marks the contact verified, and marks the request approved in the same transaction;
- rejection changes only the pending request state and reviewer metadata;
- approval and rejection both fail closed when another reviewer has already decided the request. A losing concurrent decision rolls back its authoritative write and audit together.

Implemented organizer and reviewer behavior:

- the existing Member 360 employee handle opens a protected contact workspace with only the currently visible primary work email and phone plus call, text, and email actions;
- the Field workflow links to that same online contact workspace rather than creating another contact store;
- choosing the factual conversation outcome `wrong_contact` links to the correction workflow after the organizer records what happened;
- an organizer can submit one bounded proposed value for an allowlisted contact field. Submission does not change the official contact record;
- the Contact Updates queue shows the oldest 50 pending requests, identifies when more are waiting, and, after the Stage 17J refinement, compares the current protected value with the proposed protected value;
- an authorized reviewer explicitly approves or rejects. Approval has a browser confirmation because it changes the official contact record;
- Follow-ups gained a safe history-backed **Previous page** control with a first-page fallback. This is navigation only and does not persist a second cursor history.

Roles and scope:

- submission, contact actions, and the protected contact workspace require `recordEngagement`: System Owner, Local Administrator, CAT Administrator, CAT Lead, or CAT Member;
- System Owner, Local Administrator, and CAT Administrator may resolve an organization-scoped member handle; CAT Lead and CAT Member must also have a current open primary or backup assignment to that person;
- `assigned_only` contact methods remain visible only through a current assignment; `authorized_directory` methods use the existing authorized visibility path;
- review and decision require `manageImports`: System Owner, Local Administrator, or Membership Data Manager;
- all person, user, and correction lookup is organization-scoped, and request URLs expose 64-character opaque handles rather than database UUIDs.

Protected PII and audit contract:

- plaintext proposed/current contact values exist only in authorized server/application memory for validation, display, encryption, or link construction; durable protected writes use encrypted companion rows and versioned blind indexes. The client approval payload adds only a one-way 64-character contact-revision token—never a raw contact ID, protected value, blind index, or database row version;
- APIs are Preview-only, exact-same-origin, authenticated, JSON/type/size bounded, `no-store`, and fail closed with safe errors;
- submission and decision are each atomic with their audit entry;
- submission writes `record.create` for `contact_correction_request` with only the field name and `organizer_reported_correction` workflow label;
- decision writes `record.update` with only the field name and `approved|rejected` decision. Audit payloads do not contain the contact value.

Regression evidence:

- `tests/stage17i-contact-corrections.test.mjs` executes the service authorization, protected submission/storage plan, current/proposed hydration, atomic approve/reject composition, safe database-conflict mapping, repeated-decision behavior, route bounds, and migration integrity contracts;
- later Stage 17J coverage in `tests/stage17j-contact-data-quality-ux.test.mjs` verifies current/proposed comparison, bounded queue behavior, approval confirmation, protected value hydration, and responsive review layouts;
- `tests/navigation.test.mjs` verifies that Contact Updates navigation is limited to `manageImports` roles and that the most-specific nested route is selected;
- `tests/stage17j-review-regressions.test.mjs` verifies the shared history-backed Previous control across cursor pages;
- `scripts/test-sql-integration.mjs` now contains disposable-database regressions for concurrent approval against an existing contact, concurrent first-primary creation, archived-person approval, replay, protected work-email uniqueness, losing-audit rollback, and the 17J Data Quality races. That gate requires a separately authenticated database named exactly `local801_sql_test`; no safe target was configured during this closure, so these PostgreSQL scenarios were added but not executed here.

Migration and acceptance evidence status:

- commit `1373951` records the historical statement that Stage 17I live synthetic Preview acceptance passed after merging commits `a07cd13` through `b3db2a3`;
- the repository proves that migrations `0019` and `0020` exist and that the application calls their protected functions, but it contains no branch identifier, pre/post WAL markers, migration execution transcript, function inventory, rollback/rehearsal record, or database query output proving that either migration was applied to a particular Preview database;
- the commit message is not, by itself, deployment, migration-application, or rendered-browser evidence. Therefore this document does **not** claim current Preview deployment, migration acceptance, or browser acceptance for 17I.

Explicit deferrals and exclusions:

- no organizer self-approval, general member editor, bulk correction, offline contact cache, duplicate/fuzzy identity resolution, or real-data/Production enablement;
- personal email and mailing address may be proposed and reviewed, but the contact-action workspace intentionally exposes only authorized work email and phone actions;
- no hidden ranking, inferred contact quality, member propensity, or other opaque score is created. Wrong-contact routing is triggered only by an explicit recorded outcome.

### 17J — Engaging Local 801 workflow and Member 360 product review — implemented on branch

Purpose: make the existing authorized workflows easier to understand and operate as **Engaging Local 801**, center person work on Member 360, improve phone/responsive use, and close high-friction individual tasks discovered during the product review. Stage 17J is broader than a copy refresh, but it does not replace the existing authorization, protected-read, import, audit, or workflow stores.

Implemented product behavior:

- application, navigation, sign-in, PWA, offline-shell, report, and workflow language is rewritten in a natural operational voice around Engaging Local 801 and Member 360;
- Home leads with sorted factual priority work and a compact role-aware snapshot; Membership consolidates its operational entry points;
- the signed-in shell, responsive tables/cards, mobile destination sheet, buttons, notifications panel, disclosures, and Member 360 actions receive task-first responsive treatment while preserving keyboard/focus behavior;
- Directory, New Hires, Data Imports, Contact Updates, Data Quality, Campaigns, CAT Actions, Documents, Reports, Work Planner, and Team & Access are reorganized so current work or requested upload entry points precede secondary setup;
- cursor workflows use the shared safe Previous control, disruptive campaign/follow-up/team actions require deliberate confirmation, Member 360 preserves a validated originating Outreach queue, and Field/import detours preserve bounded context;
- the header notification bell asynchronously reads at most five derived authorized notifications from a private `no-store` endpoint, retains the full To Do page, and reuses the Stage 17G acknowledgement mutation rather than creating a notification store;
- Contact Updates now compares current and proposed protected values, uses a bounded oldest-first queue, and confirms approval;
- New Hires adds an explicit inline assignment workflow for an unassigned hire;
- Data Quality adds explicit inline fixes for individual missing identifiers, missing work email, missing department, missing classification, missing work location, and unresolved membership status.

Schema:

- the original Stage 17J implementation added no migration. The Stage 17 closure audit adds migration `0020` to make its direct-correction and reused Contact Update mutation paths stale-safe under real concurrency;
- notification summary/acknowledgement reuses the Stage 17G migration `0018` tables and derived notification service;
- Contact Updates reuses Stage 17I migration `0019` and earlier protected companions;
- New Hire assignment reuses `engagement_assignments` and Data Quality direct fixes reuse `people`, `person_identifiers`, `person_contact_methods`, protected companion/index tables, `membership_events`, and the audit chain.

Roles and permissions:

- the new `assignNewHires` permission is granted to System Owner, Local Administrator, Membership Data Manager, CAT Administrator, and CAT Lead; CAT Member and Report Viewer are excluded;
- assignable organizers are active CAT Administrator, CAT Lead, or CAT Member users returned through opaque user handles. Membership Data Manager can assign a hire but still does not gain `recordEngagement` or Member 360 access;
- Data Quality direct fixes and Contact Updates review remain `manageImports`-only: System Owner, Local Administrator, and Membership Data Manager;
- the Data Quality aggregate report remains available to existing `viewReports` roles without person rows, while the person-level queue remains restricted;
- the notification bell remains `viewPersonalWorkspace`-only and therefore excludes Report Viewer;
- all pre-existing Member 360, Directory, Campaign, CAT Action, document, reporting, and team permissions remain the authority; Stage 17J labels and layouts do not widen them.

Mutation contract:

- **New Hire assignment:** a bounded same-origin Preview-only endpoint accepts opaque person and assignee handles, re-resolves both within the organization, permits only a reporting-defined new hire and active CAT assignee, rejects an existing open assignment, takes an advisory transaction lock, creates one direct/open primary assignment, and refreshes the queue;
- **Data Quality direct fix:** a bounded same-origin Preview-only endpoint accepts at least one allowlisted missing/unresolved field. The path handle is authoritative over any body member, and an in-transaction person lock rechecks every requested issue together before any protected or operational write. It never overwrites a present identifier, active work email, populated work field, or resolved member/nonmember status; archive, partial-stale, duplicate, and concurrent-loser cases return controlled conflicts and roll back the audit;
- identifiers and work email are normalized, encrypted, given opaque legacy placeholders and exact blind indexes, and guarded against cross-person conflicts both before and inside the transaction;
- department, classification, and work location are filled only when blank; resolving membership status also creates a `correction` membership event;
- **not in latest roster** is never a direct-fix field. It remains a review flag routed to Member 360 or Data Imports, not a drop, separation, archive, or membership change;
- bulk/source corrections and identity conflicts remain in scanner-backed Data Imports. Stage 17J does not turn the individual form into an import bypass.

Protected PII and audit contract:

- New Hire assignment sends only opaque person/user handles and stores no copied person data;
- Data Quality names continue to come from protected companions after protected-state verification; identifier/work-email writes require protected write readiness and use encrypted companions plus versioned exact indexes;
- direct-fix audit is atomic `record.update` evidence for `data_quality_correction` containing only the changed field names and, when relevant, the identifier type—not the identifier or email value;
- New Hire assignment writes atomic `record.create` evidence for `engagement_assignment` with only `source: new_hires`, `assignmentType: direct`, and `relationship: primary`;
- notification summary responses are private, `no-store`, bounded to five items, and are not persisted in browser storage or the service-worker cache;
- Contact Update audit and protected-value rules remain the Stage 17I contract above.

Regression evidence:

- `tests/new-hire-assignment.test.mjs` covers opaque assignee options, the corrected role boundary, duplicate prevention, transactional creation, request security, and audit payload;
- `tests/stage17j-contact-data-quality-ux.test.mjs` covers Data Quality input allowlists, authorization before SQL, protected writes/conflict guards/audit redaction, transaction revalidation/error mapping, path-target authority, Preview API gates, roster-absence exclusion, Contact Update comparison, and responsive layouts;
- `tests/stage17e-data-quality.test.mjs` preserves the Stage 17E taxonomy, aggregate/person-level split, protected-read behavior, and latest-roster semantics while acknowledging controlled Stage 17J direct fixes;
- `tests/stage17j-notification-header.test.mjs`, `tests/stage17j-directory-ux.test.mjs`, `tests/stage17j-new-hires-ux.test.mjs`, `tests/stage17j-data-imports-ux.test.mjs`, `tests/stage17j-product-redesign.test.mjs`, and `tests/stage17j-review-regressions.test.mjs` cover the new task hierarchy, permissions, responsive behavior, safe navigation, confirmations, context preservation, and notification contract;
- `tests/navigation.test.mjs`, `tests/safe-return-path.test.mjs`, and the updated Stage 14B/15/16/17 and workflow-specific suites guard the retained authorization, protected-read, import, PWA, reporting, and language contracts.

Historical branch-snapshot limitations and current boundary:

- New Hire assignment and Data Quality mutation routes intentionally return not-found in Vercel Production and require explicitly enabled Preview authentication; this is not a Production implementation;
- Preview remains synthetic-only. No real member data, Production launch, Production auth, dedicated Production resources, or DocLinks integration is authorized by Stage 17J;
- at the time of the branch snapshot, the branch and tests provided source/regression evidence but no deployment or rendered-browser record; PR #20 later supplied accepted exact-head CI, matching Preview deployment, and authenticated desktop/mobile evidence;
- Stage 17J depends on migrations `0019` and `0020`. Their repository chain and synthetic acceptance are recorded; every future target database still requires controlled migration-state verification.

Explicit deferrals and permanent exclusions:

- no bulk member correction, bulk New Hire assignment, automatic reassignment, general-purpose member editor, offline protected member database, or second notification/task store;
- no automatic roster-drop/separation/archive action and no fuzzy/name duplicate matching;
- no opaque ranking of members or workers, propensity/support likelihood, contact-quality score, productivity score, or hidden prioritization. Priority surfaces use inspectable due dates, explicit assignment/state, recorded outcomes, and existing factual exception counts only;
- deployment, migration acceptance, rendered-browser acceptance, real-data authorization, and Production launch require separate evidence and approval.

## Acceptance approach

The following were the requirements for accepting each wave. PR #20 closed Stage 17J for synthetic Preview; Production acceptance remains part of the authoritative roadmap.

Each wave must:

- document whether schema changes are required;
- add regression coverage;
- preserve organization/assignment/role scope;
- preserve protected-PII boundaries;
- pass lint, typecheck, full tests, migration verification, dependency audit, and production build;
- deploy to protected Vercel Preview;
- use synthetic data only for operational acceptance.
