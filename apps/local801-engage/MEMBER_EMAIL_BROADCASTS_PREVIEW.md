# Member Email Broadcasts — Preview-Only Boundary

## Current state

The CAT member email workflow is an explicitly Preview-only member-delivery simulation. Its only outbound path is a separate Resend action locked to one configured external test address; it never reads or delivers the frozen member audience.

Runtime access requires all of the following:

- `LOCAL801_EMAIL_BROADCAST_PREVIEW_ENABLED=1`;
- CAT Preview authentication is enabled;
- `VERCEL_ENV` is not `production`;
- `LOCAL801_PRODUCTION_LAUNCH_ENABLED` is not `1`;
- the actor has the dedicated `sendMemberEmail` permission (System Owner or Local Administrator);
- every selected recipient normalizes to the exact `example.test` domain.

Production and production-launch runtimes return Not Found before authentication, roster reads, or mutation work. A non-synthetic address aborts the entire Preview operation; CAT never creates a partial recipient snapshot.

## Preview workflow

1. The sender chooses a higher-level audience: current members, current nonmembers, the represented unit, active CAT roles, one current-member department, or an existing campaign population used as a saved list. Unknown membership records remain excluded.
2. CAT resolves the choice against the latest approved snapshot. Department values and campaign selections use opaque handles, and the chosen audience label and protected recipient set are frozen into the draft.
3. For roster audiences, a verified primary Home Email is preferred and verified primary Work Email is the fallback. The CAT-role audience uses the active CAT account email.
4. CAT deduplicates normalized addresses and displays counts only. Required operational notices do not apply a marketing unsubscribe preference; provider bounce and complaint handling remains a separate production requirement.
5. Draft subject, body, and recipient addresses are encrypted with CAT PII keys. Operational and audit JSON stores no raw address or message content.
6. The creator submits the frozen draft. A different authorized administrator must approve it.
7. Test and final member actions create idempotent simulated events only. The separately configured one-address test may call Resend after explicit confirmation.

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
5. Add a reviewed transactional provider adapter with queued batches, idempotent retries, and a hard recipient cap. Do not use Resend Marketing Contacts or Broadcasts for required operational member notices.
6. Add a signed raw-body webhook endpoint with replay/idempotency protection for delivered, bounced, complained, suppressed, and preference events.
7. Keep open and click tracking off by default. Do not attach protected documents; link to authenticated CAT content with opaque identifiers.
8. Run a synthetic provider sandbox pilot, then an owner-approved limited internal pilot, before any all-member capability is considered.

None of these future steps changes the current Preview-only fail-closed policy.
