# Staging Fire Drill

Last updated: March 15, 2026

Run the staging validation pack with real staging env vars:

```bash
npm run fire-drill:staging
```

This covers:

- release-gate config validation
- build success
- upload / encrypt / share / revoke / expire checks via `tests/security-state.spec.ts`
- password/email restricted access checks via `tests/security-state.spec.ts`
- malware/quarantine blocking via `tests/security-state.spec.ts`
- incident freeze path via `tests/security-freeze.spec.ts`
- Stripe webhook flow via `tests/billing-webhook.spec.ts`
- backup/report verification via `npm run restore:verify -- --require-current-migrations`
- live presign/upload/head/get against the deployed R2 bucket via `npm run runtime:proof:live`
- live scanner + `/api/cron/scan` execution against the deployed scanner endpoint via `npm run runtime:proof:live`
- live Stripe-generated events delivered into the deployed webhook via `npm run runtime:proof:live`
- restored-backup verification against a recovery target via `npm run runtime:proof:live`

## Required Live-Proof Env

`fire-drill:staging` now expects these operator-provided secrets in addition to the normal staging env:

- `LIVE_RUNTIME_BASE_URL`
- `LIVE_SMOKE_EMAIL`
- `LIVE_SMOKE_PASSWORD`
- `LIVE_RESTORE_TARGET_DATABASE_URL`
- `LIVE_RESTORE_EXPECTED_BACKUP_FILE`

Optional but recommended:

- `LIVE_RESTORE_TARGET_BASE_URL`
- `LIVE_RUNTIME_STRIPE_PRICE_ID`

Safety note:

- `runtime:proof:live` refuses to create Stripe resources with an `sk_live_...` key unless `LIVE_RUNTIME_STRIPE_ALLOW_LIVE=1` is set deliberately.

## Manual Follow-ups

After the scripted fire drill, verify:

1. `/api/health/live`
2. `/api/health/ready`
3. `/api/health/deps`
4. `/api/backup/status` is receiving real backup reports
5. key rotation queues in the admin security surface show no failed jobs

## Expected Operator Artifacts

- release-gate output archived in the deploy record
- migration status output archived in the deploy record
- latest backup/restore verification output archived in the deploy record
- `.tmp/live-runtime-proof-summary.json` archived in the deploy record
- any incident-freeze test evidence linked from the deployment checklist
