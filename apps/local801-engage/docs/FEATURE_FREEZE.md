# Engaging Local 801 feature freeze

> Product scope status: **feature complete and locked**, including the owner-approved native mobile package, on the Stage 20 application-completion branch. The bounded mobile scope unlock is now closed. This freezes application features; it does not authorize Production, real member data, shared-database migrations, store publication, or launch flags. Exact-head CI, protected Preview acceptance, independent security review, infrastructure, pilot, policy, recovery and launch approvals remain release gates.

## Final included product surface

The feature-complete product includes the existing membership, Directory, imports and approval, data-quality/contact correction, Member 360/outreach, follow-up/work planner, new-hire, campaigns, CAT Actions, documents, notifications, authenticated web reports, audit, Team & Access, settings, PWA and production-authentication foundation, plus this final expansion:

- Team & Access is the single onboarding control plane: it provisions the CAT role, creates the Microsoft Entra B2B invitation, assigns the enterprise application, sends role/policy instructions through Microsoft's invitation service, and exposes safe retry state without creating passwords.

- durable Campaign-to-CAT-Action relationship, navigable from both record workspaces without copying protected member records or workflow ownership;
- document tags and typed relationships to authorized documents, campaigns and CAT Actions;
- expanded import cancellation and operator controls with immediate queued cancellation, cooperative running cancellation and auditable failed/cancelled requeue;
- browser push subscription, encrypted protected-mode storage, deduplicated generic work delivery, stale-device disabling and generic test delivery;
- native iOS and Android Capacitor applications sharing the canonical HTTPS authorization model, with Apple App Attest/Google Play Integrity verification, biometric app lock and step-up, PDF share intake, document and trusted-QR scanning, encrypted/protected background upload, generic actionable native notifications, generic calendar reminders, Android safe-count widget, and safe iOS/Android home-screen shortcuts;
- continued exclusion of protected member records from service-worker caches, browser storage, native filesystem/SQLite/preferences and offline synchronization.

Migration `0026__feature_complete_relationships_and_operator_controls.sql` is the forward-only schema contract for the relationship and import-control expansion. Migration `0027__native_mobile_security_and_delivery.sql` adds digest-only, expiring attestation challenges and tenant-scoped device registrations with encrypted push-token envelopes. The native projects and pinned dependencies are intentional Stage 20 changes. They supersede older roadmap statements that described these capabilities as optional or deferred.

## Locked exclusions

- Power BI and all other embedded/external BI integration; authenticated custom web reports are the sole reporting system.
- Offline storage or synchronization of protected member records.
- Opaque member scores, organizer rankings, propensity/support predictions, political profiling and inferred sensitive traits.
- Public object URLs, cross-organization relationships, raw internal identifiers in browser relationship mutations and native bypasses of server authorization.
- Native contact/member search indexes, downloaded member lists, protected notification previews, member details in widgets/calendars/shortcuts, or any native background synchronization of protected records.

## Change control after freeze

Until launch, changes are limited to verified defects, security findings, accessibility corrections, dependency/security maintenance, release configuration, production infrastructure, approved data migration/reconciliation and evidence/runbook work. New product capabilities require an explicit scope-unlock decision by the System Owner and a separately reviewed roadmap change.

## Release work is not feature work

The owner-approved, versioned first-sign-in privacy and acceptable-use acknowledgment in migration `0023` is a launch security control. It does not reopen the frozen workflow/reporting/mobile feature scope. Future policy-version changes may update the displayed policy and require re-acknowledgment, but may not add unrelated product capabilities without normal change control.

The following remain mandatory but do not reopen product scope: exact-head CI and Vercel Preview acceptance; disposable SQL integration; independent authorization/security review; Production OIDC/MFA, Neon, private object storage, scanner, browser VAPID and signing credentials; backup/restore and incident exercises; retention/privacy/access policies; pilot/training/support; and explicit Production/real-data launch authorization. The initial release is web/PWA only. Native packages remain feature-locked and disabled; App Store/Play signing, device acceptance, gateways, and review are deferred post-launch work rather than web-launch blockers.
