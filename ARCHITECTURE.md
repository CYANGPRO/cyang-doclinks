# cyang-doclinks Architecture

## Scope
This document defines trust boundaries, enforcement order, and lifecycle flows for secure document delivery.

## Trust Boundaries
1. Browser/client boundary
- Client input is untrusted (upload metadata, aliases, tokens, headers, query params).
- Security decisions are server-side only.

2. App server boundary (Next.js routes/actions)
- Enforces authz, share/alias/token gates, quota checks, and policy checks.
- Mints short-lived access tickets after all checks pass.

3. Data boundary (Postgres)
- Source of truth for document state, share state, quota counters, org/user bindings, and immutable audit chain.
- Mutable business tables are separate from append-only audit tables.

4. Object storage boundary (Cloudflare R2)
- Objects are private and accessed through server-mediated routes only.
- Raw R2 URLs are not authoritative access paths.

## Request Flow: Upload -> Scan -> Serve
1. Upload initiation
- `/api/admin/upload/presign` creates doc row in `uploading` state.
- Encryption metadata and key version are attached to the doc.
- Upload presign returns signed URL and per-doc encryption params.

2. Upload completion
- `/api/admin/upload/complete` validates object existence, metadata, size, and encrypted content shape.
- Reject paths clean up R2 object and emit security telemetry.
- Encrypted payload is validated by decrypting and running PDF safety checks.
- Doc transitions to `ready` with `scan_status` and risk metadata.

3. Scan queue + async scan
- Scan jobs are enqueued and processed by cron.
- High-risk results quarantine content.
- Quarantined and failed scan states block serving.

4. Serve path
- Share/alias/serve routes enforce gating and rate limits.
- Server mints short-lived ticket (`/t/[ticketId]`) only when all gates pass.
- Ticket route performs final checks and streams content with hardened headers.

## Enforcement Order (Serve)
1. Global/route kill switches
2. Rate limits (IP + token/alias scopes)
3. Share/alias/token existence checks
4. Revocation/expiration/max-view checks
5. Moderation + quarantine + scan status checks
6. Plan/quota checks
7. Ticket mint + stream
8. Audit/analytics (best effort, non-blocking)

## Encryption Lifecycle
1. New uploads are encrypted by default and finalized only when encryption is enabled.
2. Each doc stores encryption metadata and key version.
3. Active master key can be rotated; queued jobs rewrap doc keys.
4. Revoke/rollback operations are auditable.
5. Plaintext serve fallback is disabled by policy.

## Retention Lifecycle
1. Retention settings stored in `app_settings`.
2. Cron retention job enforces expired-share cleanup and deletion windows.
3. Backup/recovery checks run in nightly cron and write status records.
4. Cleanup flows track and reduce orphan risk (DB refs vs R2 objects).

## Tenant Isolation Model
1. Users/docs are org-scoped (`org_id`) in multi-tenant mode.
2. Org membership/invite model controls tenant membership.
3. Admin/security surfaces operate within owner/org constraints.
4. Rate-limit and telemetry events include org context where available.

## Incident Controls
1. Global serve disable: `SECURITY_GLOBAL_SERVE_DISABLE=1`
2. Share serve disable: `SECURITY_SHARE_SERVE_DISABLE=1`
3. Alias serve disable: `SECURITY_ALIAS_SERVE_DISABLE=1`
4. Ticket serve disable: `SECURITY_TICKET_SERVE_DISABLE=1`

## Non-Goals
1. Client-enforced access control
2. Public object-store direct access as an authorization mechanism
3. Long-lived bearer URLs as standalone authority
