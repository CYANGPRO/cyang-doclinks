# Production move and rollback runbook

This runbook moves an already accepted release candidate to Production. It does not grant launch or real-data authority. `docs/MANUAL_PRODUCTION_ACTIONS.md` must be complete first.

## Release candidate

1. Freeze the candidate SHA on `preview`; accept no feature changes.
2. Run `npm ci`, `npm run release:gate`, `npm run native:sync`, and `git diff --exit-code` on Node 24.
3. Run disposable PostgreSQL integration and scale gates against explicitly authenticated synthetic targets.
4. Confirm the matching Vercel Preview deployment is READY and review browser/runtime logs for the exact SHA.
5. Complete independent security/authorization review and attach only non-secret references to the release record.
6. Open the reviewed `preview` to `main` promotion PR. Merge only the immutable accepted head; do not squash away the evidence chain.

## Infrastructure order

1. Provision separate Vercel, Neon, R2, scanner, Sentry, Entra, push, and native resources.
2. Apply all forward migrations to the empty isolated Production database.
3. Configure independent keyrings and runtime secrets with launch, pilot, maintenance, and legacy import switches off.
4. Load synthetic acceptance data, prove protected-only database state, perform storage reconciliation, and complete backup/restore.
5. Complete the synthetic Production-origin pilot using only the two pilot flags. Durable Production import processing and real data remain locked during the pilot.
6. Turn the pilot flags off, remove synthetic acceptance records under the approved procedure, and verify the empty/approved initial state.

## Launch order

1. Confirm the exact GitHub SHA, Vercel deployment, migration chain, Production environment inventory, TLS/domain, Entra callback, scanner, Sentry alert, restore evidence, and approvals.
2. Set the database-PII, restore-verification, and security-review flags only when their evidence is complete.
3. Run `npm run security:production-preflight`; it tests the would-be launch state without changing the persisted launch flag. Do not proceed with any blocker.
4. Record Chang Yang’s final written launch and real-data authorization.
5. Set `LOCAL801_PRODUCTION_LAUNCH_ENABLED=1` last and redeploy the accepted SHA.
6. Run `npm run security:production-readiness` against the active environment and preserve the safe result.
7. Verify sign-in/MFA/policy acknowledgement, seven-role access, `/settings` readiness, session revocation, scanner fail-closed behavior, private storage, rate limits, push delivery, and critical desktop/mobile workflows.
8. Load the approved roster through the protected durable import path, review the plan, execute with the required fingerprint/acknowledgements, and independently reconcile counts and sampled records.
9. Begin with limited CAT leadership access. Add Report Viewers after one successful day; expand other access only at the approved control point.

## Encrypted R2 recovery drill

Run this from a trusted owner-controlled workstation before setting the backup/restore verification flag. Retrieve the Production R2 and object-encryption values from the approved escrow directly into process-scoped environment variables; do not place them in shell history, files, screenshots, chat, or repository evidence.

Required values are `LOCAL801_R2_ACCOUNT_ID`, `LOCAL801_R2_ENDPOINT`, `LOCAL801_R2_BUCKET`, `LOCAL801_R2_ACCESS_KEY_ID`, `LOCAL801_R2_SECRET_ACCESS_KEY`, `LOCAL801_ENCRYPTION_MASTER_KEYS`, and `LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION`. Then set both explicit interlocks:

```text
LOCAL801_R2_RECOVERY_EXPECT_BUCKET=local801-engage-private
LOCAL801_R2_RECOVERY_CONFIRM=CREATE_ENCRYPTED_SYNTHETIC_OBJECT_AND_DELETE
```

Run `npm run storage:recovery-drill`. Acceptance requires exactly `storageRecovery: ok`, `encryptedRoundTrip: ok`, and `cleanup: ok`. The command writes one application-encrypted synthetic object, authenticates its download/decryption, deletes it after success or failure, and verifies absence. A `R2_RECOVERY_CLEANUP_FAILED` result is a launch blocker that requires inspecting and removing the synthetic orphan before retrying. Clear every process-scoped secret immediately after the command, then run the read-only storage reconciliation before marking the combined Neon/R2 recovery gate complete.

## Immediate suspension

Chang Yang or the named incident commander may suspend access without deleting data:

1. Set `LOCAL801_PRODUCTION_LAUNCH_ENABLED=0` and redeploy/restart authentication state.
2. Revoke affected Entra assignments/sessions and increment application session versions where applicable.
3. Disable authoritative and protected import execution switches.
4. Preserve immutable logs/audit evidence; do not rotate away keys needed for investigation or recovery.
5. Open the incident record, notify the approved contacts, classify scope, and decide restore versus correction.

## Rollback and recovery

- Application rollback uses the last accepted immutable Vercel deployment only when its schema compatibility is proven.
- Database rollback is restore/forward-correction, never editing or reversing an already-applied migration in place.
- Restore into an isolated target first, reconcile protected counts and audit state, then use the approved cutover procedure.
- R2 recovery must preserve encryption metadata/key versions and SHA-256 integrity. Run read-only reconciliation before reopening access.
- If a key is suspected compromised, suspend access, preserve old material for controlled decryption, add a new version, rotate/reconcile, and revoke the compromised credential after recovery is proven.
