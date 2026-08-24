# Stage 15 — Product Function & Workflow Optimization

## Purpose

Stage 15 reviews every core Local 801 Engage work area as a product workflow, not merely as a set of pages that already function. The goal is to preserve the proven security/data foundation while improving usefulness, decision support, handoffs, automation, and day-to-day organizer/admin efficiency before Stage 16 visual/accessibility polish and Stage 17 production readiness.

The governing question for every section is:

> If this feature were designed today with the workflows and data model we now understand, would we build it the same way?

## Guardrails

- Preview remains synthetic-data-only.
- Production launch remains disabled.
- Do not provision, migrate, seed, or otherwise modify Production during Stage 15.
- Do not modify DocLinks.
- Do not weaken protected-PII reads/writes, organization isolation, assignment scope, role permissions, malware scanning, audit controls, or fail-closed behavior.
- Prefer aggregate or already-authorized data over creating new PII surfaces.
- Reuse existing services and domain models before creating parallel concepts.
- A section may be kept, improved, redesigned, combined, or removed if that produces a clearer workflow.
- Functional changes require regression verification before the slice is considered complete.

## Audit method

Each section is reviewed for:

1. Current purpose and workflow.
2. What is already strong and should be preserved.
3. Pain points, unnecessary clicks, duplicate entry, or dead ends.
4. Incremental and creative alternatives.
5. Cross-feature handoffs and automation.
6. Security, authorization, and PII implications.
7. Final disposition: Keep / Improve / Redesign / Combine / Remove / Defer.

Candidate work is prioritized by user value, frequency, implementation effort, and security/operational risk.

## Product workflow model

The primary operational flow is:

`Roster / import → person → membership state → outreach → follow-up → campaign / CAT action → participation / outcome → reporting`

Stage 15 reduces the number of times a user must leave that flow, re-enter known information, remember a future task manually, or interpret a state that the application can safely derive.

## Product-wide decisions

- **Do not create a second Member 360 route.** The existing employee outreach workspace is the authorized person hub and now includes durable employment/membership lifecycle history.
- **Do not create a second outreach queue.** The existing priority model already covers overdue follow-up, due today, never engaged, 90-day stale, upcoming, and recent work.
- **Do not create a second new-hire queue.** `/new-hires` already supports operational contact, assignment, membership, age, and follow-up states.
- **Do not create a second campaign audience builder.** Draft campaign population search/add/remove and population freeze-on-activation already exist.
- **Do not create manual duplicate campaign/CAT readiness counters.** Existing Action Readiness has first-class organization, campaign, and CAT-action scope and is now surfaced as aggregate readiness in those workflows.
- **Do not create arbitrary manual priority flags where due-date/age rules already express urgency.** Add explicit priority only if real use later shows the derived queue cannot represent urgency.
- **Do not infer or silently score potential leaders.** Repeated participation may inform a future transparent organizer workflow, but no opaque people-scoring model is part of Stage 15.
- **Do not add persistence merely for convenience without demonstrated use.** Saved searches/views, document tags, and campaign milestone schemas remain candidates, not automatic additions.

## Implementation completed in Stage 15

### Dashboard — COMPLETE

The home page is now a role-aware command center rather than only a KPI launcher.

Implemented:

- **Needs attention** uses existing authorized aggregates and links directly to the resolving workflow.
- Imports in review drill into Data Imports.
- Overdue follow-ups drill into the user's overdue queue.
- New-hire totals drill into the existing operational New Hires queue.
- Open outreach, Membership, Campaigns, and CAT Actions link to the existing work areas.
- No new PII query surface was introduced; the dashboard reuses existing organization-scoped metrics.

Deferred deliberately:

- “Since your last visit” requires a trustworthy per-user baseline/state model. It is not inferred from a browser timestamp.

### Membership — COMPLETE

The Membership page remains anchored to the latest approved snapshot but now exposes lifecycle movement and direct workflow handoffs.

Implemented:

- additions this month;
- drops this month;
- net movement;
- direct handoff to Data Imports;
- direct handoffs to membership trends, new-hire reporting, and data-quality reporting when authorized.

The page does not duplicate person-level PII. Individual history belongs in the authorized employee workspace.

### Imports — AUDITED / CORE MODEL RETAINED

The import system is already substantially more mature than the initial Stage 15 brainstorm:

- source-type presets already exist;
- durable scanner-backed processing already exists;
- protected identity classification already exists;
- exception categories, snapshot-shrink detection, bounded set decisions, execution fingerprints, and preflight gates already exist;
- authoritative execution remains separately gated and fail closed.

Disposition: **Keep the architecture.** Do not add a ceremonial multi-page wizard around an already staged workflow.

Remaining improvement candidate:

- Explain an `existing_with_changes` row using **field names only** (for example, “classification, work location”) without displaying protected old/new values. The protected classifier already has the blind-index/presence facts necessary to support this safely.

This is intentionally deferred until the Stage 16 review-detail presentation pass because it requires changing the shared legacy/protected classification detail contract and then presenting the result accessibly. Stage 15 does not alter the proven classification/execution CTE merely to add cosmetic explanation text.

### Directory — AUDITED / RETAINED

Directory already provides:

- protected server-side search;
- membership, department, classification, and location filters;
- assignment/organization scope enforcement;
- keyset pagination;
- protected-PII hydration;
- authorized employee drill-through.

Disposition: **Keep.**

Deferred deliberately:

- saved searches/views until recurring user patterns justify persistent state;
- additional row quick-actions until Stage 16 interaction testing identifies a real navigation loop.

### Employee workspace / Member 360 — COMPLETE

The existing outreach employee page is formally the **Member 360 workspace**.

Implemented:

- retained protected person/work profile;
- retained active campaign context;
- retained engagement recorder and same-flow follow-up creation;
- retained Action Readiness;
- retained open follow-ups and recent engagement;
- added a bounded **Employment & membership timeline** from durable `employment_events` and `membership_events`;
- lifecycle history reuses the same organization/assignment authorization semantics as the employee workspace.

No second person-detail route or duplicate PII store was created.

### New Hires — AUDITED / RETAINED

New Hires already functions as an operational queue with:

- contact-state filters;
- assignment-state filters;
- membership filters;
- hire-age filters;
- never-engaged, unassigned, open-follow-up, and current-member summaries;
- protected employee drill-through.

Disposition: **Keep.** Dashboard handoff now points to this queue instead of treating analytics as the work surface.

### Outreach — AUDITED / RETAINED

Outreach already provides the intended priority work model and surfaces assignment relationship, latest engagement, follow-up context, Action Readiness, and authorized work email.

The Engagement Recorder already makes follow-up creation part of the conversation-recording flow.

Disposition: **Keep.** Avoid a duplicate outreach/task system.

### Follow-ups — AUDITED / RETAINED

Follow-ups already provides:

- Mine / All authorized scope;
- Overdue / Today / Upcoming / Completed views;
- search;
- reschedule and reassign;
- completion;
- employee drill-through;
- Action Readiness and engagement context.

Disposition: **Keep.**

Deferred deliberately:

- coupling every follow-up completion to a new outreach outcome. A follow-up can be completed for reasons other than a conversation, so this should not become an automatic semantic assumption.
- arbitrary priority labels; current due-date and overdue age remain the authoritative urgency signal.

### Campaigns — COMPLETE FOR STAGE 15

Campaign management already includes draft population building, protected candidate search, population freeze on activation, organizer assignment, due dates, participant drill-through, and lifecycle management.

Implemented:

- campaign detail now surfaces **aggregate Action Readiness** for definitions explicitly scoped to that campaign;
- counts include willing, considering, completed, and declined responses;
- no person-level readiness roster is exposed by the summary;
- the interface explicitly states that readiness is not campaign completion and not a hidden member score.

Deferred deliberately:

- new goal/milestone persistence until a concrete campaign-management requirement establishes which goals and milestones need durable semantics.

### CAT Actions — COMPLETE FOR STAGE 15

CAT Actions already includes action lifecycle management, task creation/editing, assignees, due dates, overdue/unassigned summaries, protected reads, and reporting.

Implemented:

- CAT-action detail now surfaces **aggregate Action Readiness** for readiness definitions explicitly scoped to that CAT action;
- the same transparent willing/considering/completed/declined model is reused instead of inventing a participation score.

Deferred deliberately:

- “passed action date” automation because the current CAT-action domain does not have a separate authoritative action-event date to key that automation to;
- potential-leader ranking/scoring.

### Documents — COMPLETE FOR STAGE 15

The encrypted/scanned document architecture is retained.

Implemented:

- upload visibility now explains exactly which roles can see the selected scope before upload;
- the library repeats the audience meaning alongside each document;
- server-side permission enforcement remains unchanged.

Deferred deliberately:

- document tags, campaign/action relationships, and additional metadata until a real retrieval workflow justifies the new schema and relationship semantics;
- library search/filter expansion can be evaluated during Stage 16 usability testing because the current library is bounded and paginated.

### Reports — REFERENCE IMPLEMENTATION / RETAINED

Native authenticated reports remain the analytical reference model for Stage 15. Reports provide purpose-built membership, new-hire, engagement, campaign, CAT-action, and data-quality views directly in the application.

Disposition: **Keep.** Other sections should drill into existing reports where analytics are the correct destination and into work queues where action is the correct destination.

### Team & Access — COMPLETE

Existing provisioning, role changes, deactivation/reactivation, identity linkage, MFA visibility, and session revocation are retained.

Implemented:

- a **Role capability preview** derived from the live `access.ts` navigation and permission policy;
- administrators can see which application areas and major capabilities each of the seven roles receives before assigning a role;
- this is explicitly not user impersonation and does not modify sessions.

### Audit Activity — COMPLETE

The durable audit log remains organization-scoped and sensitive audit payloads/UUIDs remain hidden.

Implemented:

- human-readable action labels;
- human-readable affected-area labels;
- friendly activity filter options;
- Central-time timestamps;
- bounded protected hydration of actor display names from `user_pii` for the current authorized page;
- safe fallback behavior when protected actor display data is unavailable.

No audit payloads, subject UUIDs, encryption metadata, or protected actor values beyond the authorized display name are rendered.

### Settings / Administration — AUDITED / RETAINED

Settings already functions as the intended non-secret operational security/status center. It exposes environment/security posture and the production launch interlock without displaying credentials, key material, database connection strings, provider subjects, or scanner secrets.

Disposition: **Keep.** Production monitoring/alerting and operational recovery evidence belong to Stage 17 Production Readiness, not to a broader Preview settings dashboard.

## Cross-feature automation outcome

Stage 15 found that several desired automations were already present through durable domain relationships rather than needing new background automation:

- new hires are derived from authoritative employment events and already have a dedicated queue;
- follow-up creation already occurs in the engagement-recording workflow;
- stale/never-engaged work is already derived into Outreach priority states;
- campaign organizer assignments and due dates already exist;
- Action Readiness already has explicit campaign/CAT-action scopes and is now surfaced in those workflows;
- Dashboard now routes aggregate attention states into the existing resolving work queues.

Stage 15 deliberately avoids invisible mutation automation. A roster change may be surfaced as lifecycle context, but the system does not silently reassign organizers, create strategy records, or infer sensitive intent from employment changes.

## Verification requirements

Stage 15 acceptance requires:

- lint passes;
- TypeScript typecheck passes;
- full automated test suite passes;
- migration verification passes;
- production dependency audit passes;
- production build passes;
- no new migration is required by Stage 15 changes;
- Preview remains synthetic-only;
- Production launch flags remain disabled and Production is untouched;
- DocLinks is untouched.

## Definition of done

Stage 15 is complete when:

- every core section has an evidence-based disposition;
- selected high-value improvements are implemented and tested;
- deferred ideas have an explicit product/security reason rather than being silently omitted;
- duplicate concepts/workflows have not been introduced;
- cross-feature handoffs avoid unnecessary duplicate entry;
- no change weakens authorization, tenant isolation, protected PII, auditability, or fail-closed behavior;
- all verification requirements above are green.

Once those checks are green, the next roadmap stage is **Stage 16 — UI/UX, Visual Polish & Accessibility**. Stage 16 should use this stabilized functional structure rather than redesigning workflows that Stage 15 intentionally retained.
