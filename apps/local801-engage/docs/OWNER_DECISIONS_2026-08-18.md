# Owner decision register — 2026-08-18

This register records the launch-planning decisions explicitly approved by Chang Yang after the Stage 20 feature freeze. It authorizes bounded engineering, synthetic acceptance, infrastructure preparation and policy/runbook work. It does **not** authorize Production launch, real member data, shared-environment migrations or release flags. Those remain later evidence-based approvals.

## Product and data operations

- Launch imports support CSV and safely bounded asynchronous XLSX. XLSX must enforce pre-allocation archive, worksheet, shared-string, cell, row, entry and compression-ratio limits and pass generated abuse/representative benchmarks before enablement.
- Authenticated web reports are the sole reporting system. Power BI and other embedded/external BI integrations remain excluded.
- Protected member records remain excluded from browser/native offline storage and synchronization.
- The standard audit-integrity model is approved: append-only application events, least-privilege database permissions, immutable deployment history, identity-provider logs, encrypted backups and periodic protected exports. Strict serialized hash chaining is not required unless an independent security or legal review later requires it.

## Identity and access

- Microsoft Entra ID is the Production OIDC provider.
- MFA is mandatory for every Production user and guest through Entra Conditional Access, except separately monitored emergency break-glass accounts.
- Entra combined MFA and self-service password reset owns account recovery. Engaging Local 801 stores no passwords and provides no local password reset.
- Public self-registration is prohibited. System Owners may invite and assign any role. Local Administrators may invite only non-administrative roles. Only a System Owner may create or change Local Administrators or System Owners.
- The current privacy and acceptable-use policy must be acknowledged at first Production sign-in and again after a material version change. The acknowledgment covers authorized-purpose use, role-based access, audit logging, protected-data handling, prohibited sharing, incident reporting and the prohibition on protected offline storage.

## Infrastructure and recovery

- Approved vendors: Vercel for the web application/workflows/gateways, Neon Postgres, private Cloudflare R2, Microsoft Entra ID, Sentry, APNs and FCM. No Power BI service is included.
- Use the existing owner-controlled VPS malware scanner at `https://scan.cyang.io/v1/scan`; do not add a scanner platform vendor. Require TLS, HMAC/timestamp/nonce replay protection, current signatures, no file/content retention, PII-safe logs, size/time/concurrency/rate limits, monitoring and clean/infected/timeout/replay/unavailable acceptance.
- Primary placement: Vercel Cleveland (`cle1`) and an R2 Eastern North America (`enam`) location hint. The existing isolated `cyang-cat-data` Neon Production project in AWS Virginia (`us-east-1`) is approved as an owner exception to the originally selected Ohio placement on 2026-08-19 to avoid duplicating Production infrastructure; it must remain separate from DocLinks and be protected before schema deployment. No contractual U.S.-only residency guarantee is required; the R2 hint is accepted as best effort.
- Initial recurring Production infrastructure ceiling: USD 300/month excluding labor and app-store enrollment. Alert at 50%, 75% and 90%; require owner approval for planned overages; never automatically disable security, backups or monitoring to save cost.
- Recovery objectives: one-hour RPO, four-hour critical-service RTO and up to eight hours for protected document recovery. Prove recovery before launch and at least twice annually.
- Chang Yang is billing owner, System Owner, final approver and temporary technical maintainer. Production services should be organization-scoped where available, use least privilege and environment-specific nonshared credentials, and maintain two monitored emergency administrator accounts. A separate backup maintainer must be named before the synthetic pilot.

## Pilot and rollout

- Synthetic pilot: one named participant for each of the seven roles. Chang Yang is pilot owner/final authority/security escalation; Local Administration owns onboarding/first-line support; Membership Data Management owns import/reconciliation training; CAT Administration/Lead owns workflow/report training; the technical maintainer owns deployment/database/monitoring response.
- Synthetic pilot duration: three operating days. It extends automatically until every required workflow and evidence item is complete.
- Stop immediately for unauthorized/cross-scope access, incorrect authoritative import, unreconciled data loss, protected-data leakage, failed session revocation or a critical workflow without a safe workaround. Noncritical usability defects may be documented without stopping. Chang Yang is stop/resume authority.
- Pilot completion requires all roles to exercise launch-critical workflows; exact synthetic import reconciliation; recovery, revocation, notifications, reports and mobile acceptance; no unresolved security/privacy/data-integrity/authorization blocker; and a signed pilot report.
- Controlled real-data validation: seven days, initially limited to Chang Yang, one Local Administrator, one Membership Data Manager and one CAT Administrator/Lead.
- After successful controlled validation, add all remaining administrative, data-management, CAT leadership and CAT Member users on the same day. Add Report Viewers after one stable operating day. Each expansion requires Chang Yang approval and pauses on any stop condition.

## Privacy, retention and governance

- Import source files and staging data: delete 30 days after completion, cancellation or failure.
- Active operational records: retain while active. Archived member, engagement, document and audit records: retain seven years, then securely delete, subject to legal requirements.
- Invalid/revoked device and push registrations: delete promptly. Legal holds suspend deletion only for affected records.
- Membership Data Managers may correct but not permanently delete member records. Permanent deletion requires documented approval from both the System Owner and a Local Administrator. Legal holds/releases require the System Owner acting on written authorized counsel/leadership direction. Corrections, deletion, holds and releases are audited. Encrypted backups expire through their approved retention cycle rather than selective editing.
- Chang Yang is incident commander and may suspend access/service. The technical maintainer may immediately contain an incident through session revocation, import disablement, credential rotation and component isolation. Preserve evidence without copying protected data into tickets/chat; use counsel-approved notification timelines; require a written serious-incident review before resumption.
- Review all Production user roles quarterly, administrative/service access monthly, and vendors annually and after material changes. Immediately deactivate departed users and revoke sessions. Record reviews and exceptions.

## Ownership, maintenance and support

- Software ownership remains with Chang Yang until a written transfer or license says otherwise. Any later agreement must define source rights, hosting cost, maintenance, data ownership, termination and successor access.
- Chang Yang owns/administers the Apple Developer and Google Play publisher accounts.
- Distribution: unlisted iOS App Store release; standard Google Play listing protected by invitation-only Entra/CAT access, or private Managed Google Play if an Android Enterprise/EMM organization already exists.
- Superseding launch-scope decision (2026-08-19): the initial Production release is responsive web/PWA only. Native iOS/Android code remains feature-locked and retained, but store publication, signing, native gateways, physical-device acceptance, and store review are deferred and do not block the web launch. Keep `LOCAL801_NATIVE_MOBILE_ENABLED=0` until a separately approved native release.
- Maintenance: assess actively exploited critical issues immediately and mitigate within 24 hours; other critical issues within seven days; high severity within 30 days; routine dependency/platform work monthly; browser/mobile compatibility quarterly. Emergency fixes still require testing, audit documentation and review.
- Normal support acknowledges within one business day. Critical security/data-integrity/full-service incidents notify Chang Yang and the maintainer immediately, target one-hour acknowledgment and use the four-hour RTO. Local Administrators provide first-line support. Named backup contacts are required before pilot.
- Initial SLOs: 99.5% monthly availability excluding announced maintenance; 95% of normal authenticated requests within three seconds; import acknowledgment within five seconds; 95% of scheduled notification attempts begin within five minutes; critical monitoring alerts reach the maintainer within five minutes. Review after pilot and the first three Production months.
- Notifications are opt-in and generic, never contain protected member details, default to 7:00 a.m.–8:00 p.m. Central, allow security/explicit reminders through quiet hours, provide optional-category controls and promptly remove invalid/revoked registrations.

## Approvals still deliberately deferred

- Production migrations `0001`–`0024` were explicitly approved and committed on 2026-08-19; any later migration requires a new staged review and change approval.
- Naming the backup maintainer, pilot participants, trainers and support contacts.
- Accepting independent security, penetration, accessibility, legal and restoration evidence.
- Signing store/vendor agreements and providing owner-controlled credentials/secrets.
- Authorizing real member data, setting the Production launch flag, expanding access or declaring formal launch/maintenance transition.
