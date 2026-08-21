# Local 801 Engage Preview Audit

## Framework And Package Versions

- Next.js: `16.3.0`
- React: `19.2.3`
- React DOM: `19.2.3`
- TypeScript: `^5`
- NextAuth: `4.24.15`
- PostgreSQL client: `postgres ^3.4.8`
- Neon serverless: `^1.0.2`
- Zod: `^4.3.6`
- JSZip: `3.10.1`

The CAT app uses its own `package-lock.json` and local binaries so a separate Vercel project builds it independently from DocLinks.

## Application Routes

- `/`
- `/sign-in`
- `/unauthorized`
- `/outreach`
- `/follow-ups`
- `/directory`
- `/membership`
- `/new-hires`
- `/imports`
- `/campaigns`
- `/cat-actions`
- `/reports`
- `/documents`
- `/audit`
- `/team`
- `/settings`
- `/install`
- `/_not-found`

## API Routes

- `POST /api/auth/preview`: local/private-preview synthetic role sign-in.
- `GET /api/health`: app/isolation health payload.
- `GET|POST /api/imports/validate`: protected import header/sample and file validation.
- `POST /api/imports/rejected-rows`: protected validation-error CSV download.

## Database Tables And Relationships

Migration `db/migrations/0001__local801_engage_core.sql` creates `local801` operational tables for organizations, users, workspace roles/permissions, people, identifiers, contact methods, membership and employment events, snapshots, import batches/files/sheets/mappings/rows/errors/matches/approvals, legacy note review, campaigns, campaign populations, assignments, engagement events, follow-ups, corrections, contract cycles, CAT actions/strategy/tasks/metrics, reports, generated reports, documents, document links, notifications, push subscriptions, and audit events.

All operational records are scoped by `organization_id`. Reporting views live in the separate `reporting` schema.

## Authentication And Authorization

Preview auth is synthetic and cookie based for private local/preview testing. It is disabled by default through `LOCAL801_PREVIEW_AUTH_ENABLED=0` and must not be used as production authentication.

Server-side page protection is handled by `ProtectedPage`; API protection is handled by `requirePreviewUser`. Import APIs require `manageImports`; report viewers and CAT members cannot use them through direct requests.

Production must replace preview auth with invitation-only MFA-backed authentication and app-scoped cookies for `cat.cyang.io`.

## File Import Workflow

The preview import workflow accepts `.xlsx` and `.csv`, rejects `.xls`, maps known headers, filters Local `0801`, requires an authoritative identifier, never merges by name alone, detects missing identifiers, duplicate identifiers, and conflicting duplicate records, returns a preview summary, and exports validation errors as formula-safe CSV.

The current implementation validates and previews only. Production approval must be implemented as one database transaction before real data can be committed.

## Reporting And Export Functionality

Native report pages and reporting views exist. Power BI readiness is documented and disabled. Export generation is documented but not yet connected to persistent generated report storage.

## Environment Variables

See `.env.example` for the complete preview/production set: app URL, auth callback URL, database URL, R2 account/endpoint/bucket/credentials, encryption keys, auth secret, app metadata, signup/MFA/session policies, import/export/rate limits, PWA controls, preview auth flag, push/VAPID keys, Power BI flags, and monitoring DSN.

## External Services

Required before production:
- Separate Vercel project.
- Separate PostgreSQL database.
- Separate Cloudflare R2 bucket and API credentials.
- Separate auth provider/environment.
- Separate encryption-key custody.
- Separate email sender.
- Separate web-push VAPID keys.
- Separate monitoring/Sentry environment.
- Separate backup/restore jobs.

## Remaining Placeholders And Incomplete Features

- Synthetic preview auth must be replaced for production.
- Synthetic dashboard data must be replaced with database-backed queries.
- Import approval/commit path is documented but not implemented against a live database.
- Real malware scanning and encrypted source-file storage must be wired before real uploads.
- Exports are documented but not yet persisted to private storage.
- Push subscriptions and delivery are scaffolded but disabled.
- Power BI connection is intentionally disabled.
- Real sample files were not available in this workspace or attachment directory for direct validation.
