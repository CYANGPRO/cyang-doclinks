# Repository Development Rules

## Existing DocLinks Application

- Keep the root cyang.io DocLinks application in place. Do not move `src/`, root `db/`, root Next config, billing code, public share routes, or production deployment settings as part of Local 801 work.
- Do not connect Local 801 Engage to DocLinks production database URLs, R2 buckets, auth secrets, encryption keys, Stripe settings, public link routes, or document records.
- Preserve root commands such as `npm run build`, `npm run typecheck`, `npm test`, `npm run release:gate`, and `npm run production-readiness`.
- Treat changes to shared security, auth, storage, encryption, audit, or upload helpers as high-risk. Reuse patterns first; extract shared code only after both apps need a stable generic interface.

## Local 801 Engage

- The Local 801 app lives in `apps/local801-engage` and deploys as a separate project rooted at that directory.
- Use separate Local 801 environment variables prefixed with `LOCAL801_` where possible.
- Keep authentication cookies application scoped. Do not set cookies for all `*.cyang.io` subdomains.
- Store real Local 801 sample files only in `local-sensitive-samples/`; never commit sample files, extracted member data, real names, contact info, screenshots with real records, or secrets.
- Use synthetic `example.test` data in development, tests, seeds, and docs.
- The service worker may cache only nonsensitive static assets and the generic offline page.
- Power BI integration remains disabled until owner-controlled Microsoft credentials exist.
