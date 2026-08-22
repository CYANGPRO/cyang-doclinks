# CAT Secure Configuration Baseline

Review annually and after material platform, framework, authentication, database, storage, or native-wrapper changes.

## Application baseline

| Area | Required baseline | Evidence/status |
| --- | --- | --- |
| Framework | Supported Node/Next/React versions locked; no production browser source maps | package/lockfile; `next.config.ts` |
| Headers | CSP, HSTS on production builds, `DENY`, `nosniff`, strict referrer, permissions restrictions, COOP/CORP, noindex | `next.config.ts`; CIS tests |
| CSP | Self-only defaults/connect, no objects/frames, self forms/base; inline script/style retained only for current Next hydration/styles | Implemented with documented residual risk; test before tightening |
| Caching | Authenticated/application responses no-store; service worker caches only generic offline/static assets | config, route tests, `public/sw.js` |
| Cookies | Host-only (no Domain), HttpOnly, SameSite=Lax, Secure in production; CAT-specific name | `auth-options.ts`, `authz.server.ts` |
| Sessions | OIDC JWT session revalidated against active user, exact role and `auth_session_version`; admin lifetime default 12 hours | auth/session source and tests |
| Mutation origin | Exact same-origin required for browser mutations; NextAuth state/PKCE checks | request helper, mutation helpers, tests |
| Errors/logs | Generic public failures; secret-safe diagnostics; no protected narratives in audit/log payloads | route/service tests |
| Database | `LOCAL801_DATABASE_URL` only, separate target, TLS mode required in production, parameterized queries | config/launch policy/db tests |
| Object storage | Private R2 endpoint/bucket, CAT-only credentials, no public/presigned object access, encrypted objects | config/R2/storage tests |
| Uploads | Allowlisted extension+MIME, bounded length and stream, normalized filename, fail-closed malware scanner | upload/scanner/storage tests |
| Preview | Synthetic data only; preview auth never accepted in Vercel Production; Deployment Protection required | launch policy and operator verification |
| Debug | No public debug endpoints; readiness mutation is preview-only, same-origin, admin-only and externally protected | readiness route and security docs |

`script-src 'unsafe-inline'` and `style-src 'unsafe-inline'` are not treated as ideal controls. They remain because the current Next.js application uses inline framework/style content; removing them requires a nonce/hash design and full browser verification. `object-src 'none'`, `frame-ancestors 'none'`, output encoding, React escaping, no injected HTML paths, and input validation reduce but do not eliminate that residual risk.

## Provider baseline requiring console evidence

- Vercel: separate CAT project; production/preview secret separation; Deployment Protection for Preview; least-privilege members; canonical domain/TLS; firewall/rate limits; log alerting/drain; rollback access.
- Neon: separate CAT project/branches; least-privilege credentials; TLS URL; history retention/backups; restricted administrators; recovery target and quarterly restore test.
- Cloudflare R2: separate private CAT and recovery buckets; public `r2.dev` and custom-domain access disabled; bucket-scoped tokens; lifecycle/lock settings reviewed; separate backup credentials.
- GitHub: protected branches/rulesets; required CAT CI and CodeQL checks; Dependabot alerts/security updates; secret scanning/push protection where licensed; least-privilege collaborators and environments.
- Identity provider: invitation/provisioning-only access, MFA assurance claim, no shared accounts, admin audit logs, emergency recovery and rapid session/account revocation.
