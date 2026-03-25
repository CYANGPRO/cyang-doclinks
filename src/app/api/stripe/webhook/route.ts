export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { verifyStripeWebhookSignature } from "@/lib/stripeWebhook";
import {
  beginWebhookEvent,
  billingTablesReady,
  completeWebhookEvent,
  getUserIdByStripeCustomerId,
  resolveUserIdForStripeWebhookEvent,
  markWebhookEventDuplicate,
  markPaymentFailure,
  markPaymentSucceeded,
  syncUserPlanFromSubscription,
  unixToIso,
  upsertStripeSubscription,
} from "@/lib/billingSubscription";
import { appendImmutableAudit } from "@/lib/immutableAudit";
import {
  clientIpKey,
  enforceGlobalApiRateLimit,
  enforceIpAbuseBlock,
  logDbErrorEvent,
  logSecurityEvent,
  maybeBlockIpOnAbuse,
} from "@/lib/securityTelemetry";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { assertRuntimeEnv, isRuntimeEnvError } from "@/lib/runtimeEnv";

const DEFAULT_STRIPE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export type StripeWebhookRouteDeps = {
  verifyStripeWebhookSignature: typeof verifyStripeWebhookSignature;
  beginWebhookEvent: typeof beginWebhookEvent;
  billingTablesReady: typeof billingTablesReady;
  completeWebhookEvent: typeof completeWebhookEvent;
  getUserIdByStripeCustomerId: typeof getUserIdByStripeCustomerId;
  resolveUserIdForStripeWebhookEvent: typeof resolveUserIdForStripeWebhookEvent;
  markWebhookEventDuplicate: typeof markWebhookEventDuplicate;
  markPaymentFailure: typeof markPaymentFailure;
  markPaymentSucceeded: typeof markPaymentSucceeded;
  syncUserPlanFromSubscription: typeof syncUserPlanFromSubscription;
  unixToIso: typeof unixToIso;
  upsertStripeSubscription: typeof upsertStripeSubscription;
  appendImmutableAudit: typeof appendImmutableAudit;
  clientIpKey: typeof clientIpKey;
  enforceGlobalApiRateLimit: typeof enforceGlobalApiRateLimit;
  enforceIpAbuseBlock: typeof enforceIpAbuseBlock;
  logDbErrorEvent: typeof logDbErrorEvent;
  logSecurityEvent: typeof logSecurityEvent;
  maybeBlockIpOnAbuse: typeof maybeBlockIpOnAbuse;
  getRouteTimeoutMs: typeof getRouteTimeoutMs;
  isRouteTimeoutError: typeof isRouteTimeoutError;
  withRouteTimeout: typeof withRouteTimeout;
  assertRuntimeEnv: typeof assertRuntimeEnv;
  isRuntimeEnvError: typeof isRuntimeEnvError;
};

const defaultStripeWebhookRouteDeps: StripeWebhookRouteDeps = {
  verifyStripeWebhookSignature,
  beginWebhookEvent,
  billingTablesReady,
  completeWebhookEvent,
  getUserIdByStripeCustomerId,
  resolveUserIdForStripeWebhookEvent,
  markWebhookEventDuplicate,
  markPaymentFailure,
  markPaymentSucceeded,
  syncUserPlanFromSubscription,
  unixToIso,
  upsertStripeSubscription,
  appendImmutableAudit,
  clientIpKey,
  enforceGlobalApiRateLimit,
  enforceIpAbuseBlock,
  logDbErrorEvent,
  logSecurityEvent,
  maybeBlockIpOnAbuse,
  getRouteTimeoutMs,
  isRouteTimeoutError,
  withRouteTimeout,
  assertRuntimeEnv,
  isRuntimeEnvError,
};

function planFromStripePriceId(priceId: string | null): "free" | "pro" {
  const proPrices = String(process.env.STRIPE_PRO_PRICE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (priceId && proPrices.includes(priceId)) return "pro";
  return "free";
}

function getSubPriceId(obj: unknown): string | null {
  try {
    const arr = (obj as { items?: { data?: Array<{ price?: { id?: unknown } }> } } | null | undefined)?.items?.data;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return String(arr[0]?.price?.id || "").trim() || null;
  } catch {
    return null;
  }
}

function getGraceDays(): number {
  const n = Number(process.env.STRIPE_GRACE_DAYS || 7);
  if (!Number.isFinite(n)) return 7;
  return Math.max(0, Math.floor(n));
}

function getMaxWebhookBodyBytes(): number {
  const raw = Number(process.env.STRIPE_WEBHOOK_MAX_BODY_BYTES || DEFAULT_STRIPE_WEBHOOK_MAX_BODY_BYTES);
  if (!Number.isFinite(raw)) return DEFAULT_STRIPE_WEBHOOK_MAX_BODY_BYTES;
  return Math.max(1024, Math.min(1024 * 1024, Math.floor(raw)));
}

function parseContentLength(headerValue: string | null): number | null {
  const n = Number(String(headerValue || "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function safeWebhookMessage(errorLike: unknown): string {
  const raw = errorLike instanceof Error ? errorLike.message : String(errorLike || "webhook_failed");
  const trimmed = raw.trim();
  if (!trimmed) return "webhook_failed";
  return trimmed.slice(0, 240);
}

export async function postStripeWebhookRoute(
  req: NextRequest,
  deps: StripeWebhookRouteDeps = defaultStripeWebhookRouteDeps
) {
  const timeoutMs = deps.getRouteTimeoutMs("ROUTE_TIMEOUT_STRIPE_WEBHOOK_MS", 15_000);
  const requestIp = deps.clientIpKey(req).ip;
  try {
    return await deps.withRouteTimeout(
      (async () => {
        const maxBodyBytes = getMaxWebhookBodyBytes();
        const contentLength = parseContentLength(req.headers.get("content-length"));
        if (contentLength != null && contentLength > maxBodyBytes) {
          await deps.logSecurityEvent({
            type: "stripe_webhook_payload_too_large",
            severity: "medium",
            ip: requestIp,
            scope: "billing_webhook",
            message: "Stripe webhook content-length exceeds max body size",
            meta: { contentLength, maxBodyBytes },
          });
          return NextResponse.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
        }

        deps.assertRuntimeEnv("stripe_webhook");
        const abuseBlock = await deps.enforceIpAbuseBlock({ req, scope: "billing_webhook" });
        if (!abuseBlock.ok) {
          return NextResponse.json(
            { ok: false, error: "ABUSE_BLOCKED" },
            { status: 403, headers: { "Retry-After": String(abuseBlock.retryAfterSeconds) } }
          );
        }
        const webhookRl = await deps.enforceGlobalApiRateLimit({
          req,
          scope: "ip:stripe_webhook",
          limit: Number(process.env.RATE_LIMIT_STRIPE_WEBHOOK_IP_PER_MIN || 300),
          windowSeconds: 60,
          strict: true,
        });
        if (!webhookRl.ok) {
          return NextResponse.json(
            { ok: false, error: "RATE_LIMIT" },
            { status: webhookRl.status, headers: { "Retry-After": String(webhookRl.retryAfterSeconds) } }
          );
        }

        const rawBody = await req.text();
        if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) {
          await deps.logSecurityEvent({
            type: "stripe_webhook_payload_too_large",
            severity: "medium",
            ip: requestIp,
            scope: "billing_webhook",
            message: "Stripe webhook body exceeds max body size",
            meta: { maxBodyBytes },
          });
          return NextResponse.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
        }

        const signature = req.headers.get("stripe-signature");
        const verified = deps.verifyStripeWebhookSignature({
          rawBody,
          signatureHeader: signature,
          secret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
          toleranceSeconds: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || 300),
        });

        if (!verified.ok) {
          await deps.logSecurityEvent({
            type: "stripe_webhook_invalid_signature",
            severity: "high",
            ip: requestIp,
            scope: "billing_webhook",
            message: verified.error,
          });
          if (requestIp) {
            await deps.maybeBlockIpOnAbuse({
              ip: requestIp,
              category: "stripe_webhook_invalid_signature",
              scope: "billing_webhook",
              threshold: Number(process.env.ABUSE_BLOCK_STRIPE_SIG_THRESHOLD || 15),
              windowSeconds: Number(process.env.ABUSE_BLOCK_STRIPE_SIG_WINDOW_SECONDS || 600),
              blockSeconds: Number(process.env.ABUSE_BLOCK_TTL_SECONDS || 3600),
              reason: "Repeated invalid Stripe webhook signatures",
            });
          }
          return NextResponse.json({ ok: false, error: "INVALID_SIGNATURE" }, { status: 400 });
        }

        const ready = await deps.billingTablesReady();
        if (!ready) {
          return NextResponse.json({ ok: false, error: "BILLING_TABLES_NOT_READY" }, { status: 503 });
        }

        const dedupe = await deps.beginWebhookEvent(verified.eventId, verified.eventType, verified.payload);
        if (dedupe === "duplicate") {
          await deps.markWebhookEventDuplicate(verified.eventId);
          return NextResponse.json({ ok: true, duplicate: true });
        }

        const event = verified.payload;
        const eventObj = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        const eventData = (eventObj.data && typeof eventObj.data === "object" ? eventObj.data : {}) as Record<string, unknown>;
        const obj = (eventData.object && typeof eventData.object === "object" ? eventData.object : {}) as Record<string, unknown>;
        const eventType = verified.eventType;
        const eventCreatedUnix = Number.isFinite(Number(eventObj.created))
          ? Math.max(0, Math.floor(Number(eventObj.created)))
          : null;

        let webhookStatus: "processed" | "ignored" | "failed" = "processed";
        let webhookMessage: string | null = null;

        try {
          if (
            eventType === "customer.subscription.created" ||
            eventType === "customer.subscription.updated" ||
            eventType === "customer.subscription.deleted"
          ) {
            const stripeSubscriptionId = String(obj?.id || "").trim();
            const stripeCustomerId = String(obj?.customer || "").trim() || null;
            const metadata = (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {}) as Record<string, unknown>;
            const metadataUserId = String(metadata.user_id || "").trim() || null;
            const binding = await deps.resolveUserIdForStripeWebhookEvent({
              stripeSubscriptionId,
              stripeCustomerId,
              metadataUserId,
            });
            if (!binding.ok) {
              webhookStatus = "ignored";
              webhookMessage = binding.error;
              await deps.logSecurityEvent({
                type: "stripe_webhook_binding_rejected",
                severity: "high",
                ip: requestIp,
                scope: "billing_webhook",
                message: binding.error,
                meta: { eventType, eventId: verified.eventId, stripeSubscriptionId, stripeCustomerId },
              });
            } else {
              const userId = binding.userId;

              const status = String(obj?.status || (eventType.endsWith(".deleted") ? "canceled" : "incomplete")).toLowerCase();
              const planId = planFromStripePriceId(getSubPriceId(obj));
              const currentPeriodEnd = deps.unixToIso(obj?.current_period_end);
              const cancelAtPeriodEnd = Boolean(obj?.cancel_at_period_end);

              await deps.upsertStripeSubscription({
                userId,
                stripeCustomerId,
                stripeSubscriptionId,
                status,
                planId,
                currentPeriodEnd,
                cancelAtPeriodEnd,
                graceUntil: null,
                eventCreatedUnix,
              });

              if (userId) {
                await deps.syncUserPlanFromSubscription(userId);
              }
            }
          } else if (eventType === "invoice.payment_failed") {
            const stripeSubscriptionId = String(obj?.subscription || "").trim() || null;
            const stripeCustomerId = String(obj?.customer || "").trim() || null;
            const userId = await deps.getUserIdByStripeCustomerId(stripeCustomerId);
            await deps.markPaymentFailure({
              stripeSubscriptionId,
              stripeCustomerId,
              graceDays: getGraceDays(),
              eventCreatedUnix,
            });
            if (userId) await deps.syncUserPlanFromSubscription(userId);
          } else if (eventType === "invoice.payment_succeeded") {
            const stripeSubscriptionId = String(obj?.subscription || "").trim() || null;
            const stripeCustomerId = String(obj?.customer || "").trim() || null;
            const userId = await deps.getUserIdByStripeCustomerId(stripeCustomerId);
            await deps.markPaymentSucceeded({
              stripeSubscriptionId,
              stripeCustomerId,
              eventCreatedUnix,
            });
            if (userId) await deps.syncUserPlanFromSubscription(userId);
          } else {
            webhookStatus = "ignored";
            webhookMessage = `Unhandled event type: ${eventType}`;
          }

          await deps.appendImmutableAudit({
            streamKey: "billing:stripe_webhook",
            action: `billing.stripe.${eventType}`,
            subjectId: verified.eventId,
            payload: {
              eventType,
            },
          });
        } catch (e: unknown) {
          webhookStatus = "failed";
          webhookMessage = safeWebhookMessage(e);
          await deps.logDbErrorEvent({
            scope: "billing_webhook",
            message: webhookMessage,
            ip: requestIp,
            meta: { route: "/api/stripe/webhook", eventType, eventId: verified.eventId },
          });
          await deps.logSecurityEvent({
            type: "stripe_webhook_processing_failed",
            severity: "high",
            ip: requestIp,
            scope: "billing_webhook",
            message: webhookMessage,
            meta: { eventType, eventId: verified.eventId },
          });
        }

        await deps.completeWebhookEvent(verified.eventId, webhookStatus, webhookMessage);

        if (webhookStatus === "failed") {
          return NextResponse.json({ ok: false, error: "WEBHOOK_PROCESSING_FAILED" }, { status: 500 });
        }

        return NextResponse.json({ ok: true, status: webhookStatus });
      })(),
      timeoutMs
    );
  } catch (e: unknown) {
    if (e instanceof Error) {
      await deps.logDbErrorEvent({
        scope: "billing_webhook",
        message: e.message,
        ip: requestIp,
        meta: { route: "/api/stripe/webhook" },
      });
    }
    if (deps.isRuntimeEnvError(e)) {
      return NextResponse.json({ ok: false, error: "ENV_MISCONFIGURED" }, { status: 503 });
    }
    if (deps.isRouteTimeoutError(e)) {
      await deps.logSecurityEvent({
        type: "stripe_webhook_timeout",
        severity: "high",
        ip: requestIp,
        scope: "billing_webhook",
        message: "Stripe webhook processing exceeded timeout",
        meta: { timeoutMs },
      });
      return NextResponse.json({ ok: false, error: "TIMEOUT" }, { status: 504 });
    }
    await deps.logSecurityEvent({
      type: "stripe_webhook_unhandled_error",
      severity: "high",
      ip: requestIp,
      scope: "billing_webhook",
      message: "Unhandled Stripe webhook route error",
    });
    return NextResponse.json({ ok: false, error: "SERVER_ERROR" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return postStripeWebhookRoute(req);
}
