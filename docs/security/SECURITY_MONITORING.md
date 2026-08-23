# CAT Security Monitoring

## Detectable events

| Signal | Source | Expected response |
| --- | --- | --- |
| Repeated unauthenticated/forbidden requests | CAT safe security logs + Vercel request logs | Investigate source/path/rate; apply rate limit/block if abusive |
| OIDC/MFA failures, recovery or admin changes | Identity provider | Verify user/admin activity; revoke identity and CAT sessions if suspicious |
| Role, account activation or session revocation | CAT durable audit | Confirm approved lifecycle action |
| Imports, protected document access/deletion, reports/exports | CAT durable audit | Review unusual volume, timing, actor or target pattern |
| Malware verdict/failure | CAT/scanner logs | Keep upload fail-closed; investigate malicious file or scanner outage |
| Application errors/integrity failures | Vercel runtime + CAT safe diagnostics | Triage attack, corruption, configuration or deployment regression |
| Dependency/code/secret finding | GitHub Dependabot, CodeQL, secret scanning | Follow vulnerability/incident process |
| Backup failure or missing run | GitHub Actions | Restore backup service promptly; evaluate recovery exposure |
| Database/storage/provider admin anomaly | Neon/Cloudflare provider logs where available | Validate change and contain affected credential/service |

## Current provider state and operating runbook

The 2026-08-22 authenticated inspection found zero Vercel Log Drains. The existing CAT-only Sentry project `local801-cat-production` is the configured application-error destination: it contains only redacted Production events, and its enabled high-priority email rule records two successful triggers. CAT runtime initialization now removes request, user, context, breadcrumb, local-variable, and original-message data, disables tracing, and requires both `LOCAL801_SENTRY_ENABLED=1` and the separate CAT DSN. Vercel runtime/build/firewall logs and GitHub workflow failures remain on their native provider surfaces because no approved multi-source drain endpoint exists.

### Optional future Vercel Log Drain

After approval, use **Vercel team -> Settings -> Drains -> Add Drain** (or **CAT project -> Settings -> Log Drains**, if shown by the current console). Select only the CAT project and Production. Include runtime logs, build logs and firewall logs; exclude request bodies and any source that cannot be filtered to CAT. Use HTTPS with a destination-owned authentication secret and, where supported, delivery signature verification. The receiver must verify the signature over the raw request body before parsing, reject replays outside its approved window and retain only allowlisted metadata.

Required destination fields are: approved HTTPS endpoint, authentication/signature method, responsible operations owner, data region, retention/access policy, incident escalation route and deletion procedure. Do not configure a destination until those inputs and provider terms are approved.

Alert conditions:

- Immediate: any `integrity.failure`, `rate_limit.failure`, repeated backup failure/missing daily run, or secret-scanning alert.
- High: scanner outage that blocks uploads, an unapproved `administrative_change`, protected-access volume outside the approved baseline, or repeated identity-provider MFA/recovery failures.
- Investigate: 10 authorization denials for one metadata-only actor/organization within 15 minutes; firewall observation threshold exceeded repeatedly; new Production deployment error or rollback.

Delivery acceptance uses synthetic events only: emit one allowlisted security event in Preview, one intentional workflow failure against a disposable target, and one firewall observation burst. Verify receiver timestamp, CAT project/environment labels, severity/routing, alert acknowledgement, replay rejection and absence of PII, filenames, object keys, request bodies, tokens, cookies and raw IPs. Retain screenshots/event identifiers, not payload content.

### Daily review

1. Vercel dashboard -> CAT project `cyang-cat-data` -> Logs: select Production and the previous 24 hours. Search `[local801-security]`, `authorization.denied`, `rate_limit.denied`, `rate_limit.failure`, `scanner.failure`, `integrity.failure`, `protected_access`, `administrative_change`, and `backup.failure`. Escalate using the conditions above.
2. GitHub repository -> Actions: filter the CAT CI, CAT CodeQL, `backup-local801-neon-to-r2`, and `local801-r2-recovery` workflows. Any failed/cancelled backup or missing scheduled daily run is launch/real-data blocking until corrected and a successful run is retained.
3. CAT admin -> Audit Activity: review protected downloads, exports/imports, role/account changes, and configuration changes. Escalate an unapproved administrative change, unusual bulk access, or an actor accessing protected objects outside the approved purpose.
4. Vercel CAT project -> Deployments: verify the production deployment is the approved commit and inspect failed/rolled-back deployments. Do not change or promote a deployment during review without separate authorization.

### Weekly review

1. GitHub repository -> Security: review Dependabot alerts and CAT CodeQL results; repository -> Pull requests/Rules verify the exact CAT required checks remain enforced where the current plan supports them.
2. Neon console -> CAT-only project -> Monitoring/Branches/Operations: review compute/database errors, branch/role changes, storage growth and history availability. Do not inspect any non-CAT project.
3. Cloudflare dashboard -> R2 -> CAT application and recovery buckets -> Metrics/Settings: review request/error volume, public-access state and token inventory. Confirm `r2.dev` and custom-domain public access remain disabled.
4. Identity-provider CAT client -> sign-in/security logs: review MFA failures, disabled-account attempts, recovery/admin changes and shared-account indicators.
5. Record reviewer, UTC time window, dashboards visited, queries/events, findings, ticket/change reference and screenshots or exported secret-free results in the private operations record.

### Synthetic visibility tests

- Rate limiting has two accepted layers: a signed-in Preview firewall burst returned Vercel 429 with `x-vercel-mitigated: deny` after five requests (Vercel does not add `Retry-After`), while Production database run `32645413253` verified atomic allow/deny and exact cleanup through scoped roles. CAT response tests separately confirm HTTP 429, safe `Retry-After`, no-store caching, hashed subject state, and fail-closed 503 behavior. Repeat the authenticated HTTP response and safe-signal check during final launch smoke testing.
- Attempt one unauthorized synthetic API request and confirm a 401/403 plus metadata-only denial signal.
- Use scanner test fixtures for clean, infected and outage responses; confirm infected/outage uploads fail closed and emit only the safe code.
- Tamper with a disposable synthetic encrypted object, confirm retrieval fails closed, and confirm the integrity signal contains no object key, filename, content or PII.
- Manually dispatch the CAT backup workflow only against an approved disposable target to verify success visibility; test failure notification without exposing a connection string or secret.
- After an approved drain exists, replay the three synthetic delivery cases above and confirm routing, acknowledgement and sensitive-field filtering before calling monitoring configured.

Keep screenshots/exports only for the approved retention period. Never retain member data, narratives, request bodies, tokens, cookies, raw IPs, URLs containing credentials or secret values in monitoring evidence. Provider host/network detection remains provider responsibility; missing provider visibility stays an explicit residual risk.
