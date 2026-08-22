# CAT Security Documentation

> The CAT application is designed and assessed for alignment with CIS Critical Security Controls v8.1 Implementation Group 2. This documentation does not represent CIS certification.

This directory is the security review package for the MAPE Local 801 CAT Data & Engagement application in `apps/local801-engage`. CAT remains an independently deployed application and does not share DocLinks production data, sessions, credentials, storage, encryption keys, billing, or deployment settings.

## How to read this package

- **Technical controls** are enforced in application code, database migrations, tests, or CI and cite those evidence locations.
- **Operational controls** require an administrator or MAPE/Local 801 procedure and are not complete merely because a document exists.
- **Provider controls** require configuration or evidence from GitHub, Vercel, Neon, Cloudflare, or the selected identity provider.
- **Endpoint controls** belong to managed user devices and organizational policy; the CAT web application cannot enforce them.

## Index

| Document | Purpose |
| --- | --- |
| [CIS v8.1 IG2 control matrix](CIS_V8_1_IG2_CONTROL_MATRIX.md) | Safeguard-by-safeguard applicability, evidence, gaps, and status |
| [Asset inventory](ASSET_INVENTORY.md) | Application, cloud, pipeline, environment, and endpoint assets |
| [Software inventory](SOFTWARE_INVENTORY.md) | Manifest-derived components, SBOM, tooling, and review method |
| [Data protection](DATA_PROTECTION.md) | Classification, encryption, access, retention, export, and logging review |
| [Secure configuration baseline](SECURE_CONFIGURATION_BASELINE.md) | Application and provider configuration requirements |
| [Account lifecycle](ACCOUNT_LIFECYCLE.md) | Provisioning, role change, review, deactivation, and emergency access |
| [Vulnerability management](VULNERABILITY_MANAGEMENT.md) | Detection, triage, remediation, and exceptions |
| [Audit logging](AUDIT_LOGGING.md) | Events, metadata, access, retention, and tamper considerations |
| [Backup and recovery](BACKUP_AND_RECOVERY.md) | Backup scope, dependencies, restore authorization, and test procedure |
| [Security architecture](SECURITY_ARCHITECTURE.md) | Trust boundaries, interfaces, and data flows |
| [Security monitoring](SECURITY_MONITORING.md) | Detectable events, alerting expectations, and provider ownership |
| [Vercel firewall observation draft](VERCEL_FIREWALL_OBSERVATION_DRAFT.md) | Staged log-only rule classes, thresholds, rollout, 429 and false-positive validation |
| [Provider assessment 2026-08-22](PROVIDER_SECURITY_ASSESSMENT_2026-08-22.md) | Secret-free dated GitHub, Vercel and Neon findings plus inspection blockers |
| [CAT security operations](LOCAL801_SECURITY_OPERATIONS.md) | Fresh initialization, distributed limits, encrypted-object recovery, and retention inventory |
| [Operational acceptance template](OPERATIONAL_ACCEPTANCE_TEMPLATE.md) | Private account, incident, retention, exercise, external review and risk-acceptance evidence fields |
| [Security user guide](SECURITY_USER_GUIDE.md) | Concise onboarding responsibilities by role |
| [Service provider register](SERVICE_PROVIDER_REGISTER.md) | Provider purpose, data, responsibility, access, and offboarding |
| [Application security review](APPLICATION_SECURITY.md) | CIS Control 16 secure-SDLC and threat review |
| [Endpoint responsibilities](ENDPOINT_RESPONSIBILITIES.md) | Browser, email, device, removable-media, and anti-malware boundaries |
| [Incident response plan](INCIDENT_RESPONSE_PLAN.md) | CAT-specific response process and six playbooks |
| [Penetration test plan](PENETRATION_TEST_PLAN.md) | Future independent test scope and handling rules |
| [Security risk register](SECURITY_RISK_REGISTER.md) | Meaningful unresolved and shared-responsibility risks |
| [Production security gate](PRODUCTION_SECURITY_GATE.md) | Structured launch checklist and evidence requirements |

Review this package at least annually and whenever authentication, authorization, data classification, hosting, storage, encryption, file handling, or a material service provider changes.
