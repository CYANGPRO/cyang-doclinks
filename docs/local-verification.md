# Local Verification

Last updated: March 25, 2026

## Primary Command

Run this in a clean sandbox when you want the repo to prove the highest-risk runtime flows without live cloud services:

```bash
npm run verify:local
```

This command loads `.env.example`, overlays `.env.local.verify.example`, and then runs:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- deterministic runtime-proof suites through `npm run verify:runtime`

The proof entrypoints now share a repo-level proof lock. If another proof command is already active, the next one waits instead of racing on `.next`, the local server, or proof artifacts.

## Test Command Split

The repo test entrypoints now separate deterministic and environment-gated behavior:

```bash
npm test
```

Runs the local-safe Playwright suite only. These tests are intended to pass in an isolated sandbox without live cloud dependencies.

```bash
npm run test:live-ish
```

Runs the environment-gated suites that still depend on runtime state such as a real database-backed fixture set, live-like webhook setup, or rate-limit-sensitive scenarios.

If you want the focused runtime proofs only, run:

```bash
npm run verify:runtime
```

## Local Verification Adapters

When `VERIFY_LOCAL_RUNTIME=1`, the local verification command documents and exercises these deterministic adapters:

- database: deterministic route-level state adapter used by the runtime-proof suites
- object storage: in-memory object store adapter
- malware scanner: deterministic clean / infected / unknown / unavailable adapter
- billing webhook: signed local fixture adapter
- health: injectable dependency summary adapter
- audit + security events: in-memory capture adapter
- restore verification: deterministic restore snapshot adapter

Business rules stay shared with production routes and actions. Only the infrastructure-facing dependencies swap.

## Runtime Proof Coverage

The local verification suite proves:

- upload init -> finalize -> scan cron -> release / serve
- scanner unavailable and unknown-result fail-closed behavior
- password-protected share creation and unlock behavior
- alias/token unlock behavior
- expiry and revocation denial behavior
- Stripe webhook signature, duplicate, malformed, oversized, and entitlement transitions
- public health sanitization at the route layer
- restore/readiness verification logic in executable form

## What Is Still Not Fully Proven Locally

Local verification does not replace live-environment proof for:

- real Neon/Postgres connectivity, migrations, and network behavior
- real Cloudflare R2 presign/upload/head/get behavior
- real external malware scanner network behavior
- real Stripe delivery from Stripe’s infrastructure into the deployed webhook
- real restore of a production backup into a recovery target

Those remain covered by `npm run fire-drill:staging` and `npm run runtime:proof:live`.
