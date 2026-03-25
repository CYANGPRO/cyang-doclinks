import { expect, test } from "@playwright/test";
import { postUploadPresignRoute } from "../src/app/api/admin/upload/presign/route";
import { postUploadCompleteRoute } from "../src/app/api/admin/upload/complete/route";
import { getServeRoute } from "../src/app/serve/[docId]/route";
import { getCronScanRoute } from "../src/app/api/cron/scan/route";
import { createUploadRuntimeHarness } from "./helpers/local-runtime/uploadRuntime";

async function prepareQueuedUpload() {
  const harness = createUploadRuntimeHarness();
  const presignRes = await postUploadPresignRoute(
    harness.makeUploadPresignRequest({
      title: "Quarterly Report",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 11,
    }),
    harness.buildUploadPresignDeps()
  );
  expect(presignRes.status).toBe(200);
  const presignBody = await presignRes.json();
  const docId = String(presignBody.doc_id);

  harness.seedUploadedObject(docId);

  const completeRes = await postUploadCompleteRoute(
    harness.makeUploadCompleteRequest(docId),
    harness.buildUploadCompleteDeps()
  );
  expect(completeRes.status).toBe(200);

  return { harness, docId, completeBody: await completeRes.json(), presignBody };
}

test.describe("upload runtime proofs", () => {
  test("runs upload init -> finalize -> scan cron -> release/serve in deterministic local verification mode", async () => {
    const { harness, docId, completeBody, presignBody } = await prepareQueuedUpload();

    expect(presignBody.ok).toBeTruthy();
    expect(presignBody.upload_url).toContain("presigned");
    expect(completeBody.ok).toBeTruthy();
    expect(completeBody.scan_state).toBe("pending");
    expect(harness.queuedScans).toEqual([{ docId, bucket: "docs-bucket", key: harness.getDoc(docId).r2Key }]);
    expect(harness.aliases).toEqual(["quarterly-report"]);

    const blockedServe = await getServeRoute(
      harness.makeServeRequest(docId),
      { params: Promise.resolve({ docId }) },
      harness.buildServeDeps()
    );
    expect(blockedServe.status).toBe(404);

    harness.setScannerOutcome(docId, "clean");
    const cronRes = await getCronScanRoute(harness.makeCronScanRequest(), harness.buildCronScanDeps());
    expect(cronRes.status).toBe(200);
    const cronBody = await cronRes.json();
    expect(cronBody.claimed).toBe(1);
    expect(cronBody.results).toEqual([{ id: "job-1", ok: true, verdict: "clean", riskLevel: "low" }]);
    expect(harness.getDoc(docId).scanStatus).toBe("clean");

    const releasedServe = await getServeRoute(
      harness.makeServeRequest(docId),
      { params: Promise.resolve({ docId }) },
      harness.buildServeDeps()
    );
    expect(releasedServe.status).toBe(302);
    expect(releasedServe.headers.get("location")).toBe("https://app.example.test/t/ticket_1");
  });

  test("fails closed when the scanner is unavailable and keeps the document unservable", async () => {
    const { harness, docId } = await prepareQueuedUpload();
    harness.setScannerOutcome(docId, "unavailable");

    const cronRes = await getCronScanRoute(harness.makeCronScanRequest(), harness.buildCronScanDeps());
    expect(cronRes.status).toBe(200);
    const cronBody = await cronRes.json();
    expect(cronBody.results).toEqual([{ id: "job-1", ok: false, error: "SCAN_JOB_FAILED" }]);
    expect(harness.getDoc(docId).scanStatus).toBe("pending");
    expect(harness.securityLogs.some((entry) => entry.type === "malware_scan_job_failed")).toBeTruthy();
    expect(harness.exceptions).toHaveLength(1);

    const blockedServe = await getServeRoute(
      harness.makeServeRequest(docId),
      { params: Promise.resolve({ docId }) },
      harness.buildServeDeps()
    );
    expect(blockedServe.status).toBe(404);
  });

  test("blocks unknown or infected scan outcomes at serve time without silently releasing access", async () => {
    const unknown = await prepareQueuedUpload();
    unknown.harness.setScannerOutcome(unknown.docId, "unknown");
    const unknownCron = await getCronScanRoute(
      unknown.harness.makeCronScanRequest(),
      unknown.harness.buildCronScanDeps()
    );
    expect(unknownCron.status).toBe(200);
    expect(unknown.harness.getDoc(unknown.docId).scanStatus).toBe("pending");

    const unknownServe = await getServeRoute(
      unknown.harness.makeServeRequest(unknown.docId),
      { params: Promise.resolve({ docId: unknown.docId }) },
      unknown.harness.buildServeDeps()
    );
    expect(unknownServe.status).toBe(404);

    const infected = await prepareQueuedUpload();
    infected.harness.setScannerOutcome(infected.docId, "infected");
    const infectedCron = await getCronScanRoute(
      infected.harness.makeCronScanRequest(),
      infected.harness.buildCronScanDeps()
    );
    expect(infectedCron.status).toBe(200);
    expect(infected.harness.getDoc(infected.docId).scanStatus).toBe("quarantined");
    expect(infected.harness.getDoc(infected.docId).moderationStatus).toBe("quarantined");

    const infectedServe = await getServeRoute(
      infected.harness.makeServeRequest(infected.docId),
      { params: Promise.resolve({ docId: infected.docId }) },
      infected.harness.buildServeDeps()
    );
    expect(infectedServe.status).toBe(404);
  });

  test("blocks legacy unencrypted docs at finalize time and deletes the plaintext object", async () => {
    const harness = createUploadRuntimeHarness({
      id: "11111111-1111-4111-8111-111111111111",
      encryptionEnabled: false,
    });
    harness.seedUploadedObject("11111111-1111-4111-8111-111111111111");

    const res = await postUploadCompleteRoute(
      harness.makeUploadCompleteRequest("11111111-1111-4111-8111-111111111111"),
      harness.buildUploadCompleteDeps()
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ENCRYPTION_REQUIRED");
    expect(harness.deletedKeys).toEqual(["docs/11111111-1111-4111-8111-111111111111_report.pdf"]);
  });
});
