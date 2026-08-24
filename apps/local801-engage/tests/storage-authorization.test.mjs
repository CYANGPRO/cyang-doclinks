import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { previewAuthEnabled } from "../src/lib/preview-auth-policy.ts";
import { setLocal801QueryForTests } from "../src/lib/db.ts";
import {
  deleteEncryptedDocument,
  downloadDocument,
  downloadGeneratedReport,
  storeEncryptedDocument,
  storeEncryptedImportFile,
  storeGeneratedReport,
} from "../src/lib/document-storage.ts";
import { encryptData } from "../src/lib/encryption.ts";
import { hasExactSameOrigin } from "../src/lib/request-security.ts";
import { setR2ClientFactoryForTests } from "../src/lib/r2.ts";

const originalEnv = { ...process.env };
const organizationId = "11111111-1111-4111-8111-111111111111";
const storageKey = "local801/documents/2026/08/35e10e0e-e82c-4b7e-9d18-726f4ebef649";

function configureInfrastructureEnvironment() {
  process.env.LOCAL801_ENCRYPTION_MASTER_KEYS = JSON.stringify({
    v1: Buffer.alloc(32, 1).toString("base64"),
  });
  process.env.LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION = "v1";
  process.env.LOCAL801_R2_ACCOUNT_ID = "abc123";
  process.env.LOCAL801_R2_ENDPOINT = "https://abc123.r2.cloudflarestorage.com";
  process.env.LOCAL801_R2_BUCKET = "local801-private";
  process.env.LOCAL801_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.LOCAL801_R2_SECRET_ACCESS_KEY = "test-secret-key";
}

function documentFixture(visibility = "local_admin_only") {
  const plaintext = Buffer.from("synthetic authorized document");
  const encrypted = encryptData(plaintext);
  return {
    plaintext,
    encrypted,
    row: {
      id: "22222222-2222-4222-8222-222222222222",
      storage_key: storageKey,
      encryption_key_version: "v1",
      sha256: createHash("sha256").update(plaintext).digest("hex"),
      media_type: "text/plain",
      original_filename: "synthetic.txt",
      visibility,
    },
  };
}

function mockEncryptedDownload(encrypted) {
  let retrievals = 0;
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      if (command instanceof GetObjectCommand) {
        retrievals += 1;
        return { Body: encrypted, ContentLength: encrypted.byteLength };
      }
      return {};
    },
  }));
  return () => retrievals;
}

test.beforeEach(() => {
  configureInfrastructureEnvironment();
});

test.afterEach(() => {
  process.env = { ...originalEnv };
  setLocal801QueryForTests(null);
  setR2ClientFactoryForTests(null);
});

test("local_admin can retrieve a local_admin_only document", async () => {
  const fixture = documentFixture();
  const retrievals = mockEncryptedDownload(fixture.encrypted);
  setLocal801QueryForTests(async () => [fixture.row]);

  const result = await downloadDocument({
    actor: { organizationId, role: "local_admin" },
    organizationId,
    documentId: fixture.row.id,
  });

  assert.deepEqual(result.plaintext, fixture.plaintext);
  assert.equal(retrievals(), 1);
});

test("system_owner can retrieve a local_admin_only document", async () => {
  const fixture = documentFixture();
  const retrievals = mockEncryptedDownload(fixture.encrypted);
  setLocal801QueryForTests(async () => [fixture.row]);

  const result = await downloadDocument({
    actor: { organizationId, role: "system_owner" },
    organizationId,
    documentId: fixture.row.id,
  });

  assert.deepEqual(result.plaintext, fixture.plaintext);
  assert.equal(retrievals(), 1);
});

test("cat_lead cannot retrieve local_admin_only and authorization fails before R2", async () => {
  const fixture = documentFixture();
  const retrievals = mockEncryptedDownload(fixture.encrypted);
  setLocal801QueryForTests(async () => [fixture.row]);

  await assert.rejects(
    downloadDocument({
      actor: { organizationId, role: "cat_lead" },
      organizationId,
      documentId: fixture.row.id,
    }),
    /Forbidden/,
  );
  assert.equal(retrievals(), 0);
});

test("unsupported document visibility fails closed before R2 and upload", async () => {
  const fixture = documentFixture("public");
  let storageCalls = 0;
  setR2ClientFactoryForTests(() => ({
    async send() {
      storageCalls += 1;
      return { Body: fixture.encrypted };
    },
  }));
  setLocal801QueryForTests(async () => [fixture.row]);

  await assert.rejects(
    downloadDocument({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      documentId: fixture.row.id,
    }),
    /Unsupported document visibility/,
  );
  await assert.rejects(
    storeEncryptedDocument({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      category: "readiness",
      title: "Unsupported visibility",
      originalFilename: "synthetic.txt",
      visibility: "public",
      status: "draft",
      createdBy: "33333333-3333-4333-8333-333333333333",
      content: "synthetic",
      mediaType: "text/plain",
    }),
    /Unsupported document visibility/,
  );
  assert.equal(storageCalls, 0);
});

test("cat_admin cannot create a local_admin_only document before encryption or R2", async () => {
  let queryCalls = 0;
  let storageCalls = 0;
  setLocal801QueryForTests(async () => {
    queryCalls += 1;
    return [{ belongs: true }];
  });
  setR2ClientFactoryForTests(() => ({ async send() { storageCalls += 1; return {}; } }));

  await assert.rejects(
    storeEncryptedDocument({
      actor: { organizationId, role: "cat_admin" },
      organizationId,
      category: "readiness",
      title: "Synthetic",
      originalFilename: "synthetic.txt",
      visibility: "local_admin_only",
      status: "draft",
      createdBy: "33333333-3333-4333-8333-333333333333",
      content: "synthetic",
      mediaType: "text/plain",
    }),
    /Forbidden/,
  );
  assert.equal(queryCalls, 0);
  assert.equal(storageCalls, 0);
});

for (const role of ["membership_data_manager", "cat_admin"]) {
  test(`${role} cannot delete local_admin_only before UPDATE or R2`, async () => {
    let updates = 0;
    let storageCalls = 0;
    setLocal801QueryForTests(async (sql) => {
      if (sql.includes("SELECT organization_id, visibility")) {
        return [{ organization_id: organizationId, visibility: "local_admin_only" }];
      }
      if (sql.includes("UPDATE local801.documents")) updates += 1;
      return [];
    });
    setR2ClientFactoryForTests(() => ({ async send() { storageCalls += 1; return {}; } }));

    await assert.rejects(
      deleteEncryptedDocument({
        actor: { organizationId, role },
        organizationId,
        documentId: "22222222-2222-4222-8222-222222222222",
      }),
      /Forbidden/,
    );
    assert.equal(updates, 0);
    assert.equal(storageCalls, 0);
  });
}

test("local_admin can delete local_admin_only after visibility authorization", async () => {
  const events = [];
  setLocal801QueryForTests(async (sql) => {
    if (sql.includes("SELECT organization_id, visibility")) {
      events.push("database-read-visibility");
      return [{ organization_id: organizationId, visibility: "local_admin_only" }];
    }
    if (sql.includes("UPDATE local801.documents")) {
      events.push("database-mark-pending");
      return [{ storage_key: storageKey }];
    }
    if (sql.includes("DELETE FROM local801.documents")) events.push("database-delete");
    return [];
  });
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      assert.equal(command instanceof DeleteObjectCommand, true);
      events.push("r2-delete");
      return {};
    },
  }));

  assert.deepEqual(
    await deleteEncryptedDocument({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      documentId: "22222222-2222-4222-8222-222222222222",
    }),
    { deleted: true },
  );
  assert.deepEqual(events, [
    "database-read-visibility",
    "database-mark-pending",
    "r2-delete",
    "database-delete",
  ]);
});

test("unknown visibility prevents document deletion before UPDATE or R2", async () => {
  let updates = 0;
  let storageCalls = 0;
  setLocal801QueryForTests(async (sql) => {
    if (sql.includes("SELECT organization_id, visibility")) {
      return [{ organization_id: organizationId, visibility: "unsupported" }];
    }
    if (sql.includes("UPDATE local801.documents")) updates += 1;
    return [];
  });
  setR2ClientFactoryForTests(() => ({ async send() { storageCalls += 1; return {}; } }));

  await assert.rejects(
    deleteEncryptedDocument({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      documentId: "22222222-2222-4222-8222-222222222222",
    }),
    /Unsupported document visibility/,
  );
  assert.equal(updates, 0);
  assert.equal(storageCalls, 0);
});

test("report_viewer cannot retrieve a person-level generated report before R2", async () => {
  let retrievals = 0;
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      if (command instanceof GetObjectCommand) retrievals += 1;
      return {};
    },
  }));
  setLocal801QueryForTests(async (sql) => {
    assert.match(sql, /JOIN local801\.report_runs/);
    assert.match(sql, /JOIN local801\.report_definitions/);
    return [{
      id: "44444444-4444-4444-8444-444444444444",
      storage_key: "local801/reports/2026/08/35e10e0e-e82c-4b7e-9d18-726f4ebef649",
      encryption_key_version: "v1",
      sha256: "0".repeat(64),
      media_type: "application/pdf",
      requires_person_level_permission: true,
    }];
  });

  await assert.rejects(
    downloadGeneratedReport({
      actor: { organizationId, role: "report_viewer" },
      organizationId,
      generatedReportId: "44444444-4444-4444-8444-444444444444",
    }),
    /Forbidden/,
  );
  assert.equal(retrievals, 0);
});

test("report_viewer can retrieve a non-person-level generated report", async () => {
  const plaintext = Buffer.from("synthetic aggregate report");
  const encrypted = encryptData(plaintext);
  let retrievals = 0;
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      if (command instanceof GetObjectCommand) {
        retrievals += 1;
        return { Body: encrypted, ContentLength: encrypted.byteLength };
      }
      return {};
    },
  }));
  setLocal801QueryForTests(async () => [{
    id: "44444444-4444-4444-8444-444444444444",
    storage_key: "local801/reports/2026/08/35e10e0e-e82c-4b7e-9d18-726f4ebef649",
    encryption_key_version: "v1",
    sha256: createHash("sha256").update(plaintext).digest("hex"),
    media_type: "application/pdf",
    requires_person_level_permission: false,
  }]);

  const result = await downloadGeneratedReport({
    actor: { organizationId, role: "report_viewer" },
    organizationId,
    generatedReportId: "44444444-4444-4444-8444-444444444444",
  });
  assert.deepEqual(result.plaintext, plaintext);
  assert.equal(retrievals, 1);
});

test("cat_admin cannot store a person-level report before R2", async () => {
  let storageCalls = 0;
  setLocal801QueryForTests(async () => [{
    belongs: true,
    requires_person_level_permission: true,
  }]);
  setR2ClientFactoryForTests(() => ({ async send() { storageCalls += 1; return {}; } }));

  await assert.rejects(
    storeGeneratedReport({
      actor: { organizationId, role: "cat_admin" },
      organizationId,
      reportRunId: "55555555-5555-4555-8555-555555555555",
      mediaType: "application/pdf",
      content: "synthetic person-level report",
    }),
    /Forbidden/,
  );
  assert.equal(storageCalls, 0);
});

for (const role of ["membership_data_manager", "local_admin"]) {
  test(`${role} can store a person-level generated report`, async () => {
    let putCalls = 0;
    setLocal801QueryForTests(async (sql) => {
      if (sql.includes("SELECT\n        true AS belongs")) {
        return [{ belongs: true, requires_person_level_permission: true }];
      }
      if (sql.includes("INSERT INTO local801.generated_reports")) {
        assert.match(sql, /NOT definition\.requires_person_level_permission OR \$9/);
        return [{ id: "66666666-6666-4666-8666-666666666666" }];
      }
      return [];
    });
    setR2ClientFactoryForTests(() => ({
      async send(command) {
        if (command instanceof PutObjectCommand) putCalls += 1;
        return {};
      },
    }));

    const result = await storeGeneratedReport({
      actor: { organizationId, role },
      organizationId,
      reportRunId: "55555555-5555-4555-8555-555555555555",
      mediaType: "application/pdf",
      content: "synthetic person-level report",
    });
    assert.equal(result.id, "66666666-6666-4666-8666-666666666666");
    assert.equal(putCalls, 1);
  });
}

test("cross-organization createdBy is rejected before document upload", async () => {
  let storageCalls = 0;
  setLocal801QueryForTests(async () => [{ belongs: false }]);
  setR2ClientFactoryForTests(() => ({ async send() { storageCalls += 1; return {}; } }));

  await assert.rejects(
    storeEncryptedDocument({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      category: "readiness",
      title: "Synthetic",
      originalFilename: "synthetic.txt",
      visibility: "local_admin_only",
      status: "draft",
      createdBy: "99999999-9999-4999-8999-999999999999",
      content: "synthetic",
      mediaType: "text/plain",
    }),
    /creator does not belong/,
  );
  assert.equal(storageCalls, 0);
});

test("cross-organization importBatchId is rejected before import upload", async () => {
  let storageCalls = 0;
  setLocal801QueryForTests(async () => [{ belongs: false }]);
  setR2ClientFactoryForTests(() => ({ async send() { storageCalls += 1; return {}; } }));

  await assert.rejects(
    storeEncryptedImportFile({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      importBatchId: "99999999-9999-4999-8999-999999999999",
      originalFilename: "synthetic.csv",
      mediaType: "text/csv",
      content: "synthetic",
    }),
    /Import batch does not belong/,
  );
  assert.equal(storageCalls, 0);
});

test("cross-organization reportRunId is rejected before report upload", async () => {
  let storageCalls = 0;
  setLocal801QueryForTests(async () => [{ belongs: false }]);
  setR2ClientFactoryForTests(() => ({ async send() { storageCalls += 1; return {}; } }));

  await assert.rejects(
    storeGeneratedReport({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      reportRunId: "99999999-9999-4999-8999-999999999999",
      mediaType: "application/pdf",
      content: "synthetic",
    }),
    /Report run does not belong/,
  );
  assert.equal(storageCalls, 0);
});

test("document cleanup records a recoverable pending state before deleting R2", async () => {
  const events = [];
  setLocal801QueryForTests(async (sql) => {
    if (sql.includes("SELECT organization_id, visibility")) {
      events.push("database-read-visibility");
      return [{ organization_id: organizationId, visibility: "local_admin_only" }];
    }
    if (sql.includes("UPDATE local801.documents")) {
      events.push("database-mark-pending");
      assert.match(sql, /storage_cleanup_pending_at/);
      return [{ storage_key: storageKey }];
    }
    if (sql.includes("DELETE FROM local801.documents")) {
      events.push("database-delete-failed");
      throw new Error("synthetic database failure");
    }
    return [];
  });
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      assert.equal(command instanceof DeleteObjectCommand, true);
      events.push("r2-delete");
      return {};
    },
  }));

  await assert.rejects(
    deleteEncryptedDocument({
      actor: { organizationId, role: "local_admin" },
      organizationId,
      documentId: "22222222-2222-4222-8222-222222222222",
    }),
    /archived metadata cleanup remains pending/,
  );
  assert.deepEqual(events, [
    "database-read-visibility",
    "database-mark-pending",
    "r2-delete",
    "database-delete-failed",
  ]);
});

test("readiness POST origin policy requires an exact Origin header", () => {
  assert.equal(
    hasExactSameOrigin(new Request("https://preview.example.test/api/readiness/document-roundtrip")),
    false,
  );
  assert.equal(
    hasExactSameOrigin(new Request("https://preview.example.test/api/readiness/document-roundtrip", {
      headers: { Origin: "https://preview.example.test" },
    })),
    true,
  );
  assert.equal(
    hasExactSameOrigin(new Request("https://preview.example.test/api/readiness/document-roundtrip", {
      headers: { Origin: "https://attacker.example.test" },
    })),
    false,
  );
});

test("preview synthetic auth always fails closed in Vercel production", () => {
  delete process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED;
  process.env.VERCEL_ENV = "production";
  process.env.NODE_ENV = "production";
  process.env.LOCAL801_PREVIEW_AUTH_ENABLED = "1";
  assert.equal(previewAuthEnabled(), false);
});

test("preview synthetic auth remains available in Vercel Preview when explicitly enabled", () => {
  delete process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED;
  process.env.VERCEL_ENV = "preview";
  process.env.NODE_ENV = "production";
  process.env.LOCAL801_PREVIEW_AUTH_ENABLED = "1";
  assert.equal(previewAuthEnabled(), true);
});

test("local development intentionally enables synthetic auth without the Preview flag", () => {
  delete process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED;
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = "development";
  process.env.LOCAL801_PREVIEW_AUTH_ENABLED = "0";
  assert.equal(previewAuthEnabled(), true);
});

test("the explicit Production launch flag disables Preview authentication without Vercel metadata", () => {
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = "production";
  process.env.LOCAL801_PREVIEW_AUTH_ENABLED = "1";
  process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED = "1";
  try {
    assert.equal(previewAuthEnabled(), false);
  } finally {
    delete process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED;
  }
});
