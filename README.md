# cyang DocLinks

Secure document sharing for teams that need more than a public file link.

[Live product](https://www.cyang.io) · [Trust Center](https://www.cyang.io/trust) · [Status](https://www.cyang.io/status) · [Security disclosure](https://www.cyang.io/security-disclosure) · [Contact](https://www.cyang.io/contact)

## What It Is

DocLinks is cyang.io's controlled document delivery product. It lets teams share documents through short links, while keeping access policy, serving behavior, and auditability enforced on every request.

This repo is the public codebase behind that product direction. It reflects a security-first sharing system, not a generic file-hosting demo.

## Why It Exists

Most document sharing tools make distribution easy, then give you very little control once the link leaves your hands.

DocLinks exists for teams that need to:
- share sensitive documents without turning them into public files
- revoke or expire access after a link is sent
- apply view limits, password gates, and download controls
- keep an operational trail of what happened and when
- run a product that feels professional to the recipient and disciplined to the operator

## Key Capabilities

What is implemented in this repo today:
- Server-enforced share links under `/s/[token]`, not trust-the-URL delivery
- Document access gates for expiration, max views, password protection, recipient checks, and policy state
- Ticketed document serving paths for tighter delivery control
- Encrypted document handling and private object storage flows
- Malware, moderation, quarantine, and risky-state blocking before public delivery
- Admin and owner workflows for uploads, revocation, audit review, abuse handling, and security controls
- Viewer-specific dashboard and document experience with reduced scope
- Stripe-backed billing and plan-enforcement hooks
- Health, status, backup, retention, and release-readiness validation paths

## Security and Trust

DocLinks is designed around server-side enforcement, not “best effort” client behavior.

The repo currently shows a real production-minded posture:
- authenticated admin and owner surfaces
- role and permission boundaries
- private object storage by default
- request-time share and alias policy enforcement
- abuse throttling and rate limiting on sensitive routes
- immutable audit logging and structured security telemetry
- malware and moderation-aware delivery decisions
- release-gate, migration, backup, and production-readiness checks

Important: this repo does not claim compliance programs or certifications that are not documented here. The trust posture is grounded in the actual code and operational docs in this repository.

## Who It Is For

DocLinks is a fit for teams that share documents where control matters after send:
- startups and SaaS teams sharing customer-facing documents
- operations and finance teams distributing sensitive PDFs
- legal, procurement, and vendor-review workflows
- security-conscious product teams that need revocation, auditability, and delivery controls

## Product Experience

The public product experience in this repo is built around:
- clean, short share links
- guarded document delivery instead of open blob URLs
- trust surfaces such as status, legal, procurement, and security disclosure pages
- separate operator and viewer experiences rather than a single overloaded admin UI

No screenshots are included here because this repo does not ship a maintained public asset set for README visuals today. It is better to omit them than fake them.

## Live Links

- Product: https://www.cyang.io
- Trust Center: https://www.cyang.io/trust
- Procurement / Trust Package: https://www.cyang.io/trust/procurement
- Status: https://www.cyang.io/status
- Security Disclosure: https://www.cyang.io/security-disclosure
- Abuse Reporting: https://www.cyang.io/report
- Contact: https://www.cyang.io/contact

## Developer Quick Start

### Prerequisites

- Proof baseline: Node.js `22.19.0`
- Proof baseline: npm `10.9.2`
- Supported range: Node.js `>=22.19.0 <25`, npm `>=10.9.2 <12`
- copyable proof/local environment from `.env.example`

Preferred local pins are included in:
- `.nvmrc`
- `.node-version`
- `package.json` engines / packageManager

Windows convenience path:

```bash
npm run setup:proof:windows
```

That helper checks the current runtime and, if available, uses Volta or nvm-windows to switch to the pinned proof baseline before you run the full proof path.

### Local development

```bash
cp .env.example .env.local
npm ci
npm run dev
```

Open `http://localhost:3000`.

### Environment setup

Use `.env.example` as the starting point for both local work and clean proof runs. The template uses safe placeholder values so reviewers do not need production secrets just to validate the repo.

The repo includes env and release validation so missing or unsafe settings are caught early:

```bash
npm run audit:env-example
npm run release:gate
```

Environment ownership notes:
- proof/local/deploy expectations are documented in [docs/environment-ownership.md](docs/environment-ownership.md)
- `audit:env-example` now fails on missing referenced keys and on undocumented extras
- intentionally extra keys are tracked in `scripts/lib/env-example-manifest.mjs`, not hidden in a generic bucket

### Core commands

```bash
npm run lint
npm run typecheck
npm test -- --runInBand
npm run build
npm run audit:bundle-budgets
npm run production-readiness
```

### Release proof sequence

For an external proof run from a clean checkout:

```bash
cp .env.example .env.local
npm ci
npx playwright install --with-deps chromium
npm run lint
npm run typecheck
npm test -- --runInBand
npm run build
npm run audit:bundle-budgets
npm run production-readiness
```

If you want the repo to run the post-install proof steps for you:

```bash
npm run prove:build
```

On Windows, if `prove:build` fails fast because Node/npm do not match the pinned baseline, run:

```bash
npm run setup:proof:windows
```

If Volta is installed but your current shell has not refreshed PATH yet, you can invoke the proof command through the installed binary directly:

```powershell
& "C:\Program Files\Volta\volta.exe" run --node 22.19.0 --npm 10.9.2 npm run prove:build
```

See [PROVE_BUILD.md](PROVE_BUILD.md) for the command-by-command proof rationale.

`npm run typecheck` is the canonical proof command for this repo because Next App Router route validators are generated into `.next/types` on demand in a clean checkout.

## Quality and Operations

This repo includes production-minded validation and operational checks, including:
- lint and typecheck
- Playwright coverage for security, attack-simulation, accessibility, and guardrail behavior
- ordered migration manifest verification
- release-gate config validation
- bundle-budget audit
- backup / restore verification support
- staging fire-drill scripts

Useful commands:

```bash
npm run production-readiness
npm run release:gate
npm run db:migrations:verify
npm run fire-drill:staging
```

`npm run production-readiness` now ends with an explicit summary that separates repo/build proof from live runtime proof when deployment env vars are absent.

## Reproducible Build and Test Paths

This repo does not commit `node_modules` or `.next`. Reproducibility comes from the lockfile, pinned runtime metadata, and CI/local proof validation.

## Project Status

This is an actively hardened public repo for a serious secure-sharing product, not a one-page prototype.

Current maturity:
- security-focused beta / production-hardening stage
- strong route, serve-path, and trust-surface discipline
- operational tooling for migrations, release gates, retention, backups, and incident response
- continued polish on UX, trust presentation, and operator workflows

## Support and Disclosure

- Product/support questions: [support@cyang.io](mailto:support@cyang.io)
- Security disclosures: [security@cyang.io](mailto:security@cyang.io)
- Privacy and legal questions: [privacy@cyang.io](mailto:privacy@cyang.io), [legal@cyang.io](mailto:legal@cyang.io)

Additional public references:
- [SECURITY.md](SECURITY.md)
- [SUPPORT.md](SUPPORT.md)
- [Repository participation policy](CONTRIBUTING.md)
- [Security Policy](docs/SECURITY_POLICY.md)
- [Subprocessors](docs/SUBPROCESSORS.md)
- [Production readiness](docs/production-readiness.md)

## License

Licensed under the existing Cyang.io Proprietary License in `LICENSE`.

This public repository is source-available for evaluation, trust review, and issue reporting. Public code contributions are not accepted unless Cyang.io authorizes them in writing.

The license file in this repository is intentionally left unchanged.
