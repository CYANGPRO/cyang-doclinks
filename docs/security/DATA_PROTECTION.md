# CAT Data Protection Review

## Classification

| Class | Examples | Required handling |
| --- | --- | --- |
| Public / non-sensitive | Generic UI, icons, offline page, published policy text | May be publicly cached only when explicitly static |
| Operational CAT | Campaign status, assignments, task state, non-sensitive aggregate metrics | Authenticated, organization-scoped, least privilege, no public caching |
| Membership information | Membership/employment status and history | Protected PII storage/read paths; membership-management or scoped role access |
| Personal/member data | Names, identifiers, contact values, addresses, hire/employment details | AES-256-GCM field envelopes, blind indexes where search is required, protected hydration only after authorization |
| Protected narrative notes | Engagement narratives and restricted strategy context | Separate encrypted envelopes plus writer/assignment/role visibility before decryption |
| Administrative/security metadata | Roles, session versions, audit targets, security blocker codes | Administrator-only; keep values minimal and non-secret |
| Authentication/session information | OIDC subject link, MFA timestamps, encrypted JWT session, auth secrets | Host-scoped secure cookies; server revalidation; secrets only in environment/provider stores |
| Reports and exports | Aggregates, error CSVs, generated reports, person-level output | Permission, organization and small-cell/person-level checks; attachment download; no-store; audit |
| Uploaded documents/source files | Imports and restricted documents | Extension/type/size checks, malware scan, AES-256-GCM object encryption, opaque R2 keys, private download |

## Verified technical controls

- TLS is required for canonical application/OIDC/R2 endpoints; the production launch gate now rejects a PostgreSQL URL without `sslmode=require`, `verify-ca`, or `verify-full`.
- Protected PII uses a key hierarchy separate from object-storage keys, versioned AES-256-GCM envelopes, separate blind-index keys, rotation tooling, additive migrations, and protected read/import/report tests.
- Object bytes are encrypted before R2 upload; R2 stores opaque `application/octet-stream` objects under `local801/{documents|imports|reports}/YYYY/MM/<uuid>` keys.
- Database queries and storage services require server-derived organization and role context. Protected data is decrypted/hydrated only after organization, role, visibility, and where relevant assignment/person-level checks.
- Protected responses use no-store controls. Downloads use `Content-Disposition: attachment`, `nosniff`, safe filenames, bounded bytes, and same-origin resource policy.
- Audit payload keys resembling names, email, phone, address, contact, note, or raw content are redacted. Public errors contain bounded codes/messages rather than SQL, secrets, or protected content.
- CI/tests cover protected PII leakage, cross-organization queries, visibility, object access, imports, reports, encryption integrity, tampering, and stream limits.

## Retention, deletion, and recovery gaps

- A formal organization-approved retention schedule for membership records, narratives, imports, reports, documents, audit logs, and backups is still required.
- Document deletion archives metadata, records cleanup-pending state, deletes the private object, and then removes metadata; orphan/cleanup operations still need an operator runbook and monitoring.
- Generated reports may expire, but an automated purge job and end-to-end retention evidence are not established.
- Browser/device downloads leave CAT control. Users must minimize exports and store/delete them under approved endpoint policy.
- R2 application objects need a separate recovery design; the application must not assume that an object identifier/version field is recoverable object history.

Real member data remains prohibited until the production gate records approved retention/deletion, backup/restore, monitoring, privacy, and infrastructure evidence.
