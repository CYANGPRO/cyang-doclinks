# CAT Incident Response Plan

The organization must privately designate the incident coordinator, technical lead, system owner, communications contact, identity/provider contacts and legal/privacy counsel. This repository does not invent notification authority or legal deadlines.

## Incident definition and process

A CAT security incident includes suspected unauthorized member-data access/disclosure, compromised account/session/secret, malicious upload, unauthorized import/export/report, security-control bypass, active exploitation, destructive/corrupt activity, or material loss of availability/recovery capability.

1. **Report and triage:** record reporter, time, observed facts, affected account/data/environment/provider and immediate safety risk in the approved private channel. Do not paste member data or secrets into tickets/chat.
2. **Contain:** revoke sessions/accounts, disable compromised credentials/integrations, block abusive traffic, pause deployment/import/export or keep production launch disabled. Preserve service availability only when containment remains safe.
3. **Preserve evidence:** retain CAT audit events, Vercel/runtime/firewall logs, IdP events, GitHub events, database/storage provider logs, deployment IDs and relevant configuration. Record UTC times and hashes for exported evidence.
4. **Eradicate:** patch/roll back vulnerable code, rotate affected secrets/keys, remove malicious files/accounts, correct provider settings and add regression tests.
5. **Recover:** validate clean deployment, auth, database, R2, scanner, monitoring and backups. Restore only under the recovery runbook and explicit authorization.
6. **Notify/escalate:** system owner plus organization-designated leadership. Legal/privacy counsel determines member, union, regulator, insurer, law-enforcement or contractual notification obligations.
7. **Review:** document cause, timeline, control failures, data affected, decisions, recovery evidence and assigned improvements. Conduct the review after material incidents and exercises.

## Playbooks

### Compromised administrator account

Deactivate the CAT user and increment session version; disable/recover the IdP identity; revoke provider sessions/tokens if affected; review role/account/export/download/config events; inspect peer admin changes; restore access through a different verified administrator; rotate credentials the account could access.

### Suspected member-data exposure

Stop the access path without deleting evidence; identify organization, data classes, records, actors, downloads/exports and time window; revoke sessions/links/credentials; preserve CAT/provider logs; validate encryption/key exposure; involve legal/privacy counsel for notification decisions; monitor misuse and remediate the root cause.

### Leaked application secret

Identify exact secret and environments without printing it; disable/rotate at the issuing provider; update Vercel/GitHub environment secret; redeploy; revoke old sessions if `NEXTAUTH_SECRET`; re-encrypt/rotate only under the key runbook if an encryption key leaked; search authorized security logs/history and verify the old credential fails.

### Malicious uploaded file

Keep scanner/upload fail-closed; locate only opaque object/audit identifiers; quarantine/delete through the authorized storage workflow; do not open on an unmanaged endpoint; investigate uploader/account and scanner evidence; rotate scanner credential if integrity is in doubt; add a safe synthetic regression case.

### Unauthorized export/report

Revoke actor sessions and disable account if warranted; identify report/export type, scope, download time and destination if known; preserve audit/provider logs; remove server-side generated object where authorized; treat endpoint copies as exposed until proven otherwise; involve privacy/legal counsel.

### Vulnerable dependency under active exploitation

Determine reachability and deployed versions; block/disable affected function or roll back; patch to a supported version and run complete gates; rotate exposed credentials; inspect CodeQL/Dependabot/runtime/WAF indicators; redeploy and monitor; record root cause and regression/monitoring improvements.

## Exercises

Run at least annual tabletop exercises and after major architecture changes. Exercise administrator compromise plus data exposure/restore at minimum; record gaps and owners. A tabletop is not a penetration test or restore proof.

### Required first tabletop scenario and pass record

Use only synthetic identifiers and the private incident channel. The facilitator records UTC start/end times, participants by assigned incident role, each decision, evidence requested, communications owner, recovery checkpoint, gap owner, due date, and final disposition.

1. **Inject 1 — identity compromise:** a synthetic administrator's Entra sign-in shows unexpected MFA recovery followed by CAT access and a high-volume protected export signal. The team must identify the incident coordinator, revoke the Entra identity and CAT sessions, preserve IdP/CAT/Vercel evidence, protect unaffected administrators, and identify who has notification authority.
2. **Inject 2 — possible disclosure:** logs cannot initially prove whether the export completed. The team must define the affected time window and data classes without copying protected data into the exercise record, preserve audit/provider evidence, involve privacy/legal, and state what would trigger member, contractual, insurer, or regulator review.
3. **Inject 3 — scanner outage during containment:** new uploads fail closed while the shared scanner is unavailable. The team must keep unsafe delivery blocked, choose whether to pause uploads, identify the scanner operator/escalation path, and refuse an unscanned bypass.
4. **Inject 4 — recovery:** the latest database backup and encrypted-object recovery copy are available. The team must select a disposable restore target, identify the key custodian and recovery operator, validate checksums/decryption with synthetic data, and define the approval needed before normal service resumes.
5. **Inject 5 — closure:** require a clean deployment, session-revocation evidence, scanner recovery, private-storage validation, monitoring receipt, backup status, a preliminary cause, and assigned remediation before declaring recovery.

The exercise passes only if every required role and alternate acknowledged the call tree; session/account containment, evidence preservation, scanner fail-closed behavior, recovery authority, privacy/legal escalation, internal communications, and restoration criteria were each exercised; and every gap has an owner and due date. The accountable owner signs the private after-action record. Repository documentation and an AI-led walkthrough alone are preparation, not evidence that the human tabletop occurred.
