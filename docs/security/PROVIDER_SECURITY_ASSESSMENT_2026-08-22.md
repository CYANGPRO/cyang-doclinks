# CAT Provider Security Assessment — 2026-08-22

This is a secret-free provider inspection and closeout record, not production acceptance. Closeout changed only the CAT Vercel Git repository, Root Directory, Node major, and four fail-closed acceptance values. No credential value, data, domain/traffic routing, deployment alias, retention lock, or provider ownership was changed.

## GitHub

- Repository visibility is public. One administrator has repository access.
- No branch protection or repository ruleset is active. The latest observed successful CI workflow completed on 2026-07-17, but its security jobs were skipped; no successful CAT CodeQL result was available to require safely.
- Dependabot alerts and security updates, secret scanning and push protection were enabled and verified during this assessment. There were 29 open Dependabot alerts after enablement. No alerts were dismissed.
- Code-scanning results were unavailable. Do not require a CodeQL check until the exact CAT CodeQL workflow/check completes successfully on the release branch.
- A closeout recheck found 112 open repository-wide Dependabot alerts, but zero were attached to `apps/local801-engage/package-lock.json`; 97 belong to the root application and 15 to `cloudflare/`. CAT's production dependency audit remains clean. Repository rules still require the exact CAT checks to run successfully first.

## Vercel

- The CAT project responds at `https://cat.cyang.io` over TLS with HSTS. Generated/Preview deployments are protected while the custom production domain is excluded from deployment protection as intended.
- Closeout repair completed: the existing project now links to `CYANGPRO/cyang-doclinks`, Root Directory is `apps/local801-engage`, Production branch is `main`, and Vercel is configured for Node.js 22.x to match CAT CI. The existing aliases, 133 environment records, and current Production deployment were preserved; a new Git-triggered Preview remains required evidence.
- Provider inspection reports identical stored Production and Preview values for the database URL, R2 application storage credentials/bucket, object and PII keyrings, scanner HMAC credential and session secret. This fails the separation gate even though the variable records are environment-scoped separately. Do not rotate or replace them without owner-approved migration and recovery planning.
- Closeout repair set the launch, PII-protection acceptance, backup/restore acceptance and security-review acceptance variables explicitly to `0` in Production. Production remains fail-closed.
- No Log Drain is configured. One team owner was observed. Recent deployment history contains multiple ready Production deployments, so a rollback candidate exists, but rollback has not been exercised.
- Seven method/risk-separated firewall rules were staged as log-only drafts. No firewall rule was published.

## Neon

- CAT uses a Neon project distinct from the DocLinks project and PostgreSQL 18. The observed history window is seven days.
- The authenticated inspector has administrative permission. Public connections are not blocked and no verified IP allowlist was observed. Vercel dynamic egress compatibility must be decided before restricting network access.
- Metadata-only role inspection confirmed that Production currently has only the provider/owner login for CAT objects; separate application, migration and backup roles do not exist. A production-equivalent restore exercise also remains unverified.
- Production and Preview are distinct Neon branches, but three stale diagnostic/test branches derived from Production were also observed. Their deletion requires an explicit data-owner decision because they may contain production-derived records.

## Cloudflare R2 and identity provider

- The installed Cloudflare command-line client is not authenticated, so bucket privacy, public access, custom domains, lifecycle/lock state and token scope were not inspected live.
- No authenticated identity-provider administration method was available. Production client separation, exact callback, stable `sub`, verified email, MFA `amr`/`acr`, individual accounts and recovery access remain unverified.

Retain private provider screenshots/exports, change records and workflow/run references outside this public repository. They must omit secret values and member data.
