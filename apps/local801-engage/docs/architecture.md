# Local 801 Engage Architecture

## Application Boundary

Local 801 Engage is an independent Next.js App Router project under `apps/local801-engage`. It shares repository ownership and development standards with cyang.io DocLinks, but it does not share production data, sessions, object storage, encryption keys, billing, routes, or file-sharing business logic.

## Runtime Boundaries

1. Browser and PWA shell: receives no sensitive offline cache and stores no roster, notes, assignments, reports, or source-file content in local storage, IndexedDB, or service-worker caches.
2. App server: performs authentication, MFA checks, organization scoping, role checks, field filtering, validation, import approval, reporting, export generation, and audit writes.
3. Local 801 database: owns all membership, employment, import, campaign, engagement, reporting, notification, document, and audit records.
4. Local 801 private object storage: stores source imports, generated reports, and restricted documents in a dedicated encrypted bucket.

## Security Model

The app is invitation only. MFA is required for every user. Standard CAT users receive seven-day sessions; administrators and system owners receive 12-hour sessions. Sensitive actions require recent authentication.

Authorization is organization scoped and role based, with additional field-level filtering for person-level data, restricted notes, strategy records, exports, source files, and small-cell reporting.

## Data Model

The initial migration creates normalized operational tables and Power BI-ready reporting views. Tables are scoped by `organization_id`; reporting views expose approved data only and are designed for read-only integration.

Every SQL integration gate and migration verification must pass before a draft migration is applied to Preview or Production. Schema-dependent application code is not promoted ahead of its verified Local 801 migration.

## PWA Model

The PWA manifest, temporary icons, Apple touch icon references, standalone layout, safe-area CSS, and service worker are local to this app. The service worker only caches generic static shell resources and serves a generic offline page.
