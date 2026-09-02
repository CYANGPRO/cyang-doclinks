# Incident Response Runbook

Last updated: February 27, 2026

## Scope
- Global platform incidents (serve abuse, active exploit, key compromise).
- Tenant-scoped incidents (single org compromise or abuse).
- Share-scoped incidents (single token/alias abuse).

## Severity Levels
1. `SEV-1` Critical
- Active compromise or ongoing data exposure.
- Immediate kill-switch action required.

2. `SEV-2` High
- Confirmed security control failure without broad compromise yet.
- Freeze affected tenant/share and investigate within same day.

3. `SEV-3` Medium
- Suspicious behavior with limited impact.
- Contain, monitor, and remediate with standard SLA.

## Kill-Switch Controls
1. Global freeze
- Set `SECURITY_GLOBAL_SERVE_DISABLE=1`.
- Effect: all serve paths are blocked.

2. Share-path freeze
- Set `SECURITY_SHARE_SERVE_DISABLE=1`.
- Effect: `/s/[token]` and token-based serving blocked.

3. Alias-path freeze
- Set `SECURITY_ALIAS_SERVE_DISABLE=1`.
- Effect: `/d/[alias]` and alias-based serving blocked.

4. Ticket-path freeze
- Set `SECURITY_TICKET_SERVE_DISABLE=1`.
- Effect: short-lived ticket streaming blocked.

## Tenant Emergency Freeze
1. In admin security, disable org access for impacted org.
2. Confirm org is blocked across authz-protected paths.
3. Revoke active invites and rotate elevated memberships if needed.
4. Log incident action in immutable audit stream.

## Share Emergency Freeze
1. Revoke impacted token/alias immediately.
2. Disable document (`moderation_status=disabled` or quarantine as needed).
3. Verify:
- `/s/[token]` returns blocked state.
- `/d/[alias]` returns blocked state.
- raw/ticket routes do not serve content.
4. Record action with actor, reason, scope, and evidence reference.

## Emergency Revoke Flow Test (Quarterly)
1. Create a staging share token.
2. Open once to confirm valid access.
3. Revoke token.
4. Re-open and verify blocked response.
5. Export matching audit rows and store in test evidence.

## Required Audit Trail
- Every admin override, revoke, rollback, and org-access change must emit:
- immutable audit entry (`immutable_audit_log`)
- security telemetry event (`security_events`)
- actor identity, org scope, and timestamp

## Communication Checklist
1. Open incident channel and assign incident commander.
2. Classify severity (`SEV-1/2/3`).
3. Apply minimum-scope freeze first (share -> tenant -> global).
4. Preserve logs and database evidence.
5. Publish internal status updates every 30 minutes for `SEV-1`.

## Post-Incident
1. Root-cause analysis within 48 hours.
2. Add regression test for the bypass/failure mode.
3. Update this runbook and `ARCHITECTURE.md` if enforcement order changed.
4. Track remediation completion in security checklist.
