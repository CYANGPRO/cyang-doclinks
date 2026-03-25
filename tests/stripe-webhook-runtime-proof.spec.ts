import { expect, test } from "@playwright/test";
import { verifyStripeWebhookSignature } from "../src/lib/stripeWebhook";
import { postStripeWebhookRoute } from "../src/app/api/stripe/webhook/route";
import {
  createStripeWebhookHarness,
  makeStripeRequest,
  signStripePayload,
} from "./helpers/local-runtime/stripeRuntime";

test.describe("stripe webhook runtime proofs", () => {
  test("accepts valid signed webhook requests and applies billing state transitions", async () => {
    const harness = createStripeWebhookHarness();
    const failedPayload = {
      id: "evt_runtime_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_1", subscription: "sub_1" } },
    };
    const failed = signStripePayload(failedPayload, harness.secret);
    const failedRes = await postStripeWebhookRoute(makeStripeRequest(failed.raw, failed.signature), {
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
    const success = signStripePayload(successPayload, harness.secret);
    const successRes = await postStripeWebhookRoute(makeStripeRequest(success.raw, success.signature), {
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
    const harness = createStripeWebhookHarness();
    const invalidRes = await postStripeWebhookRoute(
      makeStripeRequest(JSON.stringify({ id: "evt_bad", type: "invoice.payment_failed" }), "t=1,v1=deadbeef"),
      {
        ...harness.deps,
        verifyStripeWebhookSignature: (args) =>
          verifyStripeWebhookSignature({ ...args, secret: harness.secret, toleranceSeconds: 3_600 }),
      }
    );
    expect(invalidRes.status).toBe(400);
    const invalidBody = await invalidRes.json();
    expect(invalidBody.error).toBe("INVALID_SIGNATURE");

    const malformedPayload = signStripePayload({ data: { object: {} } }, harness.secret);
    const malformedRes = await postStripeWebhookRoute(makeStripeRequest(malformedPayload.raw, malformedPayload.signature), {
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
    const harness = createStripeWebhookHarness();
    const payload = {
      id: "evt_runtime_duplicate",
      type: "billing.test.unhandled",
      data: { object: {} },
    };
    const signed = signStripePayload(payload, harness.secret);
    const deps = {
      ...harness.deps,
      verifyStripeWebhookSignature: (args: Parameters<typeof verifyStripeWebhookSignature>[0]) =>
        verifyStripeWebhookSignature({ ...args, secret: harness.secret }),
    };

    const first = await postStripeWebhookRoute(makeStripeRequest(signed.raw, signed.signature), deps);
    expect(first.status).toBe(200);
    const second = await postStripeWebhookRoute(makeStripeRequest(signed.raw, signed.signature), deps);
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBeTruthy();
    expect(harness.events.size).toBe(1);

    const oversized = await postStripeWebhookRoute(makeStripeRequest("{}", "t=1,v1=test", 400 * 1024), deps);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toBe("PAYLOAD_TOO_LARGE");
  });
});
