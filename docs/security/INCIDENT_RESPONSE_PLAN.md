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
