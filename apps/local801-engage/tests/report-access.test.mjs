import assert from "node:assert/strict";
import test from "node:test";
import { recordReportAccess } from "../src/lib/report-access.ts";

test("report access writes a durable metadata-only report audit event", async () => {
  const events = [];
  await recordReportAccess({
    organizationId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
  }, "engagement", async (event) => events.push(event));
  assert.deepEqual(events, [{
    eventType: "report.run",
    actorId: "33333333-3333-4333-8333-333333333333",
    organizationId: "22222222-2222-4222-8222-222222222222",
    subjectType: "report",
    subjectId: "engagement",
    payload: { view: "engagement", outcome: "success" },
  }]);
});

test("report access fails closed when durable audit fails", async () => {
  await assert.rejects(
    () => recordReportAccess({ organizationId: "org", userId: "actor" }, "overview", async () => {
      throw new Error("audit unavailable");
    }),
    /audit unavailable/,
  );
});
