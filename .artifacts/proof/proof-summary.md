# Build Proof Summary

- Status: PASSED
- Timestamp: 2026-03-26T17:28:28.531Z
- Command: `npm run prove:build`
- Docker proof run: no
- Commit: 891d6b488e0e2749993728bde5c713975b943692
- Runtime: Node 24.13.0, npm 11.6.2
- Platform: win32/x64

## Preflight

- Install verification: PASSED (1.5s)
- Proof preflight: PASSED (1.3s)

## Phases

- Lint: PASSED (17s)
- Typecheck: PASSED (4.9s)
- Production build: PASSED (25s)
- Regression tests: PASSED (36s)
- Bundle budget audit: PASSED (388ms)
- Production readiness: PASSED (3.8s)

## Artifacts

- JSON report: `.artifacts\proof\proof-report.json`
- Human summary: `.artifacts\proof\proof-summary.md`
- Full log: `.artifacts\proof\prove-build.log`

## Not Proven Here

- live Postgres connectivity
- Cloudflare R2 connectivity
- Stripe delivery from the live service
- email provider delivery
- malware scanning endpoints
- deployed-secret wiring
