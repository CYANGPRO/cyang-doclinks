# Repository Development Rules

## DocLinks Application

- Keep the root cyang.io DocLinks application in place. Do not move `src/`, root `db/`, root Next config, billing code, public share routes, or production deployment settings into another product.
- Preserve root commands such as `npm run build`, `npm run typecheck`, `npm test`, `npm run release:gate`, and `npm run production-readiness`.
- Treat changes to shared security, auth, storage, encryption, audit, or upload helpers as high-risk. Reuse patterns first; extract shared code only after both apps need a stable generic interface.

## Repository Boundary

- The Local 801 CAT application belongs only in `CYANGPRO/cyang-cat-data`. Do not add CAT application code, native projects, workflows, documents, environment variables, data, or deployment configuration to this repository.
- Do not connect DocLinks to CAT databases, buckets, auth secrets, encryption keys, routes, or deployment settings.
