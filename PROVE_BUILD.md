# Prove the Build

This repository is set up so a reviewer can verify the build from a clean container or VM without relying on the original developer machine.

## Proof Baseline

- Node.js: `22.16.0`
- npm: `10.9.2`
- Package manager: `npm` with the committed `package-lock.json`

The repo also declares:
- `.nvmrc`
- `.node-version`
- `package.json` `packageManager`
- `package.json` `engines`
- `package.json` `volta`

Use the exact baseline above for the cleanest proof result.

## Windows Convenience Path

If you are on Windows and `npm run prove:build` fails immediately because your shell is not on the pinned runtime, use:

```bash
npm run setup:proof:windows
```

That helper:
- checks the active Node/npm versions
- uses Volta automatically if it is installed
- otherwise uses nvm-windows if it is installed
- otherwise prints the exact install/switch commands you need

It does not relax the pinned proof baseline. It is only a convenience path to reach it faster.

If Volta is already installed but your current shell has not picked up the new PATH yet, you can run the full proof path directly through the installed binary:

```powershell
& "C:\Program Files\Volta\volta.exe" run --node 22.16.0 --npm 10.9.2 npm run prove:build
```

That command was verified against this repository and cleanly reuses the pinned Node/npm baseline for the full proof sequence.

## Primary Proof Path

Run the pinned baseline, install from the lockfile, then use the single proof wrapper:

```bash
npm ci
npm run prove:build
```

Notes:
- The committed `.npmrc` forces proof installs to include devDependencies even if the ambient environment sets production-leaning npm defaults.
- `npm ci` now runs a proof-install verification hook. If devDependencies or repo-local proof CLIs are omitted, install fails immediately instead of letting proof continue into a half-installed state.
- Proof-critical scripts now resolve `eslint`, `tsc`, `next`, `playwright`, and `start-server-and-test` directly from the repo's installed packages instead of depending on PATH or npm cache fallback behavior.
- `npm run prove:build` prefers the pinned baseline and warns when the runtime is only engine-compatible; it fails if Node/npm are outside the repo engine range.
- `npm run prove:build` now fails fast with an explicit install message if repo-local proof tooling such as `eslint`, `typescript`, `next`, Playwright, or `start-server-and-test` is missing after install.
- Before lint starts, the wrapper also verifies that repo-local CLI entrypoints such as `eslint`, `next`, `tsc`, and `playwright` actually launch through `npm exec`, so partial installs fail immediately instead of surfacing later as `eslint: not found`.
- The wrapper removes any existing `.next` directory first so the proof always rebuilds from a clean production artifact state.
- If `.env.local` is missing, the wrapper prepares it from the committed `.env.example`.
- The wrapper now builds before running the Playwright-backed regression suite, and the test step is told to reuse that exact production artifact instead of silently rebuilding.
- The Playwright-backed regression step now provisions the repo-local Chromium runtime itself, so a fresh checkout does not depend on a reviewer already having Playwright browsers installed.
- The proof and readiness wrappers serialize through a shared repo lock, so concurrent proof invocations wait instead of racing on `.next`, local servers, or proof artifacts.
- Real production secrets are not required for the proof sequence.
- `production-readiness` and `release:gate` already degrade safely when real deployment infrastructure is not configured.
- The proof wrappers now end with an explicit pass/fail step summary so reviewers can see which exact proof stage failed.
- Long-running proof phases emit periodic "still running" progress logs and terminate with explicit timeout errors if they exceed the proof budget, so a stuck `next build` does not look like a silent hang.

## Docker Proof Path

The isolated container proof is intentionally the same contract, just run inside the pinned Linux baseline with Playwright Linux dependencies enabled:

```bash
docker build --no-cache -f Dockerfile.proof -t cyang-doclinks-proof .
```

What Docker adds, and only why:
- `Dockerfile.proof` uses the pinned baseline image `node:22.16.0-bookworm`.
- It sets `PROOF_PLAYWRIGHT_INSTALL_WITH_DEPS=1` so the same repo proof wrapper installs Chromium together with the Linux OS packages Playwright needs in a clean container.
- It still runs the exact same top-level repo contract: `npm ci` followed by `npm run prove:build`.

## Exact Wrapped Sequence

`npm run prove:build` runs these checks in order:

```bash
npm run lint
npm run typecheck
npm run build
npm test -- --runInBand --require-existing-build
npm run audit:bundle-budgets
node scripts/production-readiness.mjs --skip-lint --skip-typecheck --skip-build --skip-bundle-budgets
```

If you want to inspect the wrapper step-by-step, this is the same sequence after `npm ci`.

What each command verifies:
- `npm ci`
  - lockfile fidelity and reproducible dependency install, including proof-required devDependencies
- `npm run lint`
  - static linting and repo guardrails
- `npm run typecheck`
  - Next-aware TypeScript correctness, including repo-local `next typegen` when route validators have not been generated yet in a clean checkout
- `npm run build`
  - Next.js production build correctness
- `npm test -- --runInBand --require-existing-build`
  - Playwright-based regression coverage against the exact production artifact built earlier in the proof flow, failing clearly if the required `.next` manifests are absent
  - repo-local Playwright Chromium runtime provisioning before the suite starts, so the proof does not rely on a pre-warmed browser cache
- `npm run audit:bundle-budgets`
  - route-level client bundle budget checks
- `node scripts/production-readiness.mjs --skip-lint --skip-typecheck --skip-build --skip-bundle-budgets`
  - env-template audit, migration manifest verification, route-handler/polling/render audits, dependency audit, and release gate checks

Why not raw `tsc --noEmit -p tsconfig.json` here:
- This App Router repo relies on Next-generated route validator types under `.next/types`.
- `npm run typecheck` is the truthful repo-safe proof command because it generates those files when they are missing, then runs repo-local `tsc`.
- If you want to run raw `tsc` manually, run `npm exec --no -- next typegen` first in the same checkout.

## Windows Sandbox Note

If you run the proof or Playwright wrapper inside a restricted Windows sandbox, you may hit `spawn EPERM` before app code runs.
That is an environment/process-permission limitation, not a repository build failure.
The proof and test wrappers now surface that case explicitly so reviewers know to rerun outside the restricted sandbox.

## Known Non-Blocking Caveats

- `.env.example` intentionally keeps a small explicit set of documented extra keys. See `docs/environment-ownership.md` and `scripts/lib/env-example-manifest.mjs`.
- `production-readiness` skips live migration-status validation when `DATABASE_URL` is not configured with a real database. Migration manifest verification still runs and must pass.
- The proof path validates build, type safety, tests, and repo guardrails. It does not claim live third-party integrations are reachable with placeholder secrets.
- The Docker proof validates the same contract inside the pinned Linux baseline, but it still does not claim live third-party integrations are reachable.

## Real Infrastructure Boundaries

The following integrations are intentionally not required for proof runs:
- Postgres
- Cloudflare R2
- Resend / SMTP
- Stripe live services
- malware scanner endpoints

Those integrations are still validated structurally by config, routing, and guardrail checks. Real credentials are only required for deployment or live integration testing, not for external build proof.

## Environment Ownership

For a reviewer-friendly explanation of which env vars are required for proof, local dev, and real deploys, see:

- `docs/environment-ownership.md`
