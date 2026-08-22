# CAT Software Inventory

The authoritative CAT runtime inventory is derived from `apps/local801-engage/package.json`, `apps/local801-engage/package-lock.json`, and GitHub Actions workflow revisions. Root manifests remain relevant to repository-level automation, but they are not part of the CAT runtime dependency graph. Do not manually copy the full transitive dependency graph into this document.

## Automated inventory

- `npm --prefix apps/local801-engage run security:sbom` emits a CycloneDX JSON SBOM from the locked production dependency graph.
- CI generates and retains the SBOM as the `local801-engage-sbom` workflow artifact.
- `npm --prefix apps/local801-engage run security:audit` evaluates locked production dependencies and fails at high severity.
- Dependabot covers root npm, CAT npm, and GitHub Actions dependencies.

## Major authorized components

| Component | Purpose | Inventory/evidence source |
| --- | --- | --- |
| Node.js 22 | Build and server runtime | package `engines`, Volta, CI setup |
| Next.js 16 / React 19 | App Router web application | CAT manifest/lockfile |
| TypeScript / ESLint | Static checking and linting | CAT dev dependencies and CI |
| NextAuth | OIDC/JWT session handling | CAT manifest; `src/lib/auth-options.ts` |
| `postgres` and Neon serverless client | PostgreSQL access | CAT manifest; `src/lib/db.ts` |
| AWS S3 client | Private R2 object operations | CAT manifest; `src/lib/r2.ts` |
| `zod` | Configuration/input validation | CAT manifest/source |
| `jszip` | Bounded workbook/archive processing | CAT manifest/import tests |
| Workflow DevKit | Durable import workflow foundation | CAT manifest/workflow source; production switch gated |
| Capacitor runtime/tooling | Native wrapper for the existing CAT web app | CAT manifest and `android/` / `ios/`; no separate data backend |
| GitHub Actions | CI, CodeQL, SBOM, and backup automation | `.github/workflows/` |
| Shared malware scanner client | Upload malware verdicts | `src/lib/import-scanner.ts` |

## Authorization and review

Only manifest/lockfile software and provider-managed platform components are authorized. New runtime dependencies require review for maintenance status, provenance, license, permissions, data access, and whether an existing vetted component already provides the capability. Unsupported or unauthorized software is removed or isolated; exceptions require a risk-register entry and owner approval.
