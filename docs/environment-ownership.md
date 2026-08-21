# Environment Ownership

Last updated: March 22, 2026

Use `.env.example` as the single reviewed template for local proof runs and deploy setup. It is intentionally organized into four ownership buckets:

## 1. Proof / Local Runtime

These keys are enough for a clean repo proof run with placeholder values:

- app URLs and public runtime labels
- core secrets used by guards and hashing
- placeholder storage/database/provider values
- route limits and timeout guardrails needed by tests/builds

You do not need live third-party credentials for:

- `npm run prove:build`
- `npm run production-readiness`
- local UI development against placeholder values

`prove:build` prefers the pinned Volta baseline, but it now accepts any Node/npm pair that satisfies the repo engine range. The pinned baseline remains the recommended reproducible proof runtime.

## 2. Deploy Required

Real staging/production deployments must replace the placeholders for:

- `DATABASE_URL`
- `APP_URL`, `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL`
- R2 access keys and bucket
- document master keys
- core secrets such as `APP_SECRET`, `NEXTAUTH_SECRET`, `CRON_SECRET`, cookie secrets, and audit/hash salts
- the approved OVHcloud malware scanner URL, a registered DocLinks client ID, and its matching HMAC secret
- owner/admin contact values

If Stripe or backup automation are enabled in a real environment, the corresponding live secrets are also required.

## 3. Optional Integrations

These are intentionally optional and should only be set when the integration is actually in use:

- Google / OIDC identity provider settings
- Resend email delivery settings
- Stripe billing inputs
- status and backup webhook destinations
- Sentry build-time values

## 4. Advanced Ops / Tuning

These keys exist for operational control, not basic setup:

- rate limits
- route timeouts
- cache durations
- queue and anomaly thresholds
- retention / recovery cadence
- rollout toggles such as strict env validation and serve-disable controls

## Intentional Extras

The env audit now distinguishes between:

- missing referenced keys: failing
- unexpected extras: failing
- intentional extras: explicitly documented in `scripts/lib/env-example-manifest.mjs`

Intentional extras are reserved for controlled cases such as compatibility aliases, deploy-only metadata, or public-shell flags that are not always statically referenced.

## Reviewer Commands

```bash
npm run audit:env-example
npm run production-readiness
npm run release:gate
```

Interpretation:

- `audit:env-example` proves the template matches repo usage and only keeps documented extras.
- `production-readiness` proves repo/build checks and reports when live runtime proof was skipped.
- `release:gate` is the deploy-time check for real envs and migration status.
