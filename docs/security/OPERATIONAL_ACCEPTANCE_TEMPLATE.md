# CAT Operational and External Review Record Template

Complete this record in the approved private evidence system. Do not commit names, provider IDs, private URLs, account IDs, member data, credentials or legal advice to this repository. Blank fields are intentionally unresolved.

| Review | Responsible role/category | Decision/input required | Pass evidence |
| --- | --- | --- | --- |
| Account and administrator review | System Owner + IdP/repository/provider admins | Approved individual accounts, roles, recovery access and leaver status | Dated exports/screenshots, reviewer and remediation references |
| Dormant-account policy | Organization + privacy/security | Approved inactivity definition, review cadence and exception authority | Signed policy/change record and completed review |
| Service-account inventory | Provider admins + security | Owner, purpose, scopes, last use, rotation/offboarding for each machine identity | Secret-free private register and token-scope screenshots |
| Incident assignments | Organization leadership + security/legal | Coordinator, technical, communications, privacy/legal and provider contacts with alternates | Private call tree and acknowledgement test |
| Alert-delivery test | Operations + monitoring provider | Destination, severity routing, on-call coverage and escalation timing | Synthetic event receipt, acknowledgement and ticket |
| Retention/deletion approval | Records owner + privacy/legal + security | Per-data-class retention, holds, deletion authority and backup treatment | Approved schedule and reviewed cleanup design |
| Audit retention | Security + privacy/legal | Evidence duration, access, export/storage and disposal | Approved policy and retrieval/disposal test |
| Legal/privacy/provider review | Counsel/privacy + organization owner | Notices, contracts, subprocessors, incident/deletion terms and jurisdictional duties | Counsel-owned decision/reference; no legal conclusion in source |
| Tabletop exercise | Incident coordinator | Approved scenario, participants and success criteria | Dated after-action report with remediation owners |
| Backup/restore exercise | Recovery operator + system owner | Approved disposable target, backup/object/key selection and cleanup | Checksums, recovery timing, validation and deletion evidence |
| Independent penetration test | Owner + independent tester | Scope, rules, target, timing and remediation expectations | Signed authorization, report, remediation and retest |
| Risk acceptance | Accountable owner + security/privacy/legal as applicable | Explicit residual risk, bounded duration/review trigger and compensating controls | Signed private acceptance and follow-up ticket |

Final authorization must reference every applicable evidence item, record unresolved exceptions, keep `LOCAL801_PRODUCTION_LAUNCH_ENABLED=0` until all gates pass, and never describe this template itself as acceptance.
