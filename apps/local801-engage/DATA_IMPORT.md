# Local 801 Engage Data Import

The preview import workflow accepts `.xlsx` and `.csv`; legacy `.xls` is rejected.

Rules:
- Rows require an authoritative identifier. Supported identifier columns include member ID, employee ID, person ID, and work email.
- Names are never used as the only merge key.
- Duplicate identifiers are detected.
- Missing identifiers are rejected.
- Duplicate identifiers with conflicting fields are flagged for review.
- Multi-local files can be filtered to Local `0801`.
- Spreadsheet formulas are neutralized in preview values and validation-error downloads.
- A validation preview and summary are shown before any commit.
- Rejected rows and validation errors can be downloaded as CSV.

Current Preview ingestion is synchronous and synthetic-only. The next processing phase is designed in
`docs/IMPORT_BACKGROUND_PROCESSING.md`; migration 0006 and the typed lifecycle contract are drafts only.
No durable worker is active, and the interface must not imply otherwise.

Future durable acceptance path:

- Authenticate, authorize `manageImports`, require exact same origin, and validate only the bounded upload envelope in the request.
- Encrypt and store the source in private R2, then durably record the organization-scoped batch/job and a redacted audit event.
- Start versioned background processing with organization/batch UUIDs only. The workflow self-claims the queued Neon job with its trusted runtime run ID; the browser never supplies a run ID, and correctness does not depend on an idempotent start request.
- Keep review staging, progress, and business state in Neon. Workflow orchestration is not the business-state authority.
- Return `202` with the batch identifier after durable acceptance so the administrator can close the browser.

Phase 2B-2 approval/execution remains a separate future boundary. It must revalidate every prerequisite and perform all authoritative person, membership, snapshot, approval, and audit writes atomically. No current upload or background-foundation code performs those writes or marks a batch approved.
