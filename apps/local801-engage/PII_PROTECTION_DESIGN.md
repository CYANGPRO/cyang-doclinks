# Stage 14B — Database PII Protection Design

Status: **design approved for implementation sequencing; no Stage 14B schema migration exists yet.**

Real Local 801 member data remains prohibited. `LOCAL801_DATABASE_PII_PROTECTION_ENABLED` must remain `0` until the protected schema, dual-write/backfill, protected reads/search/imports/reports, and synthetic acceptance tests described here are complete.

## 1. Security objective

Local 801 Engage already encrypts private document/object bytes before R2 upload. That protection does not protect ordinary PostgreSQL columns. Stage 14B adds application-layer protection for direct identifiers and other high-risk database values so a database snapshot, read-only database credential, accidental query result, or infrastructure-layer disclosure does not expose names, emails, employee/member identifiers, contact values, identity-provider subjects, import PII, or push-subscription secrets in plaintext.

The design intentionally does **not** use deterministic encryption, order-preserving encryption, or order-revealing encryption. Equality/search behavior is implemented with separately keyed blind indexes. Values displayed to an authorized user are decrypted only on the server after the existing organization/role/scope checks pass.

This is defense in depth. Authorized application code can still decrypt values, and a fully compromised running application with access to both database and PII keys can read authorized data. Existing least privilege, tenant scoping, audit, MFA, session revocation, rate limiting, backups, and operational controls remain required.

## 2. Separate key hierarchy

PII field protection must use key material **separate from the R2/object keyring**.

Planned environment contract:

```text
LOCAL801_PII_ENCRYPTION_MASTER_KEYS={"v1":"<canonical-base64-32-random-bytes>"}
LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION=v1
LOCAL801_PII_BLIND_INDEX_KEYS={"v1":"<canonical-base64-32-random-bytes>"}
LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION=v1
```

Requirements:

- encryption and blind-index roots are independently generated random 32-byte secrets;
- object-storage encryption keys are never reused;
- no key value is stored in PostgreSQL, GitHub, logs, audit payloads, URLs, client bundles, or scanner requests;
- version labels follow the same bounded identifier policy as the object keyring;
- old encryption/index versions remain available until migration/rotation is proven complete;
- production and Preview use separate PII key material.

### 2.1 Derived field keys

The application derives an AES-256-GCM key with HKDF-SHA256 from the selected PII encryption root. The HKDF context includes a fixed application/version label plus the organization, logical entity class, and field domain. Example conceptual context:

```text
local801-pii:v1 | organization:<org-uuid> | entity:people | field:first_name
```

The root key itself is never used directly for AES-GCM. Domain separation prevents one encrypted field from sharing the effective key of another field.

### 2.2 Additional authenticated data

Every encrypted field uses random 96-bit IV AES-256-GCM and AAD containing:

- format version;
- organization UUID;
- logical entity/table;
- record UUID;
- field name;
- encryption key version.

Binding the record and field in AAD prevents a valid ciphertext from being copied from one member, row, or field into another without authentication failure.

### 2.3 Storage envelope

Protected values use a versioned text envelope plus a separate key-version column where practical, consistent with the already implemented encrypted engagement-note pattern. The envelope contains ciphertext/IV/tag only; it contains no plaintext, no raw digest of the plaintext, and no key material.

The crypto API must reject unknown versions, malformed canonical base64, invalid IV/tag lengths, oversized plaintext/ciphertext, and any AAD mismatch.

## 3. Blind indexes and integrity hashes

Searchable equality cannot use ciphertext because encryption is randomized. Stage 14B uses HMAC-SHA256 blind indexes under a **separate blind-index key hierarchy**.

Each blind index is domain separated. Conceptually:

```text
HMAC(index_key, "local801-bidx:v1|org:<uuid>|domain:work_email|" + normalized_value)
```

A blind index for an email can therefore never be compared to an identifier/name index even if the normalized plaintext happens to be identical.

Blind indexes leak equality/frequency within their domain. They do not reveal plaintext directly, but low-entropy values remain guessable to an attacker who also possesses the blind-index key. The index key is therefore treated as secret key material, not as a salt.

Plain SHA-256 must not be used as a searchable index for low-entropy PII. Import row integrity that covers direct PII must likewise use a keyed/domain-separated HMAC rather than an unkeyed hash whose inputs can be guessed.

## 4. Normalization rules

Normalization is deterministic and occurs before blind indexing, never before encryption unless the application explicitly wants a normalized display value.

- Email: Unicode trim, lowercase; reject malformed/oversized addresses before indexing.
- Employee/member identifier: Unicode NFKC, trim, collapse surrounding whitespace; type-specific punctuation rules must be explicit and cannot silently merge identifiers.
- Phone: normalize to an approved canonical representation once phone validation is implemented; until then, exact normalized trim only.
- Names: Unicode NFKC, lowercase, trim, collapse internal whitespace for search/index purposes. Display encryption preserves the original approved display form.
- Search tokens: same name normalization plus explicitly documented punctuation/token boundaries.

Normalization helpers must be unit-tested with Unicode and whitespace edge cases.

## 5. Field classification and planned treatment

| Current data | Classification | Stage 14B treatment |
| --- | --- | --- |
| `users.email` | Direct identifier / authentication lookup | AES-GCM + exact email blind index; unique `(organization_id, email_bidx_version, email_bidx)` during rotation-aware cutover |
| `users.display_name` | Direct identifier | AES-GCM; Team list decrypts server-side after authorization |
| `auth_identities.provider_subject` | External direct account identifier | AES-GCM + exact provider-subject blind index; provider ID stays plaintext |
| `people.first_name` | Direct identifier | AES-GCM + exact blind index + search tokens |
| `people.last_name` | Direct identifier | AES-GCM + exact blind index + search tokens |
| `people.preferred_name` | Direct identifier | AES-GCM + exact blind index + search tokens when present |
| composite normalized person name | Search/sort derivative | AES-GCM only for server-side sorting; never plaintext/order-preserving |
| `person_identifiers.identifier_value` | High-risk direct identifier | AES-GCM + type/domain-separated exact blind index; uniqueness moves to blind index |
| `person_contact_methods.contact_value` | Direct identifier/contact data | AES-GCM + type/domain-separated exact blind index |
| `contact_correction_requests.proposed_value` | Potential direct identifier | AES-GCM; blind index only if a reviewed workflow needs equality matching |
| `import_files.original_filename` | User-controlled metadata that can contain PII | AES-GCM; UI decrypts only for authorized import reviewers |
| direct-PII keys currently in `import_rows.normalized_json` | Temporary imported PII | Removed from plaintext JSON after protected cutover; stored in protected companion staging record |
| imported direct-PII equality values | Import matching | HMAC blind indexes in protected import staging |
| import row integrity over PII | Integrity/fingerprint | Keyed/domain-separated HMAC; no raw PII in fingerprint inputs exposed outside the protected service |
| `import_errors.message` | Diagnostic text | Template/code only; imported raw values are forbidden |
| `report_runs.parameters` | Potential PII/filter persistence | Restrict to allowlisted non-PII dimensions/opaque IDs; encrypt any separately approved PII parameter rather than storing free text |
| `push_subscriptions.subscription_json` | Secret-like browser endpoint/key material | AES-GCM; replace/augment endpoint hash with keyed blind index |
| `audit_events.payload` | Security metadata | PII-free allowlisted metadata/hashes/opaque IDs only; no encrypted PII is necessary if policy is followed |
| `user_notifications.generic_body` | Notification text | Must remain generic/PII-free; target URLs use opaque handles |
| `department`, `section`, `classification`, `work_location`, `membership_status`, Local number | Operational/quasi-identifying dimensions | Remain plaintext initially for authorized filtering, SQL aggregation, historical snapshots, and reporting; documented residual risk |
| campaign/action/instruction/task/document titles | Confidential operational/strategy data; not inherently direct PII | Not part of initial direct-PII cutover. Separate narrative/confidential-data review remains required; names of individuals must not be placed in titles as a workaround |
| engagement narrative notes | Restricted narrative | Already protected through encrypted engagement-note path; remains separate |
| R2 document bytes | File content | Already AES-256-GCM encrypted before upload; unchanged |

### 5.1 Why operational dimensions remain plaintext initially

Encrypting department, classification, section, work location, membership status, and snapshot dimensions would prevent efficient authorized grouping/filtering and substantially redesign reporting. Stage 14B instead pseudonymizes rows by removing the direct identifiers while retaining these operational dimensions.

This is an explicit residual-risk decision, not a claim that those fields are non-sensitive. Small combinations can still identify a person. Existing report small-cell suppression, person-level permissions, tenant isolation, export controls, and access review remain required. A future coded-dimension/tokenization project can reduce that residual risk without blocking the initial production launch.

## 6. Person search and directory pagination

### 6.1 No deterministic name ciphertext

Names will not be stored under deterministic or order-preserving encryption. The application uses a separate blind-token search table for authorized name search.

Proposed logical table:

```text
person_search_tokens
- organization_id
- person_id
- token_version
- token_domain       # first_name, last_name, preferred_name, combined_name
- token_hash         # HMAC-SHA256
- token_kind         # word / prefix
```

Only HMAC tokens are stored. No plaintext token or normalized name is stored in this table.

For each approved name word, the server can generate bounded prefixes (for example minimum 2 or 3 characters through a maximum of 20) and HMAC them. The exact minimum/maximum will be selected after synthetic usability/performance tests. Search terms shorter than the minimum do not query the blind-token table.

The token table leaks token equality/frequency, which is documented as residual leakage. It is preferable to deterministic name encryption and keeps raw names out of PostgreSQL indexes.

### 6.2 Department/classification/location search

Operational dimensions can continue to use normalized plaintext filters. Free-text Directory search may combine:

- blind-token matches for names;
- exact email/contact blind-index match where the input is an email-like value;
- existing bounded operational dimension matches.

Raw search input must not be logged, audited, placed in URLs beyond the existing short-lived request query, or persisted to report/audit records.

### 6.3 Alphabetical ordering

The application must not introduce order-preserving encryption. Instead each person receives an encrypted normalized composite sort value such as normalized last/first/preferred name. For a bounded authorized candidate set, the server:

1. applies organization/scope/operational/blind-token filters in PostgreSQL;
2. fetches only candidate IDs plus encrypted sort values;
3. decrypts sort values server-side;
4. sorts in application memory;
5. slices the requested page;
6. loads/decrypts full details only for the selected page.

A hard candidate cap is mandatory. If a future production roster exceeds the reviewed cap, the user must narrow the search/filter instead of causing an unbounded decrypt/sort. The cap is chosen through synthetic load testing, not guessed in migration SQL.

Outreach queues are already bounded and can use the same decrypt-then-sort technique after priority ranking.

### 6.4 Cursors

Current Directory/Outreach cursors base64-encode plaintext sort names. Stage 14B replaces them with an authenticated opaque cursor. Cursor payloads may contain sort state and opaque record handles only inside an AES-GCM or equivalent authenticated server-only envelope. Cursors expire/bound size and never expose raw names or internal UUIDs in clear/base64 form.

## 7. Authentication and Team & Access

Production OIDC currently resolves a provisioned user by plaintext email. Protected authentication will:

1. normalize the verified OIDC email;
2. compute the organization/domain-separated email blind index;
3. locate exactly one active Local 801 user by blind index;
4. decrypt the stored email only after the candidate is resolved and verify normalized equality defensively;
5. bind/resolve the provider subject using its blind index;
6. continue enforcing exactly one role, deactivation state, and `auth_session_version`.

Team & Access returns at most 500 users and therefore can decrypt display name/email server-side after `manageUsers` authorization. Role/account-state/session mutations continue to address users by opaque handles and do not require plaintext PII in mutation URLs.

No local password/TOTP data is introduced.

## 8. Protected import staging and execution

Imports are the most important compatibility boundary. The current synthetic Stage 12 review/executor performs SQL comparisons directly against `import_rows.normalized_json`. That design cannot be used for real data after direct PII is removed from plaintext JSON.

### 8.1 Protected import row companion

Stage 14B will add a protected companion record for each imported row. Conceptually it holds:

- encrypted first/preferred/last name;
- encrypted work email;
- encrypted employee/member identifiers;
- encryption key version(s);
- exact blind indexes for fields required for matching/change detection;
- keyed row-integrity HMAC/version;
- presence/validation flags that contain no raw values.

`import_rows.normalized_json` remains for reviewed operational non-direct fields such as membership status, department, section, classification, and work location. Direct PII must be deleted from/never written to that JSON once protected mode is enabled.

Import errors use codes/templated messages and field names only. They must never interpolate the rejected name, email, identifier, phone, address, or other imported raw value.

### 8.2 Matching and review

Existing-person matching uses blind indexes:

- employee identifier blind index;
- member identifier blind index;
- work-email blind index.

Exact name/email/identifier change detection uses field-domain blind-index equality rather than decrypting entire rosters in SQL. Review detail decrypts only the authorized page of import rows on the server.

Set hashes/fingerprints continue to use stable source coordinates, classification, opaque person IDs, and keyed row-integrity values. Raw imported values never enter a user-visible fingerprint.

### 8.3 Production execution staging

The current Stage 12 executor remains Preview-only and must stay disabled in production. A protected production executor will not ask PostgreSQL to decrypt values and will not perform an unbounded per-row JavaScript write loop inside the final commit.

Before final approval, a protected preparation step will:

1. resolve or allocate stable target person UUIDs;
2. encrypt every target-bound protected value with AAD containing its final target UUID/field;
3. compute target blind indexes/search tokens;
4. persist immutable protected mutation staging rows;
5. include hashes of those staged mutations in the execution fingerprint.

The final authoritative transaction can then copy pre-encrypted values/indexes/tokens into their destination rows with set-based SQL, write membership/employment/snapshot/audit records, record approval, and mark the batch approved atomically. If the staged mutation set or review set changes, fingerprint verification fails and the transaction does not run.

## 9. Reports, exports, and audit

### 9.1 Reports

Aggregate reports continue to operate on approved operational dimensions and opaque person IDs. Report definitions/queries must not depend on plaintext names/emails/identifiers.

Person-level authorized reports resolve/decrypt display PII only after `viewPersonLevelReports` authorization and only for the bounded result set returned to the user.

Persisted `report_runs.parameters` must be allowlisted. Non-PII dimensions/status/date ranges may remain plaintext. Raw names, emails, identifiers, search strings, narrative notes, or contact values are forbidden unless a separately reviewed encrypted parameter representation is introduced.

### 9.2 Exports

An authorized export may contain decrypted PII because the user explicitly requested a person-level data product, but decryption happens on the server immediately before generating the bounded export. Existing export permissions, row caps, rate limits, small-cell rules, auditing, and encrypted/private temporary storage requirements still apply.

### 9.3 Audit

Audit payloads store security/operational facts only: opaque subject IDs, event type, role codes, statuses, counts, set hashes, boolean flags, and non-sensitive configuration names. Audit code/tests will reject or avoid raw email/name/contact/identifier fields. Encrypting PII inside audit payloads is avoided because immutable audit history should not become a second copy of member data that must be searched/rotated/deleted.

## 10. Push subscriptions and notifications

Push subscription JSON contains endpoint/authentication material and will be encrypted with PII field protection. Endpoint equality/deduplication uses a keyed blind index rather than an unkeyed hash. The application decrypts a subscription only immediately before an authorized server-side push operation.

Notification body text stays generic and must not include member PII or strategic notes. Target URLs use application paths with opaque handles/IDs, not names or emails.

## 11. Migration and cutover sequence

No destructive migration occurs first. The sequence is deliberately additive and reversible:

1. **Design:** commit this field/search/import threat model. No schema change.
2. **Crypto layer:** implement separate PII keyring parsing, HKDF/AES-GCM field envelopes, blind indexes, normalization, opaque cursor helper, rotation semantics, and unit tests. No schema change.
3. **Additive migration:** add protected columns/tables/index versions/search-token/import-staging structures while retaining current plaintext columns for synthetic compatibility.
4. **Synthetic dual write:** update new synthetic user/person/contact/identifier/import writes to produce both legacy and protected representations.
5. **Synthetic backfill:** build an explicit protected backfill command with Preview/non-production guards, bounded batches, resumability, validation counts/hashes, and no raw-value logging.
6. **Protected reads/search/auth:** switch Team, production OIDC lookup, Directory, Outreach, Campaign participant views, Follow-ups, and person detail to protected values/search tokens.
7. **Protected imports:** switch parser/review/details/matching to protected import staging and remove direct PII from newly written `normalized_json`.
8. **Protected production execution design/implementation:** use immutable target-bound ciphertext staging; keep the Stage 12 Preview executor off in production.
9. **Reports/exports/audit acceptance:** prove aggregate reports remain correct and person-level outputs decrypt only after authorization; verify audit/log payloads contain no raw PII.
10. **Synthetic acceptance:** search, alphabetical pagination, OIDC identity binding/session revocation, Team controls, import review, protected execution fixture, reports, exports, rotation, tamper, and raw-database scans all pass.
11. **Constraint phase:** require protected values/indexes for protected-mode records and prevent new plaintext direct-PII writes.
12. **Plaintext removal:** only in a later separately reviewed forward migration after backfill/cutover acceptance. Drop legacy plaintext direct-PII columns/indexes and scrub old import direct PII.
13. **Production flag:** only after the protected schema is deployed and accepted may `LOCAL801_DATABASE_PII_PROTECTION_ENABLED=1` be set manually.

No migration step automatically enables production or real data.

## 12. Key rotation

### 12.1 Encryption rotation

- Add a new PII encryption root version while retaining previous versions.
- Make the new version active for new writes.
- Read supports all retained versions.
- Re-encrypt protected records in bounded resumable batches using correct record/field AAD.
- Verify counts and decryptability before removing the old key from configuration.

### 12.2 Blind-index rotation

Blind-index rotation cannot be a simple key swap because old rows would become unsearchable. Protected tables therefore record blind-index version. Rotation uses an overlap window:

- add new index key/version;
- compute/store new-version indexes/tokens for all protected values while old indexes remain;
- queries calculate candidate hashes under active + allowed previous versions;
- verify full coverage;
- make the new version sole active query/write version;
- remove old indexes/tokens, then retire old index key.

No blind-index key is retired until every searchable protected record has a verified current-version index.

## 13. Required Stage 14B acceptance tests

At minimum:

- same plaintext encrypted twice produces different ciphertext;
- correct context decrypts; changed organization/entity/record/field/AAD fails authentication;
- malformed/version/oversized envelopes fail closed;
- exact blind index is stable under the same domain/key and different across fields/domains/organizations/versions;
- Unicode normalization behavior is deterministic and tested;
- raw database representations contain no synthetic test name/email/employee/member identifier after protected-only cutover;
- Directory name/email search returns the expected authorized people using protected indexes;
- Directory alphabetical results remain correct and bounded without order-preserving ciphertext;
- Directory/Outreach cursors contain no recoverable plaintext name/email/internal UUID;
- production OIDC resolves by protected email index and rejects wrong subject/email/session version;
- Team list decrypts only after `manageUsers` authorization and mutations remain opaque-handle based;
- import matching/classification/change detection works without direct PII in `normalized_json`;
- import error text contains no imported raw values;
- production execution staging fingerprint changes when protected mutation content changes and final write remains atomic;
- aggregate report results are unchanged by PII protection;
- person-level report/export decryption requires the existing permission and bounded result size;
- audit events/logs do not contain synthetic names/emails/identifiers/contact values;
- push subscription payload is ciphertext at rest;
- encryption rotation supports old+new read and successful re-encryption;
- blind-index rotation supports overlap without making records unsearchable;
- missing/wrong keys fail closed and never fall back to plaintext.

## 14. Explicit non-goals of the first Stage 14B cutover

- No client-side/member-held encryption keys.
- No order-preserving/order-revealing encryption.
- No database-side decryption functions or keys stored in PostgreSQL.
- No attempt to hide row counts, timestamps, membership status, department/classification/location dimensions, or graph relationships from a database-level observer.
- No automatic enablement of production launch.
- No reuse of DocLinks keys, credentials, buckets, database, or auth environment.
- No modification of DocLinks.

## 15. Implementation checkpoint

The next code slice after this document is **Stage 14B1 crypto/config primitives only**. It will not add or mutate database schema. Schema migration `0012` will be designed only after the independent PII cryptography, normalization, blind-index, and opaque-cursor tests are green on Preview.
