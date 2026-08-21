# Local 801 Engage Implementation Plan

## Application Directory

Local 801 Engage is implemented at `apps/local801-engage`. The existing DocLinks app remains at the repository root.

## Reused Components And Patterns

- Next.js App Router, React, TypeScript, and CSS-based responsive layout patterns.
- Security-header discipline from the root Next config.
- Ordered SQL migration pattern.
- Environment-template discipline and release-proof mindset.
- Auth, MFA, RBAC, private-storage, encryption, audit, and malware-scanning patterns as reference architecture.

## Not Reused

- Public document links, aliases, anonymous share pages, guest upload flows, public document discovery, link analytics, pricing, Stripe billing, customer subscriptions, existing customer organizations, existing document records, and existing public upload workflows.

## Possible Future Extractions

- Generic form controls, buttons, status badges, migration verification helpers, environment validation helpers, audit-chain helpers, private object-storage client wrappers, encryption-key validation, and test utilities.

## Deployment

Create a separate Vercel project rooted at `apps/local801-engage`, assign `cat.cyang.io` after production approval, and keep the existing cyang.io Vercel project pointed to the root DocLinks app.

## Database Architecture

Use a separate PostgreSQL database and migration history under `apps/local801-engage/db/migrations`. The first migration creates `local801` operational tables and `reporting` views, all organization scoped.

## Storage Architecture

Use a dedicated private Cloudflare R2 bucket for source imports, generated reports, and Local 801 documents. Store no raw R2 URLs in client-visible surfaces.

## Authentication And Authorization

Invitation-only access, MFA for every user, application-specific cookies, seven-day CAT sessions, 12-hour admin/system-owner sessions, and recent authentication for high-risk actions. Roles and permissions are app specific.

## Imports And Matching

Imports support XLSX/CSV design paths, worksheet selection, column mapping, blank-row removal, Excel-date conversion, formula-injection protection, MIME rejection, malware scanning, duplicate review, work-email matching, and Local `0801` filtering.

## Legacy Migration

Legacy CAT worksheets are classified by worksheet intent. Obsolete worksheets are ignored by default, narrative notes enter review, recruitment scores are not permanent fields, and older CAT files do not override the current approved roster.

## Engagement, Campaigns, And CAT Actions

Campaign populations freeze at launch. Assignments support primary and backup organizers plus self-assignment pools. Engagement events preserve prior-contact visibility, follow-up history, corrections, voiding, and auditability. CAT strategy is separately protected.

## PWA And Push

The MVP includes manifest, standalone mode, icons, safe-area CSS, mobile navigation, install guidance, install-prompt handling, and a service worker that caches only nonsensitive assets. Push notifications use generic wording and require an authenticated action before subscription.

## Reporting And Power BI

Native dashboards are primary. Reporting views are Power BI-ready and organization scoped. Actual Power BI connections remain disabled until owner-controlled Microsoft credentials exist.

## Testing Strategy

Local 801 has typecheck, unit tests, migration verification, and production build scripts. Next phases should add Playwright, accessibility, authorization, security, import parser, push, and cross-organization integration tests.

## Risks To Existing cyang.io

Risks are shared sessions, shared credentials, accidental root-route changes, shared database access, shared storage access, broad shared-code refactors, and sensitive sample data leakage.

## Risk Controls Taken

The root app was not moved. Local 801 files live under `apps/local801-engage`. Root scripts remain intact. Local 801 env names, migrations, docs, storage variables, and PWA assets are separate. `local-sensitive-samples/` is ignored.
