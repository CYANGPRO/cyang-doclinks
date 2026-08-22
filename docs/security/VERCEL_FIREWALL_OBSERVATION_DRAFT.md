# CAT Vercel Firewall Observation Draft

Status on 2026-08-22: seven CAT-project rules are staged as provider drafts with the over-threshold action set to **log**. They are not published and do not enforce or return 429. Production publication requires owner-approved change control after observation and Preview testing.

| Risk class | Method/path scope | Observation threshold | Counter |
| --- | --- | --- | --- |
| Authentication | `POST /api/auth/*` | 60 requests / 5 minutes | IP |
| Document upload | `POST /api/documents/upload` | 30 / 10 minutes | IP |
| Import mutation/execution | `POST`, `PUT`, `DELETE` under `/api/imports/*` | 120 / 10 minutes | IP |
| Protected download | `GET /api/documents/*/download` and import error CSV | 300 / 5 minutes | IP |
| Directory/report reads | `GET /directory*` and `/reports*` | 600 / 5 minutes | IP |
| Report generation | `POST /reports*` | 60 / 5 minutes | IP |
| High-risk administration | `POST`, `PATCH`, `PUT`, `DELETE` under Team, Campaign, CAT Action and Outreach APIs | 180 / 5 minutes | IP |

These are generous observation thresholds, not approved business quotas. Vercel counters may be regional and IP-based; they do not provide a strict global per-user or per-organization quota. The application PostgreSQL limiter remains the authoritative authenticated identity limiter for covered routes.

## Required rollout

1. **Log only:** leave the draft unpublished. Review at least one representative normal-traffic period and synthetic bursts in Preview. Record counts, NAT/shared-IP behavior, automation traffic and proposed adjustments without retaining raw member payloads.
2. **Preview enforcement:** after approval, create or scope equivalent rules to Preview first and change the exceeded action to deny. Verify the response is HTTP 429, legitimate requests recover after the window, and authentication/error pages remain usable. Test shared-office/mobile NAT and approved automation to identify false positives.
3. **Production enforcement:** require an approved change record, rollback owner and captured pre-change diff. Publish only the exact reviewed rules. Monitor 429 rate and user reports during the approved observation window; revert the specific rules if false positives cross the approved threshold.

The Vercel console path is **Project -> Firewall -> Configure -> Firewall Rules**. Before any publish, export or screenshot the draft diff, exact environment scope, method/path expressions, counter, threshold, action and rollback procedure. Never paste provider IDs, account IDs or secret values into repository evidence.
