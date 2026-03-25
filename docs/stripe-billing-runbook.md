# Stripe Billing Runbook

## Purpose
Enable paid plan enforcement with signed Stripe webhooks and deterministic plan state transitions.

## Database Prerequisites
Run:

```sql
scripts/sql/monetization.sql
scripts/sql/stripe_billing.sql
scripts/sql/stripe_billing_event_order.sql
scripts/sql/stripe_event_log.sql
```

## Required Environment Variables
1. `STRIPE_SECRET_KEY`
2. `STRIPE_WEBHOOK_SECRET`
3. `STRIPE_PRO_PRICE_IDS` (comma-separated, first value is default checkout price)

Optional:
1. `STRIPE_GRACE_DAYS` (default `7`)
2. `STRIPE_WEBHOOK_TOLERANCE_SECONDS` (default `300`)
3. `STRIPE_ENFORCE_ENTITLEMENT` (`1` default, set `0` only for controlled testing)
4. `RATE_LIMIT_STRIPE_WEBHOOK_IP_PER_MIN` (default `300`)

## Endpoints
1. Owner checkout: `POST /api/admin/billing/checkout`
2. Customer portal: `POST /api/admin/billing/portal`
3. Stripe webhook: `POST /api/stripe/webhook`
4. Billing maintenance sync: `GET /api/cron/billing-sync`
5. Manual billing maintenance run: `POST /api/admin/billing/sync`
6. Billing status snapshot: `GET /api/admin/billing/status`
7. Invoice history API: `GET /api/admin/billing/invoices`

## Webhook Events Handled
1. `customer.subscription.created`
2. `customer.subscription.updated`
3. `customer.subscription.deleted`
4. `invoice.payment_failed`
5. `invoice.payment_succeeded`

## Enforcement Notes
1. User `plan_id='pro'` is treated as Free unless active Stripe entitlement is present.
2. `past_due` enters grace window (`grace_until`).
3. Expired grace or canceled subscription downgrades user to Free.
4. Free plan cannot create unlimited share links.
5. Free plan cannot export audit logs.

## Validation Checklist
1. Trigger checkout from `/admin/billing` and confirm redirect to Stripe Checkout.
2. Complete payment in Stripe test mode and verify webhook updates `billing_subscriptions`.
3. Confirm `users.plan_id` becomes `pro`.
4. Simulate `invoice.payment_failed`; confirm `past_due` + `grace_until`.
5. Simulate cancellation or grace expiry; confirm downgrade to `free`.
6. Trigger `/api/cron/billing-sync` (via Cloudflare cron) and verify stale past-due users are downgraded.
7. Open `/admin/billing/stripe` and verify debug card reports:
   - `billing_webhook_events` present
   - `stripe_event_log` present
   - processed/duplicate counts are non-zero after test replay

## Deployed Smoke Proof

The repo now includes a live runtime proof command:

```bash
npm run runtime:proof:live
```

For Stripe, it does not call `/api/stripe/webhook` directly. It:

1. creates a real Stripe test-mode customer
2. attaches `pm_card_visa`
3. creates a subscription on the configured price
4. updates the subscription
5. cancels the subscription
6. waits for the deployed app to record `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`
7. verifies `billing_subscriptions`, `billing_webhook_events`, and `stripe_event_log` reflect those deliveries

Safety guard:

- The command refuses to run with `sk_live_...` unless `LIVE_RUNTIME_STRIPE_ALLOW_LIVE=1` is set intentionally.

## Webhook Hardening Expectations
1. Signature must validate for every webhook request.
2. Duplicate event IDs must be ignored without double-applying plan changes.
3. Out-of-order events must not regress subscription state.
4. Inactive subscriptions must be downgraded on maintenance runs.
