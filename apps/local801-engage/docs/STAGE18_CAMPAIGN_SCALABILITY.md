# Stage 18 campaign scalability

> Closure status: Stage 18 was accepted at `2514a457f1ddf09770fac1cabff7482b3771d20c` through PR #23 and normally merged into the Stage 17H development chain as `5ae0b64b77bbda83880a5a3bc43fa0936cae48b7`. Exact-head CI, matching Vercel Preview deployment `dpl_B7UZ9CCwEgCtDQGKyVDYCEvz6rZU`, authenticated desktop/mobile checks, and the disposable 20,000-person run passed. Preview remained synthetic-only and the disposable database branch was deleted. Future planning is in `ROADMAP_TO_COMPLETION.md`.

## Safety boundary

Stage 18 scales Engaging Local 801 campaign planning and operations for a synthetic 20,000-person organization. It does not change DocLinks, Production, billing, deployment ownership, or authoritative membership/import data. Campaign population and assignment mutations remain Preview-only, organization-scoped, role-authorized, same-origin, draft/active-state constrained, and durably audited.

No browser request or response may contain an organization roster, internal person UUIDs, a large list of opaque handles, protected contact data, or a server-derived population set. The browser sends only bounded criteria and optional explicit exceptions, receives counts and a short-lived confirmation token, and confirms that exact preview.

## Stage 17 gate

- Stage 17 PR #20 is merged.
- Accepted head: `116789cc46216cd5d2efdee47d817a1c5aa08910`.
- Merge commit used as the Stage 18 base: `f5500ae27e1e48d90d19232f5ec7a5b334028e27`.
- Exact-head CI succeeded and the exact-head Preview deployment was `READY`, with accepted authenticated desktop and mobile evidence recorded on PR #20.

## Measured baseline

The pre-Stage-18 campaign detail path has these properties:

| Concern | Baseline | Stage 18 requirement |
| --- | --- | --- |
| Population mutation | One person per request; candidate search returns at most 25. | Server-derived set operations with bounded criteria, preview counts, explicit confirmation, idempotent writes, and one aggregate audit event. |
| Assignment mutation | One participant and one assignee per request. | Set-based assignment to an explicit eligible organizer, with preview/confirmation and deterministic conflict handling. |
| Participant page | One SQL page query, keyset ordered by name/opaque handle, rows capped at 100. Arbitrary sizes 1–100 are accepted. | Only 25/50/100 sizes, operational filters, factual workflow state, bounded payloads, stable keyset traversal. |
| Campaign summary | Population, assigned, contacted, completed, remaining. | Add unassigned and overdue facts and bounded per-organizer progress. |
| Protected hydration | The protected read helper can fetch up to 500 PII rows and 500 assignments independent of the requested page. | Query only the bounded handles already selected for the current response; never hydrate the whole campaign or roster. |
| Concurrency | Population uniqueness prevents duplicate membership. Assignment writes do not share a campaign-level serialization point with future bulk work. | Campaign-row serialization plus in-transaction revalidation; stale confirmations fail closed; retries cannot duplicate membership or active assignment effects. |

The existing useful database support is:

- unique campaign population membership on `(campaign_id, person_id)`;
- organization/campaign/person traversal for active assignments;
- organization/campaign/person traversal for non-voided engagement events;
- organization plus membership-status and department indexes on active people;
- deterministic opaque campaign and person handles derived in SQL.

## Architecture

### Population criteria

The initial builder supports bounded, AND-composed criteria already used by Directory:

- membership status;
- department;
- classification;
- work location;
- Directory search term;
- explicit include/exclude person handles, with small fixed limits and exclusion taking precedence.

Blank criteria are rejected instead of silently selecting the whole organization. Name/email matching in protected-read mode uses the existing blind indexes on the server. Operational fields remain parameterized SQL predicates. Criteria values are normalized and length bounded before SQL construction.

Preview returns only factual counts: matched, already present, would add/remove, explicitly excluded, unavailable, and protected-activity conflicts. It also returns an HMAC confirmation token bound to the organization, campaign, actor, canonical criteria, operation, live campaign state, live selected-set revision, and expiration. Confirm recomputes the set under a locked campaign row and rejects a stale or altered preview.

Apply is draft-only for population changes. It uses set-based `INSERT ... ON CONFLICT DO NOTHING` or a protected set-based removal, checks actual mutation counts, and writes one aggregate audit event in the same transaction. Existing engagement activity and completed assignments prevent unsafe removal.

### Bulk assignment

The initial safe assignment mode is one explicit eligible organizer. It does not infer, rank, optimize, or score organizers. The server selects only currently unassigned members matching bounded operational filters, previews the exact count, locks and revalidates the campaign and assignee, inserts assignments set-wise, verifies the affected count, and writes one aggregate audit event atomically. A later deterministic round-robin mode may be added only with stable sorted inputs and equivalent evidence.

### Operations page

The campaign participant table remains keyset paginated and accepts only 25, 50, or 100 rows. Assignment and workflow filters execute in SQL before pagination. Rows contain only the factual state needed for campaign work. Aggregate progress is computed in SQL, including unassigned, overdue, contacted, completed, and a bounded per-organizer breakdown. Mobile uses compact rows without horizontal page scrolling.

### Synthetic scale acceptance

The Stage 18 scale harness creates synthetic `example.test`-only records in an explicitly authorized disposable database, executes the population and assignment flows for 20,000 represented people, captures query counts and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans, and measures response bytes, wall time, process memory, retry behavior, and aggregate audit writes. It refuses Production, refuses an unauthenticated target, and requires the database name `local801_sql_test`. The disposable database branch is deleted after final acceptance.

## Migration decision

No migration is justified by the baseline. Existing uniqueness and traversal indexes support the first implementation, and campaign-row locking supplies a shared serialization point without a schema change. Contains-search indexes are not added speculatively. The 20,000-person query plans are the decision gate: if they show a material sequential-scan bottleneck, a separate reviewed migration will be prepared and Stage 18 will stop before any apply step.

## Acceptance evidence

Each focused wave must pass lint, typecheck, tests, migration verification, dependency audit, and production build. Final acceptance additionally requires the authorized disposable 20,000-person run, exact-head GitHub CI, exact-head Vercel Preview, authenticated desktop `1440×900` and mobile `390×844` checks, bounded network payload evidence, and no severe browser, runtime, or Vercel errors.

### Authorized 20,000-person run

The isolated `local801_sql_test` run on 2026-08-18 applied all 20 migrations and passed with exactly 20,000 synthetic people, 20,000 campaign members, 20,000 active assignments, and two aggregate campaign audit events. No migration was required.

| Operation | Wall time | Queries | Response bytes |
| --- | ---: | ---: | ---: |
| Population preview | 220.2 ms | 1 | 799 |
| Population apply | 1,260.4 ms | 5 | 35 |
| Assignment preview | 235.3 ms | 1 | 819 |
| Assignment apply | 1,665.6 ms | 5 | 18 |
| 100-row participant page | 241.6 ms | 1 | 31,103 |
| Organizer progress | 157.3 ms | 1 | 185 |

Both replay attempts were rejected after two in-transaction queries. Analyzed preview plans completed in 136.315 ms for population and 80.416 ms for assignment. The participant response stayed below the 128 KB bound, and the mutation responses never serialized participant collections.
