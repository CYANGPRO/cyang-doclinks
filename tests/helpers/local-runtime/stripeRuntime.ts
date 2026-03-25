import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { verifyStripeWebhookSignature } from "../../../src/lib/stripeWebhook";
import type { StripeWebhookRouteDeps } from "../../../src/app/api/stripe/webhook/route";

export function signStripePayload(payload: unknown, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(payload);
  const v1 = crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  return {
    raw,
    signature: `t=${ts},v1=${v1}`,
  };
}

export function makeStripeRequest(raw: string, signature: string, contentLength = Buffer.byteLength(raw, "utf8")) {
  return new NextRequest("https://app.example.test/api/stripe/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(contentLength),
      "stripe-signature": signature,
      "x-forwarded-for": "203.0.113.70",
    },
    body: raw,
  });
}

export function createStripeWebhookHarness() {
  const secret = "whsec_runtime_proof";
  const seenEvents = new Set<string>();
  const subscriptions = new Map<string, { status: string; stripeCustomerId: string | null; planId: string }>();
  const events = new Map<string, { status: string; message: string | null }>();
  const audits: Array<Record<string, unknown>> = [];
  const securityLogs: Array<Record<string, unknown>> = [];
  const dbLogs: Array<Record<string, unknown>> = [];
  const planSyncs: string[] = [];

  const deps = {
    verifyStripeWebhookSignature,
    beginWebhookEvent: async (eventId: string) => {
      if (seenEvents.has(eventId)) return "duplicate";
      seenEvents.add(eventId);
      events.set(eventId, { status: "processing", message: null });
      return "new";
    },
    billingTablesReady: async () => true,
    completeWebhookEvent: async (eventId: string, status: string, message: string | null) => {
      events.set(eventId, { status, message });
    },
    getUserIdByStripeCustomerId: async (customerId: string | null) => (customerId ? `user:${customerId}` : null),
    resolveUserIdForStripeWebhookEvent: async ({
      stripeCustomerId,
      metadataUserId,
    }: {
      stripeCustomerId: string | null;
      metadataUserId: string | null;
    }) => ({
      ok: true,
      userId: metadataUserId ?? (stripeCustomerId ? `user:${stripeCustomerId}` : null),
    }),
    markWebhookEventDuplicate: async (eventId: string) => {
      events.set(eventId, { status: "ignored", message: "duplicate_event_id" });
    },
    markPaymentFailure: async ({
      stripeSubscriptionId,
      stripeCustomerId,
    }: {
      stripeSubscriptionId: string | null;
      stripeCustomerId: string | null;
    }) => {
      if (!stripeSubscriptionId) return;
      subscriptions.set(stripeSubscriptionId, {
        status: "past_due",
        stripeCustomerId,
        planId: subscriptions.get(stripeSubscriptionId)?.planId ?? "pro",
      });
    },
    markPaymentSucceeded: async ({
      stripeSubscriptionId,
      stripeCustomerId,
    }: {
      stripeSubscriptionId: string | null;
      stripeCustomerId: string | null;
    }) => {
      if (!stripeSubscriptionId) return;
      subscriptions.set(stripeSubscriptionId, {
        status: "active",
        stripeCustomerId,
        planId: subscriptions.get(stripeSubscriptionId)?.planId ?? "pro",
      });
    },
    syncUserPlanFromSubscription: async (userId: string | null) => {
      if (userId) planSyncs.push(userId);
      return "pro";
    },
    unixToIso: (value: unknown) => (typeof value === "number" ? new Date(value * 1000).toISOString() : null),
    upsertStripeSubscription: async ({
      stripeSubscriptionId,
      stripeCustomerId,
      status,
      planId,
    }: {
      stripeSubscriptionId: string;
      stripeCustomerId: string | null;
      status: string;
      planId: string;
    }) => {
      subscriptions.set(stripeSubscriptionId, { status, stripeCustomerId, planId });
    },
    appendImmutableAudit: async (entry: unknown) => {
      audits.push(entry as Record<string, unknown>);
    },
    clientIpKey: () => ({ ip: "203.0.113.70", ipHash: "hash" }),
    enforceGlobalApiRateLimit: async () => ({ ok: true, status: 200, retryAfterSeconds: 0 }),
    enforceIpAbuseBlock: async () => ({ ok: true, retryAfterSeconds: 0 }),
    logDbErrorEvent: async (entry: unknown) => {
      dbLogs.push(entry as Record<string, unknown>);
    },
    logSecurityEvent: async (entry: unknown) => {
      securityLogs.push(entry as Record<string, unknown>);
    },
    maybeBlockIpOnAbuse: async () => {},
    getRouteTimeoutMs: () => 15_000,
    isRouteTimeoutError: ((_: unknown): _ is never => false),
    withRouteTimeout: async <T>(work: Promise<T>) => work,
    assertRuntimeEnv: () => {},
    isRuntimeEnvError: ((_: unknown): _ is never => false),
  };

  return {
    secret,
    subscriptions,
    events,
    audits,
    securityLogs,
    dbLogs,
    planSyncs,
    deps: deps as unknown as StripeWebhookRouteDeps,
  };
}
