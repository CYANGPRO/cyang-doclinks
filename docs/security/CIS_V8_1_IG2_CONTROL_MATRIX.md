# CIS Critical Security Controls v8.1 IG2 Matrix — CAT

Assessment date: 2026-08-21. Target: the cumulative IG2 baseline (IG1 plus IG2 safeguards). Source titles and group assignments were checked against the [official CIS Controls v8.1](https://www.cisecurity.org/controls/v8-1) and [CIS Controls Assessment Specification](https://cas.docs.cisecurity.org/en/latest/).

This is a source-based alignment assessment, not CIS certification. “Provider responsibility” means CAT depends on a configured provider control and must obtain evidence; it never means the control is complete merely because a provider offers a feature. “Shared responsibility” similarly requires all named parties to complete their portions.

## Evidence catalog

| Code | Evidence location |
| --- | --- |
| E1 | `docs/security/ASSET_INVENTORY.md` |
| E2 | `docs/security/SOFTWARE_INVENTORY.md`, CAT manifests/lockfile, `.github/dependabot.yml`, `.github/workflows/ci.yml`, `.github/workflows/codeql.yml` |
| E3 | `docs/security/DATA_PROTECTION.md`; CAT PII/encryption/storage modules, migrations `0002`, `0009`, `0012`-`0019`, protected-read/import/report/storage tests |
| E4 | `docs/security/SECURE_CONFIGURATION_BASELINE.md`, CAT `next.config.ts`, auth/request/config modules, service worker, CIS/security tests |
| E5 | `docs/security/ACCOUNT_LIFECYCLE.md`, `team-access.ts`, production auth/session modules and tests |
| E6 | `docs/security/APPLICATION_SECURITY.md`, `access.ts`, `authz.server.ts`, workspace/services/routes and negative authorization/isolation tests |
| E7 | `docs/security/VULNERABILITY_MANAGEMENT.md`, npm audit/SBOM scripts, Dependabot, CodeQL |
| E8 | `docs/security/AUDIT_LOGGING.md`, `audit.ts`, migration `0019`, audit/document/team/import tests |
| E9 | `docs/security/ENDPOINT_RESPONSIBILITIES.md` |
| E10 | CAT upload/scanner/storage modules and document/import/scanner/infrastructure tests |
| E11 | `docs/security/BACKUP_AND_RECOVERY.md`, `.github/workflows/backup-local801-neon-to-r2.yml` |
| E12 | `docs/security/SECURITY_ARCHITECTURE.md`, CAT architecture/deployment/isolation tests |
| E13 | `docs/security/SECURITY_MONITORING.md`, safe authorization/runtime diagnostics |
| E14 | `docs/security/SECURITY_USER_GUIDE.md` |
| E15 | `docs/security/SERVICE_PROVIDER_REGISTER.md` |
| E16 | `docs/security/APPLICATION_SECURITY.md`, CAT CI/tests/migration verification |
| E17 | `docs/security/INCIDENT_RESPONSE_PLAN.md` |
| E18 | `docs/security/PENETRATION_TEST_PLAN.md` |
| E19 | `docs/security/SECURITY_RISK_REGISTER.md`, `docs/security/PRODUCTION_SECURITY_GATE.md`, production launch policy/tests |
| E20 | Required provider/organization console, contract, access-review, training, scan, alert, exercise, or restore evidence; **not present in source** |

## Control 1 — Inventory and Control of Enterprise Assets

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 Establish and Maintain Detailed Enterprise Asset Inventory | Applicable | CAT/cloud/environment assets and review process recorded | E1 | Named owners/private IDs remain operational | Map owner categories privately; review semi-annually | Implemented |
| 1.2 Address Unauthorized Assets | Shared responsibility | Process covers unlisted deployment/database/bucket/client/token/device | E1 | Provider/device comparisons not evidenced | Reconcile provider and managed-device inventories weekly for exceptions | Partially implemented |
| 1.3 Utilize an Active Discovery Tool | Shared responsibility | Managed cloud/provider inventories are the available discovery surfaces | E1, E20 | No evidence of provider/device discovery integration | Use provider inventory/API and organization MDM where supported | Provider responsibility |
| 1.4 Use DHCP Logging to Update Enterprise Asset Inventory | Not applicable | CAT operates as managed SaaS and owns no enterprise DHCP server | E1, E9 | None within CAT scope | Organization applies this to its own network separately | Not applicable |

## Control 2 — Inventory and Control of Software Assets

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1 Establish and Maintain a Software Inventory | Applicable | Locked manifests, major-component register and generated SBOM | E2 | Provider component versions require provider inventory | Retain SBOM per release and review providers | Implemented |
| 2.2 Ensure Authorized Software is Currently Supported | Shared responsibility | Supported runtime policy, Dependabot and review procedure | E2, E7 | Provider/end-user version evidence absent | Review monthly and replace unsupported components | Partially implemented |
| 2.3 Address Unauthorized Software | Shared responsibility | Manifest/lockfile allowlist and removal/exception process | E2 | Endpoint/provider enforcement outside CAT | Enforce through review, CI and managed endpoints | Partially implemented |
| 2.4 Utilize Automated Software Inventory Tools | Applicable | npm lock graph, CycloneDX SBOM generation and CI artifact | E2 | None material | Monitor artifact creation | Implemented |
| 2.5 Allowlist Authorized Software | Shared responsibility | CI installs locked repository software only | E2 | Host/endpoint execution allowlisting is provider/organization owned | Verify managed build/runtime and endpoint policy | Provider responsibility |
| 2.6 Allowlist Authorized Libraries | Applicable | `npm ci`, lockfiles, reviewed manifests and import/type/build gates | E2, E16 | No runtime module allowlist beyond build artifact | Preserve locked builds; review any dynamic loader | Partially implemented |

## Control 3 — Data Protection

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 Establish and Maintain a Data Management Process | Applicable | Classification, handling, roles and review boundaries documented | E3 | Organization approval pending | Approve retention/privacy responsibilities | Partially implemented |
| 3.2 Establish and Maintain a Data Inventory | Applicable | CAT data classes, stores, flows and providers inventoried | E3, E12 | Production provider targets need private mapping | Complete provider evidence at gate | Implemented |
| 3.3 Configure Data Access Control Lists | Applicable | Server RBAC, org/visibility/assignment/person-level checks; private storage | E3, E6 | Provider IAM evidence pending | Verify least-privilege Neon/R2/Vercel/IdP access | Partially implemented |
| 3.4 Enforce Data Retention | Partially applicable | Report expiry/model fields and archive paths exist | E3, E19 | No approved schedule or complete automated purge | Approve schedule and implement/test purge/orphan jobs | Deferred |
| 3.5 Securely Dispose of Data | Partially applicable | Document archive/cleanup flow and provider deletion considerations | E3 | End-to-end retention, backup and orphan deletion unverified | Implement operational deletion and verify provider copies | Deferred |
| 3.6 Encrypt Data on End-User Devices | Shared responsibility | CAT avoids sensitive offline cache | E3, E9 | Download/device storage encryption cannot be enforced by web app | Require managed full-disk encryption and minimal downloads | Provider responsibility |
| 3.7 Establish and Maintain a Data Classification Scheme | Applicable | Eight CAT classifications and handling rules defined | E3 | Organizational sign-off pending | Review annually and on data changes | Implemented |
| 3.8 Document Data Flows | Applicable | Client, Vercel, IdP, Neon, R2, scanner, GitHub and recovery flows | E12 | Provider admin paths need current evidence | Update after provider/integration change | Implemented |
| 3.9 Encrypt Data on Removable Media | Shared responsibility | CAT requires no removable media | E9 | Organization may export/download outside CAT | Prohibit or encrypt removable media under endpoint policy | Provider responsibility |
| 3.10 Encrypt Sensitive Data in Transit | Shared responsibility | HTTPS endpoints, OIDC/R2 canonical TLS and DB TLS production gate | E3, E4, E19 | Live TLS/provider validation pending | Verify final domain, DB URL and provider transports | Partially implemented |
| 3.11 Encrypt Sensitive Data At Rest | Shared responsibility | PII/note/object application encryption plus provider storage responsibility | E3 | Provider at-rest settings/key custody evidence pending | Verify Neon/R2 controls and escrow/recovery | Partially implemented |
| 3.12 Segment Data Processing and Storage Based on Sensitivity | Applicable | Separate CAT environments/stores/keys; visibility classes and protected hydration | E3, E6, E12 | Provider separation evidence pending | Complete production isolation acceptance | Partially implemented |

## Control 4 — Secure Configuration of Enterprise Assets and Software

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 4.1 Establish and Maintain a Secure Configuration Process | Applicable | Versioned CAT baseline covers headers, cookies, DB, storage, Preview and errors | E4 | Provider console baselines not evidenced | Review annually/change and capture provider settings | Implemented |
| 4.2 Establish and Maintain a Secure Configuration Process for Network Infrastructure | Shared responsibility | Trust/network requirements documented | E4, E12 | Managed network configuration is provider-owned | Verify Vercel/Neon/Cloudflare/IdP baselines | Provider responsibility |
| 4.3 Configure Automatic Session Locking on Enterprise Assets | Shared responsibility | CAT sessions expire and can be revoked | E5, E9 | Device lock is endpoint-owned | Enforce managed-device lock policy | Provider responsibility |
| 4.4 Implement and Manage a Firewall on Servers | Shared responsibility | No CAT-managed servers; Vercel perimeter expected | E12, E20 | Firewall/WAF evidence absent | Configure/verify Vercel Firewall/provider perimeter | Provider responsibility |
| 4.5 Implement and Manage a Firewall on End-User Devices | Shared responsibility | Outside web-app control | E9 | Endpoint evidence absent | Organization endpoint policy/MDM | Provider responsibility |
| 4.6 Securely Manage Enterprise Assets and Software | Shared responsibility | Version control, HTTPS-only service endpoints, CI and scoped credentials | E2, E4, E12 | Provider admin access review pending | Verify MFA/RBAC and prohibit insecure protocols | Partially implemented |
| 4.7 Manage Default Accounts on Enterprise Assets and Software | Shared responsibility | CAT has no default/shared login or self-signup | E5 | Provider defaults/admin recovery need review | Disable/rename/remove provider defaults where applicable | Provider responsibility |
| 4.8 Uninstall or Disable Unnecessary Services on Enterprise Assets and Software | Shared responsibility | Push/Power BI/Preview-only production features disabled/gated | E4, E19 | Provider/endpoint services not evidenced | Review provider and managed-device services | Partially implemented |
| 4.9 Configure Trusted DNS Servers on Enterprise Assets | Shared responsibility | CAT canonical domain documented | E9, E12 | Resolver configuration is provider/endpoint-owned | Use approved provider/endpoint DNS policy | Provider responsibility |
| 4.10 Enforce Automatic Device Lockout on Portable End-User Devices | Shared responsibility | Outside CAT application | E9 | Managed-device evidence absent | Enforce through MDM/device policy | Provider responsibility |
| 4.11 Enforce Remote Wipe Capability on Portable End-User Devices | Shared responsibility | Outside CAT application | E9 | Managed-device evidence absent | Enforce where organizational risk requires | Provider responsibility |

## Control 5 — Account Management

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 5.1 Establish and Maintain an Inventory of Accounts | Shared responsibility | CAT Team inventory and provider/service register exist | E5, E15 | Provider/service-account reconciliation not evidenced | Quarterly reconcile CAT, IdP and provider accounts | Partially implemented |
| 5.2 Use Unique Passwords | Shared responsibility | CAT uses individual passwordless OIDC; no local/shared passwords | E5 | IdP/provider password policy outside CAT | Verify provider policy and MFA | Provider responsibility |
| 5.3 Disable Dormant Accounts | Shared responsibility | Last authentication exposed to administrators; deactivation revokes sessions | E5 | No automated dormant threshold/review evidence | Define threshold and quarterly disable review | Deferred |
| 5.4 Restrict Administrator Privileges to Dedicated Administrator Accounts | Shared responsibility | Individual admin roles and hierarchy enforced | E5 | Dedicated admin-vs-daily IdP identity policy not decided | Organization defines/records admin account model | Partially implemented |
| 5.5 Establish and Maintain an Inventory of Service Accounts | Shared responsibility | Provider/service identities enumerated without secrets | E5, E15 | Private owner/last-use/rotation data absent | Maintain private quarterly service-account register | Partially implemented |
| 5.6 Centralize Account Management | Shared responsibility | IdP centralizes authentication; CAT Team controls app roles/revocation | E5 | IdP selection/configuration acceptance pending | Verify lifecycle across IdP and CAT | Partially implemented |

## Control 6 — Access Control Management

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 6.1 Establish an Access Granting Process | Applicable | Provisioning/hierarchy and documented approval fields | E5, E6 | Named organizational approvers not defined | Assign/record approvers privately | Partially implemented |
| 6.2 Establish an Access Revoking Process | Applicable | Deactivate, role change and session revocation are audited and immediate | E5, E6 | IdP/provider offboarding evidence required | Test end-to-end revocation | Implemented |
| 6.3 Require MFA for Externally-Exposed Applications | Shared responsibility | OIDC MFA assurance required; launch fails closed | E5, E19 | Production provider acceptance pending | Test approved IdP accounts and recovery | Partially implemented |
| 6.4 Require MFA for Remote Network Access | Not applicable | CAT exposes HTTPS SaaS, not organization remote network/VPN access | E9, E12 | None in CAT scope | Organization applies to its network separately | Not applicable |
| 6.5 Require MFA for Administrative Access | Shared responsibility | Same OIDC MFA applies to CAT admins; provider admins require provider controls | E5 | Provider admin MFA evidence pending | Verify all provider admin accounts | Partially implemented |
| 6.6 Establish and Maintain an Inventory of Authentication and Authorization Systems | Applicable | IdP, NextAuth, CAT RBAC/session binding and provider IAM documented | E5, E12, E15 | Final IdP/provider mappings pending | Complete private system/owner inventory | Implemented |
| 6.7 Centralize Access Control | Applicable | Central permission map plus server/service/SQL enforcement | E6 | Provider IAM remains separate shared boundary | Reconcile provider roles with access reviews | Implemented |

## Control 7 — Continuous Vulnerability Management

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1 Establish and Maintain a Vulnerability Management Process | Applicable | Detection, triage, ownership and review process documented | E7 | Operational execution evidence begins after adoption | Review annually and after major incidents | Implemented |
| 7.2 Establish and Maintain a Remediation Process | Applicable | Severity-based practical expectations and risk acceptance defined | E7, E19 | Private tracking/owners required | Track findings through closure and retest | Implemented |
| 7.3 Perform Automated Operating System Patch Management | Shared responsibility | GitHub/Vercel/Neon/Cloudflare manage hosts; endpoints organization-owned | E9, E15 | Provider/endpoint evidence absent | Verify supported managed services and endpoint updates | Provider responsibility |
| 7.4 Perform Automated Application Patch Management | Applicable | Dependabot weekly npm/Actions updates and locked CI verification | E2, E7 | Security-update setting needs console verification | Enable alerts/security updates and require CI | Partially implemented |
| 7.5 Perform Automated Vulnerability Scans of Internal Enterprise Assets | Shared responsibility | No CAT-managed internal network assets | E1, E15 | Provider host scanning not visible to CAT | Obtain provider assurance; scan any future managed asset | Provider responsibility |
| 7.6 Perform Automated Vulnerability Scans of Externally-Exposed Enterprise Assets | Applicable | CodeQL/dependency scanning exists | E7 | No monthly dynamic external scan evidence | Configure authorized external DAST/infrastructure scan | Deferred |
| 7.7 Remediate Detected Vulnerabilities | Shared responsibility | CI, severity rules, risk register and regression expectations | E7, E19 | No completed operational review record yet | Triage current provider/CI findings and record disposition | Partially implemented |

## Control 8 — Audit Log Management

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 8.1 Establish and Maintain an Audit Log Management Process | Applicable | Sources, event scope, access, review and limitations documented | E8 | Retention/owner approval pending | Approve retention and weekly reviewer | Partially implemented |
| 8.2 Collect Audit Logs | Shared responsibility | CAT durable audit plus safe denial/runtime and provider sources | E8, E13 | Failed auth/provider/admin coverage needs configuration | Enable/centralize IdP and provider event sources | Partially implemented |
| 8.3 Ensure Adequate Audit Log Storage | Shared responsibility | Database audit and provider logs available | E8 | Capacity/retention alert evidence absent | Set capacity/retention and monitor ingestion | Deferred |
| 8.4 Standardize Time Synchronization | Shared responsibility | App/database/provider UTC timestamps used | E8 | NTP is managed-provider/endpoint responsibility | Obtain provider assurance; require endpoint time sync | Provider responsibility |
| 8.5 Collect Detailed Audit Logs | Applicable | Actor, org, action, target, timestamp, outcome/context; sensitive fields redacted | E8 | Some provider events remain external | Preserve current schema and add new high-risk events | Implemented |
| 8.6 Collect DNS Query Audit Logs | Shared responsibility | No CAT-managed resolver/network | E9, E20 | Provider/endpoint DNS logs not in CAT | Organization/provider decides collection based on scope | Provider responsibility |
| 8.7 Collect URL Request Audit Logs | Shared responsibility | Vercel request/runtime logs provide route/status metadata | E13, E20 | Central retention/alert not configured | Configure Vercel drain with redaction | Provider responsibility |
| 8.8 Collect Command-Line Audit Logs | Shared responsibility | GitHub workflow logs cover CI commands | E2, E20 | Developer/provider shell logging is organization/provider-owned | Enforce managed endpoint/provider audit policy | Provider responsibility |
| 8.9 Centralize Audit Logs | Shared responsibility | Monitoring design identifies CAT/IdP/Vercel/GitHub sources | E13 | Central destination/correlation not configured | Configure tested log drain/equivalent | Deferred |
| 8.10 Retain Audit Logs | Applicable | Append-only CAT rows prevent application deletion | E8 | Approved duration and provider retention absent | Approve and configure sufficient retention | Deferred |
| 8.11 Conduct Audit Log Reviews | Shared responsibility | Weekly/high-risk review expectations defined | E8, E13 | Assigned reviewer and review evidence absent | Assign owner and record weekly review | Deferred |

## Control 9 — Email and Web Browser Protections

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 9.1 Ensure Use of Only Fully Supported Browsers and Email Clients | Shared responsibility | CAT user guide requires approved supported browser | E9, E14 | Endpoint enforcement outside CAT | Organization manages endpoint versions | Provider responsibility |
| 9.2 Use DNS Filtering Services | Shared responsibility | Outside CAT application boundary | E9 | Endpoint/network filtering evidence absent | Apply organization/provider DNS filtering | Provider responsibility |
| 9.3 Maintain and Enforce Network-Based URL Filters | Shared responsibility | Outside CAT application boundary | E9 | Endpoint/network URL filtering evidence absent | Apply approved gateway/endpoint filtering | Provider responsibility |
| 9.4 Restrict Unnecessary or Unauthorized Browser and Email Client Extensions | Shared responsibility | User guide prohibits unapproved endpoint use | E9, E14 | Cannot be enforced by web app | Use managed browser policy | Provider responsibility |
| 9.5 Implement DMARC | Not applicable | CAT has no approved production outbound email service/domain flow | E9, E15 | Reassess if email is enabled | Require SPF/DKIM/DMARC before CAT email launch | Not applicable |
| 9.6 Block Unnecessary File Types | Applicable | Upload allowlist excludes executables, archives and HTML; attachments force download | E10 | Endpoint email attachment policy remains external | Preserve tests and organization endpoint filters | Implemented |

## Control 10 — Malware Defenses

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 10.1 Deploy and Maintain Anti-Malware Software | Shared responsibility | CAT upload scanner is fail-closed; endpoint/host malware tools provider-owned | E9, E10 | Provider/endpoint coverage evidence absent | Verify scanner and managed endpoint/provider controls | Partially implemented |
| 10.2 Configure Automatic Anti-Malware Signature Updates | Shared responsibility | Scanner service responsibility | E10, E15 | Update evidence unavailable to CAT source | Obtain scanner/provider assurance | Provider responsibility |
| 10.3 Disable Autorun and Autoplay for Removable Media | Shared responsibility | CAT requires no removable media | E9 | Endpoint setting outside CAT | Enforce endpoint policy | Provider responsibility |
| 10.4 Configure Automatic Anti-Malware Scanning of Removable Media | Shared responsibility | CAT requires no removable media | E9 | Endpoint setting outside CAT | Enforce endpoint policy | Provider responsibility |
| 10.5 Enable Anti-Exploitation Features | Shared responsibility | Managed runtimes/framework and restrictive browser headers contribute | E4, E9 | OS/browser/host protections external | Verify provider and endpoint features | Provider responsibility |
| 10.6 Centrally Manage Anti-Malware Software | Shared responsibility | Shared scanner centrally serves CAT uploads | E10, E15 | Endpoint anti-malware management external | Organization centrally manages endpoints; verify scanner owner | Provider responsibility |
| 10.7 Use Behavior-Based Anti-Malware Software | Shared responsibility | Outside CAT app/scanner-verdict contract | E9, E15 | Provider/endpoint evidence absent | Require where supported by endpoint/provider risk | Provider responsibility |

## Control 11 — Data Recovery

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 11.1 Establish and Maintain a Data Recovery Process | Shared responsibility | CAT-specific inventory, authorization and restore procedure | E11 | Object/key/provider details and owner approval pending | Complete configuration and annual review | Partially implemented |
| 11.2 Perform Automated Backups | Shared responsibility | Daily CAT-only Neon dump workflow committed | E11 | Secrets/run success and object backups not verified | Configure workflow and recovery design | Partially implemented |
| 11.3 Protect Recovery Data | Shared responsibility | Dedicated CAT recovery bucket/credentials and TLS/checksum design | E11 | Private bucket, encryption, access/retention evidence pending | Verify least privilege, privacy and key custody | Partially implemented |
| 11.4 Establish and Maintain an Isolated Instance of Recovery Data | Shared responsibility | Separate recovery bucket required by workflow/design | E11 | Isolation not provider-verified; object recovery absent | Provision/verify separate recovery storage | Partially implemented |
| 11.5 Test Data Recovery | Applicable | Safe quarterly disposable-target procedure documented | E11 | No restore exercise completed | Execute and record database/object/key recovery test | Deferred |

## Control 12 — Network Infrastructure Management

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 12.1 Ensure Network Infrastructure is Up-to-Date | Shared responsibility | CAT uses managed Vercel/Neon/Cloudflare/IdP networks | E12, E15 | Provider maintenance evidence absent | Review provider assurance/status monthly | Provider responsibility |
| 12.2 Establish and Maintain a Secure Network Architecture | Shared responsibility | Trust boundaries/public/service/admin interfaces documented | E12 | Provider console configuration evidence pending | Verify domains, private buckets, DB access and perimeter | Partially implemented |
| 12.3 Securely Manage Network Infrastructure | Shared responsibility | HTTPS-only management requirement and versioned workflow/config | E4, E12 | Provider administrator MFA/RBAC evidence pending | Verify secure protocols and least privilege | Provider responsibility |
| 12.4 Establish and Maintain Architecture Diagram(s) | Applicable | Current CAT trust/data-flow diagram exists | E12 | Keep current after changes | Review annually/material change | Implemented |
| 12.5 Centralize Network Authentication, Authorization, and Auditing | Shared responsibility | Provider/IdP centralized admin services expected | E12, E15 | No CAT-owned network AAA; provider evidence pending | Verify provider admin IAM/audit | Provider responsibility |
| 12.6 Use of Secure Network Management and Communication Protocols | Shared responsibility | Application requires HTTPS/TLS; no insecure protocol path | E4, E12 | Provider management protocol evidence pending | Verify provider consoles/APIs | Provider responsibility |
| 12.7 Ensure Remote Devices Utilize a VPN and are Connecting to an Enterprise's AAA Infrastructure | Not applicable | CAT is public HTTPS SaaS with OIDC MFA, not private enterprise-network access | E9, E12 | Organization may impose separate VPN policy | Apply separately if required by endpoint policy | Not applicable |

## Control 13 — Network Monitoring and Defense

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 13.1 Centralize Security Event Alerting | Shared responsibility | Sources and alert cases defined | E13 | Central correlation/alert delivery not configured | Configure Vercel drain/equivalent and test | Deferred |
| 13.2 Deploy a Host-Based Intrusion Detection Solution | Shared responsibility | CAT owns no hosts; Vercel/Neon/Cloudflare manage runtime hosts | E15, E20 | Provider detection evidence absent | Obtain provider assurance | Provider responsibility |
| 13.3 Deploy a Network Intrusion Detection Solution | Shared responsibility | Network perimeter is provider-managed | E12, E15 | Provider detection evidence absent | Verify Vercel/provider protection and escalation | Provider responsibility |
| 13.4 Perform Traffic Filtering Between Network Segments | Shared responsibility | Separate service interfaces/credentials and no public R2 access | E12 | Provider segment/filter configuration not visible | Verify provider isolation/firewall | Provider responsibility |
| 13.5 Manage Access Control for Remote Assets | Shared responsibility | OIDC MFA protects CAT; endpoint/network access organization-owned | E5, E9 | Managed remote-device evidence absent | Apply IdP conditional access/endpoint policy if required | Provider responsibility |
| 13.6 Collect Network Traffic Flow Logs | Shared responsibility | Vercel/provider network logs are managed controls | E13, E20 | Flow/firewall log availability/retention unverified | Enable provider logs/drain where available | Provider responsibility |

## Control 14 — Security Awareness and Skills Training

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 14.1 Establish and Maintain a Security Awareness Program | Shared responsibility | Concise CAT onboarding responsibilities documented | E14 | Training owner/cadence/completion evidence absent | Approve annual/onboarding delivery and tracking | Partially implemented |
| 14.2 Train Workforce Members to Recognize Social Engineering Attacks | Shared responsibility | Suspicious MFA/credential/access reporting guidance included | E14 | Formal delivery evidence absent | Include in onboarding/annual briefing | Deferred |
| 14.3 Train Workforce Members on Authentication Best Practices | Shared responsibility | No sharing, credential/MFA/device rules documented | E14 | Formal delivery evidence absent | Deliver and track role-appropriate briefing | Deferred |
| 14.4 Train Workforce on Data Handling Best Practices | Shared responsibility | Export, visibility, note and Preview rules documented | E14 | Formal delivery evidence absent | Deliver before access and annually | Deferred |
| 14.5 Train Workforce Members on Causes of Unintentional Data Exposure | Shared responsibility | Download/export/screenshots/unrestricted-field hazards covered | E14 | Formal delivery evidence absent | Use CAT-specific examples without real data | Deferred |
| 14.6 Train Workforce Members on Recognizing and Reporting Security Incidents | Shared responsibility | Incident examples/report expectation documented | E14, E17 | Private reporting channel/contact not assigned | Designate channel and exercise reporting | Deferred |
| 14.7 Train Workforce on How to Identify and Report if Their Enterprise Assets are Missing Security Updates | Shared responsibility | Supported-device responsibility documented | E9, E14 | Endpoint training/enforcement absent | Organization includes in device onboarding | Deferred |
| 14.8 Train Workforce on the Dangers of Connecting to and Transmitting Enterprise Data Over Insecure Networks | Shared responsibility | Approved device/network guidance documented | E9, E14 | Formal delivery evidence absent | Organization trains on approved network/VPN policy | Deferred |
| 14.9 Conduct Role-Specific Security Awareness and Skills Training | Shared responsibility | Separate CAT member/lead/admin responsibilities documented | E14 | Completion/exercise evidence absent | Deliver role-specific onboarding and refresh | Deferred |

## Control 15 — Service Provider Management

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 15.1 Establish and Maintain an Inventory of Service Providers | Applicable | GitHub, Vercel, Neon, Cloudflare, IdP, scanner, DNS and monitoring listed | E15 | Final provider/account owner mapping private/pending | Complete private owner and review dates | Implemented |
| 15.2 Establish and Maintain a Service Provider Management Policy | Shared responsibility | Review/offboarding/contract criteria documented | E15 | Organizational approval/cadence evidence absent | Approve annual and pre-change review | Partially implemented |
| 15.3 Classify Service Providers | Applicable | Data/purpose/dependency/security responsibility captured | E15 | Formal criticality tier approval absent | Assign criticality based on data/availability | Partially implemented |
| 15.4 Ensure Service Provider Contracts Include Security Requirements | Shared responsibility | Required topics identified | E15 | Contract/legal evidence not present | Counsel/owner reviews confidentiality, incident, deletion, availability and subprocessors | Deferred |

## Control 16 — Application Software Security

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 16.1 Establish and Maintain a Secure Application Development Process | Applicable | Versioned design, CI, review, tests, scans, migrations and release gate | E16 | Provider branch evidence pending | Require exact CAT CI/CodeQL checks | Implemented |
| 16.2 Establish and Maintain a Process to Accept and Address Software Vulnerabilities | Applicable | Vulnerability intake/triage/remediation/risk process | E7, E16 | Private tracker adoption required | Record and close findings | Implemented |
| 16.3 Perform Root Cause Analysis on Security Vulnerabilities | Applicable | Required for material defects/incidents with regression tests | E7, E17 | No stage finding requiring completed RCA | Apply upon material finding | Implemented |
| 16.4 Establish and Manage an Inventory of Third-Party Software Components | Applicable | Lockfile plus CycloneDX SBOM | E2, E16 | Artifact retention evidence pending | Retain per release | Implemented |
| 16.5 Use Up-to-Date and Trusted Third-Party Software Components | Applicable | Locked supported stack, audits, Dependabot and review | E2, E7 | Ongoing provider alert review required | Patch under severity process | Partially implemented |
| 16.6 Establish and Maintain a Severity Rating System and Process for Application Vulnerabilities | Applicable | Critical/High/Medium/Low expectations and gate rules | E7, E19 | Private owner/acceptance records needed | Use consistently for all findings | Implemented |
| 16.7 Use Standard Hardening Configuration Templates for Application Infrastructure | Applicable | Versioned Next/app baseline and provider checklist | E4 | Provider IaC/export absent | Capture provider baseline evidence; consider IaC when stable | Partially implemented |
| 16.8 Separate Production and Non-Production Systems | Applicable | Separate projects/data/secrets/storage/session policy and synthetic Preview | E1, E3, E12, E19 | Live provider separation evidence pending | Complete infrastructure acceptance | Partially implemented |
| 16.9 Train Developers in Application Security Concepts and Secure Coding | Shared responsibility | Repository rules/review docs encode secure patterns | E16 | Formal developer training evidence absent | Complete periodic appsec training | Deferred |
| 16.10 Apply Secure Design Principles in Application Architectures | Applicable | Least privilege, fail closed, defense in depth, explicit trust boundaries and data minimization | E3, E6, E12, E16 | Independent validation pending | Preserve architecture and pen test | Implemented |
| 16.11 Leverage Vetted Modules or Services for Application Security Components | Applicable | NextAuth, Node crypto, PostgreSQL/S3 clients, provider MFA and scanner used | E16 | Provider/module review is continuous | Review changes and avoid custom protocols | Implemented |

## Control 17 — Incident Response Management

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 17.1 Designate Personnel to Manage Incident Handling | Shared responsibility | Required roles are listed | E17 | Named people not assigned in private register | Designate primary/backup roles | Deferred |
| 17.2 Establish and Maintain Contact Information for Reporting Security Incidents | Shared responsibility | Private contact/channel requirement documented | E14, E17 | Contact data intentionally absent/unassigned | Maintain and test private contact list | Deferred |
| 17.3 Establish and Maintain an Enterprise Process for Reporting Incidents | Shared responsibility | CAT reporting triggers and safe reporting rules documented | E14, E17 | Delivery/exercise evidence absent | Publish private channel and exercise | Partially implemented |
| 17.4 Establish and Maintain an Incident Response Process | Applicable | CAT triage, containment, evidence, eradication, recovery, notification and review plan | E17 | Organizational approval pending | Approve and review annually/after incident | Partially implemented |
| 17.5 Assign Key Roles and Responsibilities | Shared responsibility | Coordinator/technical/owner/comms/legal/provider roles defined | E17 | Named assignments absent | Assign privately with backups | Deferred |
| 17.6 Define Mechanisms for Communicating During Incident Response | Shared responsibility | Private/out-of-band communication requirement exists | E17 | Mechanisms/contact tree untested | Select and test channels | Deferred |
| 17.7 Conduct Routine Incident Response Exercises | Applicable | Annual/architecture-change exercise requirement defined | E17 | No exercise evidence | Run admin-compromise/data-exposure/restore tabletop | Deferred |
| 17.8 Conduct Post-Incident Reviews | Applicable | Required review content/process documented | E17 | No incident/exercise evidence | Perform after material incidents/exercises | Partially implemented |

## Control 18 — Penetration Testing

| CIS / safeguard title | Applicability | Current implementation | Evidence | Gap | Remediation | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| 18.1 Establish and Maintain a Penetration Testing Program | Applicable | Scope, rules, cadence triggers, accounts, evidence and handling defined | E18 | Owner/tester/cadence authorization not assigned | Approve independent program | Partially implemented |
| 18.2 Perform Periodic External Penetration Tests | Applicable | Safe non-production plan exists | E18 | No independent test performed | Execute before production approval and periodically thereafter | Deferred |
| 18.3 Remediate Penetration Test Findings | Applicable | Vulnerability/risk/RCA/retest process defined | E7, E18, E19 | No test findings yet | Track, remediate and independently retest | Deferred |

## Assessment interpretation

This matrix evaluates all 130 safeguards in the cumulative CIS v8.1 IG2 baseline. Applicability: 43 Applicable, 2 Partially applicable, 81 Shared responsibility, and 4 Not applicable—126 safeguards remain in scope in whole or shared part. Final status: 23 Implemented, 38 Partially implemented, 27 Deferred, 4 Not applicable, and 38 Provider responsibility. Do not treat documentation-only rows as operational completion. Provider/endpoint safeguards remain unsatisfied until E20 evidence exists, and deferred safeguards remain production-gate items where identified in the risk register.
