# Production Readiness Validation

Last updated: March 15, 2026

## Primary Validation Command

Run this on a fresh machine or CI worker:

```bash
npm run production-readiness
```

It validates:

- `.env.example` completeness
- documented intentional extras in `.env.example`
- ordered migration manifest integrity
- admin-route guard audit
- lint
- typecheck
- build
- production dependency audit
- release-gate config checks when deployment env vars are present

## Release Gate

Run this in staging/production with real env vars loaded:

```bash
npm run release:gate
```

It fails on:

- missing critical secrets/config
- insecure placeholder values
- dangerous debug or insecure fallback flags
- missing malware scanning config
- pending or drifted database migrations when `DATABASE_URL` is set

`release:gate` now writes a truthful runtime summary when requested:

- runtime env audit passed / failed / skipped
- migration status current / failed / skipped
- clear distinction between repo/build proof and live env proof

## Recommended Deployment Sequence

1. `npm ci`
2. `npm run production-readiness`
3. Load staging env vars
4. `npm run release:gate`
5. `npm run db:migrate -- apply`
6. `npm run fire-drill:staging`
7. Promote to production
8. `npm run release:gate`
9. `npm run db:migrate -- apply`

`npm run fire-drill:staging` now includes `npm run runtime:proof:live`, which is the deployed smoke pack for:

- real R2 presign/upload/head/get
- real scanner + `/api/cron/scan`
- real Stripe-generated webhook delivery
- real restored-backup target verification

## Related Docs

- `docs/environment-ownership.md`
- `docs/database-migrations.md`
- `docs/staging-fire-drill.md`
- `docs/backup-recovery-runbook.md`
