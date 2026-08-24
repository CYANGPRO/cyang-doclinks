# Stage 21–22 readiness evidence

Status: code-side production readiness accepted in `preview` at merge commit `730eea5c5ed5bb791005dc43ba01eaceb23b1f4c` through PR #32. This document distinguishes completed repository evidence from environment or independent evidence that still requires owner/manual actions.

## Implemented in the candidate

- Production-capable protected workspace routes: the previously Preview-only document, campaign, CAT Action, new-hire, outreach, contact-correction, and data-quality mutations open in Vercel Production only when the full launch interlock and revalidated OIDC session are active.
- Protected durable CSV/XLSX processing: the legacy durable Preview switch remains prohibited in Production; a separate protected worker switch is required and remains coupled to protected-only database state and the complete launch interlock.
- Synthetic Production-origin pilot: a separate synthetic-data-only interlock permits Stage 23 identity/domain/device acceptance without enabling final launch or durable Production imports. Both pilot flags block final launch until turned off.
- Server-side rate limits: migration `0024` provides atomic per-organization/per-user buckets for search, import, export, download, and mutation scopes. Production fails closed if the limiter is unavailable.
- Storage accountability: document downloads now write a redacted durable read audit; upload/delete/import/report paths retain their existing audit/compensation behavior; `npm run storage:reconcile` compares private R2 keys with database metadata in read-only mode and reports missing/orphan/cleanup-pending counts without deleting anything.
- Readiness depth: the Production readiness command checks the environment-only launch policy, protected database state, migration `0024`, policy acknowledgements, and private bucket reachability while returning safe status codes only.
- Supply-chain gates: CI uses the Node 24 Vercel runtime and current official Node 24 GitHub actions, runs bounded XLSX scale, scans tracked files for high-confidence secrets, audits Production dependencies, and builds the application.

## Repository evidence completed on the merged SHA

- Local Node 24 release gate passed: lint, typecheck, 747 tests, 24-migration verification, 25K XLSX scale, tracked-secret scan, Route Handler security audit, zero Production dependency vulnerabilities, and the Production build.
- Android/iOS Capacitor sync completed without a source diff.
- Exact merged-head GitHub CI passed at `730eea5c5ed5bb791005dc43ba01eaceb23b1f4c`.
- Matching Vercel Preview deployment `dpl_9fPn2D6Sva7THPo8b9aJSn1TzbFm` reached READY with no error/fatal runtime logs during acceptance.
- Disposable Neon `local801_sql_test` acceptance passed on 2026-08-18 after positive database-name and non-primary-branch verification. The guarded reset applied migrations `0001`–`0024` and passed Stage 17 correction races, durable-job CAS, replay-safe 25K CSV processing, and real 20K service queries.

The completed disposable SQL suite cannot substitute for protected scanner/storage/workflow/browser recovery acceptance. Those remain manual environment evidence below.

## Production observability acceptance — 2026-08-19

- Main commit `9b327aa472710a602043bfa2101e75139b3d0733` deployed as Vercel Production deployment `dpl_AYVFwDEq7SH8F7d4T242LSkBfYCm` and reached `READY`.
- Vercel stored `LOCAL801_SENTRY_DSN` and `LOCAL801_SENTRY_ENABLED` as Sensitive, Production-only variables; no secret value was copied into repository evidence.
- Sentry project `local801-cat-production` had server-side data scrubbing, default scrubbers and prevention of IP-address storage enabled. Application policy additionally keeps tracing, default PII and breadcrumbs disabled and strips protected diagnostic fields before transmission.
- A PII-free synthetic event was accepted by Sentry and displayed as issue `LOCAL801-CAT-PRODUCTION-1` with title `Local801SentryAcceptance` and value `[redacted]`.
- The enabled email alert recorded one trigger for that issue, and Chang Yang confirmed recipient-side delivery on 2026-08-19.
- Vercel showed no error/fatal runtime logs for the accepted deployment. Public checks remained launch-disabled: `/` redirected to `/sign-in`, the provider response was `{}`, `/api/health` returned `404`, HSTS remained one year, and indexing remained prohibited.

This evidence accepts privacy-safe Production error ingestion and platform visibility only. It does not enable authentication, the synthetic pilot, real data, authoritative imports or the Production launch flag.

## Production recovery acceptance — 2026-08-19

- The protected Neon point-in-time recovery exercise restored the approved 9:55 a.m. CDT recovery point to disposable branch `br-mute-brook-aw4qc0q7` in 0.29 seconds. Validation completed in 58 seconds with an empty schema diff, 77 Local 801 tables, 24 reporting views, one protected System Owner, seven roles and zero member records; the disposable branch was deleted.
- Cloudflare R2 bucket `local801-engage-private` was confirmed in Eastern North America (`ENAM`) with public access disabled, the Public Development URL disabled, no custom domains and a bucket-scoped Object Read & Write token.
- The guarded live R2 drill used fixed synthetic plaintext and the application's authenticated encryption envelope. It verified ciphertext storage, matching key/format versions, authenticated download/decryption, SHA-256 and byte equality, deletion after the round trip, and post-delete absence. Safe results were `storageRecovery: ok`, `encryptedRoundTrip: ok`, and `cleanup: ok`; no key, credential, object key or protected data was recorded.
- Read-only reconciliation then matched 24 database metadata objects to 24 private bucket objects with zero missing objects, orphan objects, cleanup-pending records or duplicate metadata; `reconciled` was `true`.
- The corrected Production object-key keyring remained Sensitive and Production-only. Deployment `dpl_DSWHAtnYjMAjtXyUtZK8iDM9bbbJ` reached READY with no error logs, while `/` still redirected to sign-in, the provider response remained `{}`, `/api/health` remained hidden at `404`, HSTS remained one year and indexing remained prohibited.
- After both recovery exercises and reconciliation passed, `LOCAL801_BACKUP_RESTORE_VERIFIED` was set to `1`. This accepts only the backup/restore gate and does not enable authentication, the synthetic pilot, authoritative imports, real data or final launch.

## Production malware-scanner acceptance — 2026-08-19

- The owner-operated CAT adapter was installed separately from DocLinks as an unprivileged systemd service. It binds only to `127.0.0.1:8089`, reaches ClamAV through `/run/clamav/clamd.ctl`, keeps replay/rate state only in its private runtime directory, and does not retain request bytes, names, hashes or credentials.
- The existing Caddy `scan.cyang.io` configuration retained its TLS, method/path matcher and 20 MiB request limit; only the `POST /v1/scan` upstream was changed to the CAT adapter. Other handlers and upstreams remained unchanged, and Caddy validation passed before reload.
- A Node/V8 startup failure exposed that `MemoryDenyWriteExecute=true` is incompatible with the deployed Node 24 runtime. The service retained its other privilege, namespace, filesystem, capability, address-family and loopback restrictions while setting that directive to `false`; a repository regression test now fixes the compatible posture, and LF checkout rules prevent Windows deployment artifacts from restoring hidden CRLF characters.
- Production-only `LOCAL801_MALWARE_SCANNER_URL`, `LOCAL801_MALWARE_SCANNER_ENABLED`, client ID and HMAC secret were configured in Vercel without recording the secret. Redeployment `dpl_58FR7QPFmmjZXHD3n3czsNKpr1PF` reached READY and retained the `cat.cyang.io` alias.
- Guarded live acceptance used only fixed synthetic bytes and the standard in-memory antimalware test payload. The clean and infected paths returned `ok`; stopping the adapter produced the required `unavailablePath: ok`; after immediate restart, clean and infected both returned `ok` again. Every command exited `0`.

This evidence accepts the Production scanner resource and its fail-closed behavior only. Authentication, synthetic pilot, authoritative imports, real member data and final launch remain disabled.

## Evidence that cannot be produced by repository changes

- remaining dedicated Production Entra/browser-push resources and secret custody;
- DNS/TLS and real Entra MFA/Conditional Access acceptance;
- independent authorization, penetration, accessibility, privacy/vendor, and counsel reviews;
- post-launch native work (APNs/FCM, native gateways and Apple/Google signing/store acceptance) is deferred by the 2026-08-19 owner decision and is not web-launch evidence;
- named user training, three-day synthetic pilot, support/escalation rehearsal, and final owner approval.

The exact owner checklist is `docs/MANUAL_PRODUCTION_ACTIONS.md`; promotion and rollback order is `docs/PRODUCTION_MOVE_RUNBOOK.md`.
