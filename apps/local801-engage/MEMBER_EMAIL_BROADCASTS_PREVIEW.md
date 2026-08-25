# Member Email Broadcasts — Preview-Only Boundary

## Current state

The CAT member email workflow is an explicitly Preview-only simulation. It does not contain a Resend client, provider API key, outbound delivery path, or public webhook endpoint.

Runtime access requires all of the following:

- `LOCAL801_EMAIL_BROADCAST_PREVIEW_ENABLED=1`;
- CAT Preview authentication is enabled;
- `VERCEL_ENV` is not `production`;
- `LOCAL801_PRODUCTION_LAUNCH_ENABLED` is not `1`;
- the actor has the dedicated `sendMemberEmail` permission (System Owner or Local Administrator);
- every selected recipient normalizes to the exact `example.test` domain.

Production and production-launch runtimes return Not Found before authentication, roster reads, or mutation work. A non-synthetic address aborts the entire Preview operation; CAT never creates a partial recipient snapshot.

## Preview workflow

1. CAT reads only the latest approved membership snapshot and selects Local 0801 rows with snapshot status `member`.
2. A verified primary Home Email is preferred; verified primary Work Email is the fallback.
3. CAT deduplicates normalized addresses, applies the local topic-suppression index, and displays counts only.
4. Draft subject, body, and recipient addresses are encrypted with CAT PII keys. Operational and audit JSON stores no raw address or message content.
5. The creator submits the frozen draft. A different authorized administrator must approve it.
6. Test and final actions create idempotent simulated events only. No network call occurs.

## Synthetic acceptance

The synthetic seed includes home-preferred recipients, a work-email fallback, and a shared-household duplicate. Acceptance should confirm:

- counts are correct and no address or name appears in the page payload, logs, audit payloads, or operational JSON;
- a non-`example.test` address locks the operation;
- the creator cannot approve the same broadcast;
- simulated delivery creates one event per eligible unique address and remains idempotent;
- all email broadcast routes return 404 in Production configuration.

## Future provider handoff — disabled

Do not enable provider delivery as part of Preview acceptance. A later, separately approved production phase must complete these manual and implementation gates:

1. Approve the email provider, data-processing terms, retention, privacy language, union communications policy, and required-versus-optional notice rules.
2. Provision a CAT-only Resend team/resource. Do not reuse a DocLinks team, key, contacts, billing resource, domain, or webhook.
3. Verify a CAT-specific sending subdomain with SPF and DKIM, add DMARC deliberately, and choose a monitored Local 801 Reply-To inbox.
4. Introduce CAT-prefixed secrets such as `LOCAL801_RESEND_API_KEY` and `LOCAL801_RESEND_WEBHOOK_SECRET` only in the separate CAT Vercel project.
5. Add a reviewed provider adapter for Contacts, Segments, Topics, and Broadcasts. Roster synchronization must remove former members from the segment without recreating or overriding unsubscribe state.
6. Add a signed raw-body webhook endpoint with replay/idempotency protection for delivered, bounced, complained, suppressed, and preference events.
7. Keep open and click tracking off by default. Do not attach protected documents; link to authenticated CAT content with opaque identifiers.
8. Run a synthetic provider sandbox pilot, then an owner-approved limited internal pilot, before any all-member capability is considered.

None of these future steps changes the current Preview-only fail-closed policy.
