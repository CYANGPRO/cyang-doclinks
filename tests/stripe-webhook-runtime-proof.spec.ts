import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { verifyStripeWebhookSignature } from "../src/lib/stripeWebhook";
import { postStripeWebhookRoute, type StripeWebhookRouteDeps } from "../src/app/api/stripe/webhook/route";

function signPayload(payload: unknown, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(payload);
  const v1 = crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  return {
    raw,
    signature: `t=${ts},v1=${v1}`,
  };
}

function makeRequest(raw: string, signature: string, contentLength = Buffer.byteLength(raw, "utf8")) {
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

function makeDeps() {
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
    deps: deps as unknown as StripeWebhookRouteDeps,
    secret,
    subscriptions,
    events,
    audits,
    securityLogs,
    dbLogs,
    planSyncs,
  };
}

test.describe("stripe webhook runtime proofs", () => {
  test("accepts valid signed webhook requests and applies billing state transitions", async () => {
    const harness = makeDeps();
    const failedPayload = {
      id: "evt_runtime_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_1", subscription: "sub_1" } },
    };
    const failed = signPayload(failedPayload, harness.secret);
    const failedRes = await postStripeWebhookRoute(makeRequest(failed.raw, failed.signature), {
      ...harness.deps,
      verifyStripeWebhookSignature: (args) =>
        verifyStripeWebhookSignature({ ...args, secret: harness.secret }),
    });
    expect(failedRes.status).toBe(200);
    expect((await failedRes.json()).status).toBe("processed");
    expect(harness.subscriptions.get("sub_1")?.status).toBe("past_due");

    const successPayload = {
      id: "evt_runtime_success",
      type: "invoice.payment_succeeded",
      data: { object: { customer: "cus_1", subscription: "sub_1" } },
    };
    const success = signPayload(successPayload, harness.secret);
    const successRes = await postStripeWebhookRoute(makeRequest(success.raw, success.signature), {
      ...harness.deps,
      verifyStripeWebhookSignature: (args) =>
        verifyStripeWebhookSignature({ ...args, secret: harness.secret }),
    });
    expect(successRes.status).toBe(200);
    expect(harness.subscriptions.get("sub_1")?.status).toBe("active");
    expect(harness.audits).toHaveLength(2);
    expect(harness.planSyncs).toContain("user:cus_1");
  });

  test("rejects invalid signatures and malformed payloads without leaking internal detail", async () => {
    const harness = makeDeps();
    const invalidRes = await postStripeWebhookRoute(
      makeRequest(JSON.stringify({ id: "evt_bad", type: "invoice.payment_failed" }), "t=1,v1=deadbeef"),
      {
        ...harness.deps,
        verifyStripeWebhookSignature: (args) =>
          verifyStripeWebhookSignature({ ...args, secret: harness.secret, toleranceSeconds: 3_600 }),
      }
    );
    expect(invalidRes.status).toBe(400);
    const invalidBody = await invalidRes.json();
    expect(invalidBody.error).toBe("INVALID_SIGNATURE");

    const malformedPayload = signPayload({ data: { object: {} } }, harness.secret);
    const malformedRes = await postStripeWebhookRoute(makeRequest(malformedPayload.raw, malformedPayload.signature), {
      ...harness.deps,
      verifyStripeWebhookSignature: (args) =>
        verifyStripeWebhookSignature({ ...args, secret: harness.secret }),
    });
    expect(malformedRes.status).toBe(400);
    const malformedBody = await malformedRes.json();
    expect(malformedBody.error).toBe("INVALID_SIGNATURE");
    expect(JSON.stringify(malformedBody)).not.toContain("MALFORMED_EVENT");
    expect(harness.securityLogs.length).toBeGreaterThan(0);
  });

  test("handles duplicate events safely and rejects oversized payloads before processing", async () => {
    const harness = makeDeps();
    const payload = {
      id: "evt_runtime_duplicate",
      type: "billing.test.unhandled",
      data: { object: {} },
    };
    const signed = signPayload(payload, harness.secret);
    const deps = {
      ...harness.deps,
      verifyStripeWebhookSignature: (args: Parameters<typeof verifyStripeWebhookSignature>[0]) =>
        verifyStripeWebhookSignature({ ...args, secret: harness.secret }),
    };

    const first = await postStripeWebhookRoute(makeRequest(signed.raw, signed.signature), deps);
    expect(first.status).toBe(200);
    const second = await postStripeWebhookRoute(makeRequest(signed.raw, signed.signature), deps);
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBeTruthy();
    expect(harness.events.size).toBe(1);

    const oversized = await postStripeWebhookRoute(makeRequest("{}", "t=1,v1=test", 400 * 1024), deps);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toBe("PAYLOAD_TOO_LARGE");
  });
});
