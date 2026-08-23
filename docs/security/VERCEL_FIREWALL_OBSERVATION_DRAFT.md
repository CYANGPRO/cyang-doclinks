# CAT Vercel Firewall Observation Draft

Status on 2026-08-23: the seven CAT-project observation rules are published, live, valid, and remain **log** only. A separate live Preview enforcement rule, `CAT Preview enforce authentication POST`, limits `POST /api/auth*` to 5 requests per 60 seconds per IP and returns 429 after the threshold. A signed-in seven-request synthetic burst produced five application 404 responses followed by two Vercel 429 responses with `x-vercel-mitigated: deny`. There are no draft or pending firewall changes. Production enforcement still requires owner-approved change control and an adequate observation basis.

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

1. **Log only:** keep the seven published observation rules at `log`. Review representative normal-traffic periods and synthetic bursts. Record counts, NAT/shared-IP behavior, automation traffic and proposed adjustments without retaining raw member payloads.
2. **Preview enforcement:** keep the authentication rule Preview-scoped. Its 429 threshold is accepted; verify legitimate requests recover after the window and test shared-office/mobile NAT and approved automation before considering Production scope.
3. **Production enforcement:** require an approved change record, rollback owner and captured pre-change diff. Publish only the exact reviewed rules. Monitor 429 rate and user reports during the approved observation window; revert the specific rules if false positives cross the approved threshold.

The Vercel console path is **Project -> Firewall -> Configure -> Firewall Rules**. Before any publish, export or screenshot the draft diff, exact environment scope, method/path expressions, counter, threshold, action and rollback procedure. Never paste provider IDs, account IDs or secret values into repository evidence.
