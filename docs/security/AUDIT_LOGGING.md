# CAT Audit Logging

## Sources and events

| Source | Security-relevant events |
| --- | --- |
| CAT `local801.audit_events` | Import previews/uploads/validation/review/execution, record changes, role and account state changes, report/export events, document create/delete request and protected download access |
| CAT security runtime log | Unauthenticated and insufficient-permission API denials with bounded non-sensitive context |
| Identity provider | Successful/failed authentication, MFA, recovery and administrator changes |
| Vercel | Request/function failures, runtime security events, deployments and environment changes |
| GitHub | CI, Dependabot, CodeQL, secret alerts, repository/branch administration |
| Neon/Cloudflare | Provider administrative and service-access evidence where the selected plan exposes it |

Durable CAT events include actor, organization, event/action, optional target type/id, timestamp, outcome/context in a redacted JSON payload, and hash-chain metadata. Audit payload fields resembling names, email, phone, address, contact, note, or raw content are redacted. Uploaded/downloaded bytes, narrative content, secrets, tokens, connection strings, and blind-index material must never be logged.

## Protection and limitations

- Reads are limited to System Owner/Local Administrator, organization-scoped, bounded and keyset-paginated.
- Migration `0019__append_only_audit_events.sql` blocks application-level update/delete of audit rows.
- Hashes link to the latest observed predecessor, but concurrent writers are not strictly serialized. The chain is tamper-evident metadata, not a cryptographic immutability guarantee against a privileged database owner.
- Provider administrators and database recovery operators remain powerful; least privilege, MFA, provider audit logs, backups and access review are required.

## Retention and review

- The organization must approve a CAT audit retention period before production. Until then, do not configure automatic audit deletion.
- Review high-risk events and alerts at least weekly in production and immediately on an alert: administrator/account changes, repeated denials, imports, protected downloads, exports, scanner failures, deployment/security-setting changes and suspected data access.
- Vercel’s native runtime-log retention is plan-dependent and may be too short for investigation. Configure a production log drain or equivalent centralized destination with sensitive-data filtering, access control and an approved retention period.
- Verify time synchronization evidence from GitHub, Vercel, Neon, Cloudflare and the IdP; application timestamps use provider/runtime/database time in UTC.
