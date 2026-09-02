import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  approveMemberEmailBroadcast,
  createMemberEmailBroadcast,
  getMemberEmailBroadcastPreview,
  listMemberEmailAttachmentOptions,
  listMemberEmailAudienceOptions,
  previewMemberEmailAudience,
  sendMemberEmailRealTest,
} from "../src/lib/member-email-broadcasts.ts";
import {
  memberEmailDeliveryBoundary,
  memberEmailPreviewEnabled,
  memberEmailRealTestBoundary,
} from "../src/lib/member-email-preview-policy.ts";
import { encryptPiiField } from "../src/lib/pii-protection.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const creatorId = "10000000-0000-4000-8000-000000000002";
const approverId = "10000000-0000-4000-8000-000000000003";
const snapshotId = "10000000-0000-4000-8000-000000000004";
const broadcastId = "10000000-0000-4000-8000-000000000005";
const handle = "a".repeat(64);
const documentId = "10000000-0000-4000-8000-000000000006";
const documentHandle = "e".repeat(64);

const previewEnv = {
  NODE_ENV: "production",
  VERCEL_ENV: "preview",
  LOCAL801_PREVIEW_AUTH_ENABLED: "1",
  LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
  LOCAL801_EMAIL_BROADCAST_PREVIEW_ENABLED: "1",
  LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0",
  LOCAL801_PII_PROTECTED_READ_PREVIEW_ENABLED: "0",
};

const realTestEnv = {
  ...previewEnv,
  LOCAL801_EMAIL_BROADCAST_REAL_TEST_ENABLED: "1",
  LOCAL801_EMAIL_BROADCAST_TEST_RECIPIENT: "owner@example.test",
  LOCAL801_EMAIL_BROADCAST_FROM: "CAT Notices <notices@cat.cyang.io>",
  LOCAL801_EMAIL_BROADCAST_REPLY_TO: "cyangprojects@gmail.com",
  RESEND_API_KEY: "test-only-key",
};

const keyConfig = Object.freeze({
  encryptionKeys: new Map([["v1", Buffer.alloc(32, 11)]]),
  activeEncryptionKeyVersion: "v1",
  blindIndexKeys: new Map([["v1", Buffer.alloc(32, 17)]]),
  activeBlindIndexKeyVersion: "v1",
});

function context(userId = creatorId) {
  return {
    organizationId,
    organizationSlug: "local801-preview",
    userId,
    email: userId === creatorId ? "system_owner@example.test" : "local_admin@example.test",
    role: userId === creatorId ? "system_owner" : "local_admin",
  };
}

const audienceRows = [
  {
    person_id: "20000000-0000-4000-8000-000000000001",
    home_contact_id: "30000000-0000-4000-8000-000000000001",
    home_contact_value: "avery.member@example.test",
    work_contact_id: "30000000-0000-4000-8000-000000000011",
    work_contact_value: "avery.work@example.test",
  },
  {
    person_id: "20000000-0000-4000-8000-000000000002",
    home_contact_id: null,
    home_contact_value: null,
    work_contact_id: "30000000-0000-4000-8000-000000000012",
    work_contact_value: "riley.work@example.test",
  },
  {
    person_id: "20000000-0000-4000-8000-000000000003",
    home_contact_id: "30000000-0000-4000-8000-000000000003",
    home_contact_value: "shared.household@example.test",
    work_contact_id: null,
    work_contact_value: null,
  },
  {
    person_id: "20000000-0000-4000-8000-000000000004",
    home_contact_id: "30000000-0000-4000-8000-000000000004",
    home_contact_value: "shared.household@example.test",
    work_contact_id: null,
    work_contact_value: null,
  },
  {
    person_id: "20000000-0000-4000-8000-000000000005",
    home_contact_id: null,
    home_contact_value: null,
    work_contact_id: null,
    work_contact_value: null,
  },
].map((row) => ({
  home_encrypted_payload: null,
  home_key_version: null,
  home_format_version: null,
  work_encrypted_payload: null,
  work_key_version: null,
  work_format_version: null,
  ...row,
}));

function audienceQuery(extra = async () => null) {
  return async (sql, parameters = []) => {
    const override = await extra(sql, parameters);
    if (override !== null) return override;
    if (sql.includes("member-email:latest-approved-snapshot")) return [{ id: snapshotId, snapshot_date: "2026-08-01" }];
    if (sql.includes("member-email:synthetic-audience")) return audienceRows;
    if (sql.includes("member-email:suppression-preferences")) return [];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
}

test("Preview gate is intrinsically denied in Production and under the launch interlock", () => {
  assert.equal(memberEmailPreviewEnabled(previewEnv), true);
  assert.equal(memberEmailPreviewEnabled({ ...previewEnv, VERCEL_ENV: "production" }), false);
  assert.equal(memberEmailPreviewEnabled({ ...previewEnv, LOCAL801_PRODUCTION_LAUNCH_ENABLED: "1" }), false);
  assert.equal(memberEmailPreviewEnabled({ ...previewEnv, LOCAL801_EMAIL_BROADCAST_PREVIEW_ENABLED: "0" }), false);
  assert.deepEqual(memberEmailDeliveryBoundary(previewEnv), {
    mode: "preview_simulation",
    provider: null,
    outboundNetworkAllowed: false,
    webhookAllowed: false,
    recipientDomain: "example.test",
  });
  assert.throws(() => memberEmailDeliveryBoundary({ ...previewEnv, VERCEL_ENV: "production" }), /unavailable/i);
  assert.deepEqual(memberEmailRealTestBoundary(realTestEnv), {
    mode: "preview_single_recipient",
    provider: "resend",
    recipient: "owner@example.test",
    from: "CAT Notices <notices@cat.cyang.io>",
    replyTo: "cyangprojects@gmail.com",
    apiKey: "test-only-key",
    maxRecipients: 1,
    memberDeliveryAllowed: false,
    webhookAllowed: false,
  });
  assert.throws(() => memberEmailRealTestBoundary({ ...realTestEnv, VERCEL_ENV: "production" }), /unavailable/i);
  assert.throws(() => memberEmailRealTestBoundary({ ...realTestEnv, LOCAL801_EMAIL_BROADCAST_REAL_TEST_ENABLED: "0" }), /disabled/i);
  assert.throws(() => memberEmailRealTestBoundary({ ...realTestEnv, LOCAL801_EMAIL_BROADCAST_TEST_RECIPIENT: "one@example.test,two@example.test" }), /exactly one/i);
  assert.throws(() => memberEmailRealTestBoundary({ ...realTestEnv, LOCAL801_EMAIL_BROADCAST_FROM: "CAT Preview <cat@cyang.io>" }), /verified cat\.cyang\.io/i);
  assert.throws(() => memberEmailRealTestBoundary({ ...realTestEnv, LOCAL801_EMAIL_BROADCAST_REPLY_TO: "one@example.test,two@example.test" }), /exactly one/i);
});

function realTestRow() {
  const subject = encryptPiiField("Synthetic member update", {
    organizationId,
    entity: "member-email-broadcast",
    recordId: broadcastId,
    field: "subject",
  }, keyConfig);
  const body = encryptPiiField("This is a **Preview-only** message.", {
    organizationId,
    entity: "member-email-broadcast",
    recordId: broadcastId,
    field: "body",
  }, keyConfig);
  return {
    id: broadcastId,
    handle,
    status: "draft",
    source_snapshot_id: snapshotId,
    snapshot_date: "2026-08-01",
    eligible_count: 3,
    missing_count: 1,
    duplicate_count: 1,
    suppressed_count: 0,
    scheduled_for: null,
    created_by: creatorId,
    approved_by: null,
    simulated_at: null,
    created_at: "2026-08-25T12:00:00.000Z",
    subject_encrypted_payload: subject.encryptedPayload,
    subject_encryption_key_version: subject.encryptionKeyVersion,
    subject_encryption_format_version: subject.encryptionFormatVersion,
    body_encrypted_payload: body.encryptedPayload,
    body_encryption_key_version: body.encryptionKeyVersion,
    body_encryption_format_version: body.encryptionFormatVersion,
  };
}

test("real Preview test sends exactly once to the configured address and never reads member recipients", async () => {
  const sqlCalls = [];
  const providerCalls = [];
  const auditCalls = [];
  const loadedAttachmentRows = [];
  const query = async (sql, parameters = []) => {
    sqlCalls.push(sql);
    if (sql.includes("member-email:real-test-broadcast")) return [realTestRow()];
    if (sql.includes("member-email:real-test-audit-check")) return [];
    if (sql.includes("member-email:send-attachments")) return [{
      document_id: documentId,
      handle: null,
      title: "Synthetic agenda",
      original_filename: "synthetic-agenda.pdf",
      media_type: "application/pdf",
      byte_size: 128,
      sha256: "f".repeat(64),
      display_order: 1,
    }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
  const transaction = async (callback) => callback(async (sql, parameters = []) => {
    auditCalls.push({ sql, parameters });
    if (sql.includes("SELECT event_hash")) return [];
    if (sql.includes("INSERT INTO local801.audit_events")) return [{ audit_written: true }];
    return [];
  });
  const result = await sendMemberEmailRealTest(context(), handle, {
    env: realTestEnv,
    keyConfig,
    query,
    transaction,
    loadAttachments: async (_context, rows) => {
      loadedAttachmentRows.push(...rows);
      return [{ content: Buffer.from("synthetic"), filename: "synthetic-agenda.pdf", contentType: "application/pdf" }];
    },
    sendPreviewTest: async (input) => {
      providerCalls.push(input);
      return { providerMessageId: "provider-test-id" };
    },
  });
  assert.deepEqual(result, { action: "real_test", status: "draft", alreadySent: false });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].to, "owner@example.test");
  assert.equal(providerCalls[0].from, "CAT Notices <notices@cat.cyang.io>");
  assert.equal(providerCalls[0].replyTo, "cyangprojects@gmail.com");
  assert.match(providerCalls[0].subject, /^\[CAT Preview Test\]/);
  assert.match(providerCalls[0].text, /This is a Preview-only message\./);
  assert.doesNotMatch(providerCalls[0].text, /\*\*/);
  assert.match(providerCalls[0].text, /No member broadcast was delivered/);
  assert.match(providerCalls[0].html, /<strong>Preview-only<\/strong>/);
  assert.match(providerCalls[0].html, /No member broadcast was delivered/);
  assert.equal(loadedAttachmentRows.length, 1);
  assert.equal(providerCalls[0].attachments.length, 1);
  assert.equal(providerCalls[0].attachments[0].filename, "synthetic-agenda.pdf");
  assert.equal(sqlCalls.some((sql) => sql.includes("member_email_broadcast_recipients")), false);
  const auditInsert = auditCalls.find((call) => call.sql.includes("INSERT INTO local801.audit_events"));
  assert.ok(auditInsert);
  assert.doesNotMatch(JSON.stringify(auditInsert.parameters), /owner@example\.test|Synthetic member update|Preview-only message/);
});

test("a recorded real Preview test prevents another provider call", async () => {
  let providerCalls = 0;
  const result = await sendMemberEmailRealTest(context(), handle, {
    env: realTestEnv,
    keyConfig,
    query: async (sql) => {
      if (sql.includes("member-email:real-test-broadcast")) return [realTestRow()];
      if (sql.includes("member-email:real-test-audit-check")) return [{ already_sent: true }];
      throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
    },
    transaction: async () => { throw new Error("transaction should not run"); },
    sendPreviewTest: async () => {
      providerCalls += 1;
      return { providerMessageId: "unexpected" };
    },
  });
  assert.deepEqual(result, { action: "real_test", status: "draft", alreadySent: true });
  assert.equal(providerCalls, 0);
});

test("recipient preview prefers home email, falls back to work, deduplicates, and exposes counts only", async () => {
  const summary = await previewMemberEmailAudience(context(), {
    env: previewEnv,
    keyConfig,
    query: audienceQuery(),
  });
  assert.deepEqual(summary, {
    audienceKey: "members",
    audienceLabel: "All current members",
    snapshotDate: "2026-08-01",
    representedRecipients: 5,
    eligible: 3,
    missing: 1,
    duplicate: 1,
    suppressed: 0,
    homePreferred: 3,
    workFallback: 1,
    syntheticOnly: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /avery|riley|shared\.household|@example\.test/i);
});

test("department audiences resolve from opaque choices and constrain the approved snapshot", async () => {
  const departmentHandle = "b".repeat(64);
  let audienceParameters;
  const query = audienceQuery(async (sql, parameters) => {
    if (sql.includes("member-email:resolve-department-audience")) return [{ department: "Synthetic Services" }];
    if (sql.includes("member-email:synthetic-audience")) {
      audienceParameters = parameters;
      return audienceRows.slice(0, 2);
    }
    return null;
  });
  const summary = await previewMemberEmailAudience(context(), { env: previewEnv, keyConfig, query }, `department:${departmentHandle}`);
  assert.equal(summary.audienceKey, `department:${departmentHandle}`);
  assert.equal(summary.audienceLabel, "Department members · Synthetic Services");
  assert.equal(summary.representedRecipients, 2);
  assert.deepEqual(audienceParameters, [organizationId, snapshotId, "department", "Synthetic Services", null]);
});

test("CAT audience uses active CAT account email data without widening the real-send boundary", async () => {
  const catRows = [{
    recipient_kind: "workspace_user",
    person_id: null,
    user_id: "20000000-0000-4000-8000-000000000099",
    home_contact_id: null,
    home_contact_value: null,
    work_contact_id: null,
    work_contact_value: null,
    user_email_value: "cat.member@example.test",
  }].map((row) => ({
    home_encrypted_payload: null, home_key_version: null, home_format_version: null,
    work_encrypted_payload: null, work_key_version: null, work_format_version: null,
    user_email_encrypted_payload: null, user_email_key_version: null, user_email_format_version: null,
    ...row,
  }));
  const summary = await previewMemberEmailAudience(context(), {
    env: previewEnv,
    keyConfig,
    query: audienceQuery(async (sql) => sql.includes("member-email:synthetic-workspace-user-audience") ? catRows : null),
  }, "cat_members");
  assert.equal(summary.audienceLabel, "All CAT members");
  assert.equal(summary.representedRecipients, 1);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.homePreferred, 0);
  assert.equal(summary.workFallback, 0);
  assert.doesNotMatch(JSON.stringify(summary), /cat\.member|@example\.test/i);
  assert.equal(memberEmailRealTestBoundary(realTestEnv).memberDeliveryAllowed, false);
});

test("registered-user audience includes active assigned users across Local 801 roles", async () => {
  const registeredRows = ["system.owner", "report.viewer"].map((name, index) => ({
    recipient_kind: "workspace_user",
    person_id: null,
    user_id: `20000000-0000-4000-8000-0000000001${index.toString().padStart(2, "0")}`,
    home_contact_id: null,
    home_contact_value: null,
    home_encrypted_payload: null,
    home_key_version: null,
    home_format_version: null,
    work_contact_id: null,
    work_contact_value: null,
    work_encrypted_payload: null,
    work_key_version: null,
    work_format_version: null,
    user_email_value: `${name}@example.test`,
    user_email_encrypted_payload: null,
    user_email_key_version: null,
    user_email_format_version: null,
  }));
  let audienceParameters;
  let audienceSql;
  const summary = await previewMemberEmailAudience(context(), {
    env: previewEnv,
    keyConfig,
    query: audienceQuery(async (sql, parameters) => {
      if (!sql.includes("member-email:synthetic-workspace-user-audience")) return null;
      audienceSql = sql;
      audienceParameters = parameters;
      return registeredRows;
    }),
  }, "registered_users");
  assert.equal(summary.audienceLabel, "All registered users");
  assert.equal(summary.representedRecipients, 2);
  assert.equal(summary.eligible, 2);
  assert.deepEqual(audienceParameters, [organizationId, "registered_users"]);
  assert.match(audienceSql, /AND EXISTS \(/);
  assert.doesNotMatch(JSON.stringify(summary), /system\.owner|report\.viewer|@example\.test/i);
});

test("audience options expose membership, registered users, CAT, departments, and saved campaign lists", async () => {
  const options = await listMemberEmailAudienceOptions(context(), {
    env: previewEnv,
    query: audienceQuery(async (sql) => {
      if (sql.includes("member-email:department-options")) {
        return [{ handle: "c".repeat(64), label: "Synthetic Services", people_count: 4 }];
      }
      if (sql.includes("member-email:campaign-options")) {
        return [{ handle: "d".repeat(64), label: "Synthetic list", people_count: 3 }];
      }
      return null;
    }),
  });
  assert.deepEqual(options.map((option) => option.key), [
    "members", "nonmembers", "represented_unit", "registered_users", "cat_members",
    `department:${"c".repeat(64)}`, `campaign:${"d".repeat(64)}`,
  ]);
  assert.deepEqual([...new Set(options.map((option) => option.group))], ["Membership", "Users", "CAT", "Departments", "Saved lists"]);
});

test("attachment options expose only opaque approved document choices", async () => {
  let parameters;
  const options = await listMemberEmailAttachmentOptions(context(), {
    env: previewEnv,
    query: async (sql, values) => {
      assert.match(sql, /document\.status = 'approved'/);
      assert.match(sql, /document\.organization_id = \$1::uuid/);
      assert.match(sql, /document\.visibility/);
      parameters = values;
      return [{
        document_id: documentId,
        handle: documentHandle,
        title: "Synthetic agenda",
        original_filename: "synthetic-agenda.pdf",
        media_type: "application/pdf",
        byte_size: 128,
        sha256: "f".repeat(64),
        display_order: 0,
      }];
    },
  });
  assert.deepEqual(options, [{
    handle: documentHandle,
    title: "Synthetic agenda",
    originalFilename: "synthetic-agenda.pdf",
    mediaType: "application/pdf",
    byteSize: 128,
  }]);
  assert.equal(parameters[0], organizationId);
  assert.doesNotMatch(JSON.stringify(options), new RegExp(documentId));
});

test("recipient preview rejects a non-synthetic address before creating a snapshot", async () => {
  const rows = audienceRows.map((row, index) => index === 0 ? { ...row, home_contact_value: "real@personal.example" } : row);
  await assert.rejects(previewMemberEmailAudience(context(), {
    env: previewEnv,
    keyConfig,
    query: audienceQuery(async (sql) => sql.includes("member-email:synthetic-audience") ? rows : null),
  }), (error) => error?.code === "NON_SYNTHETIC_RECIPIENT");
});

test("draft creation encrypts content and recipients and freezes only protected values", async () => {
  const captured = [];
  const transaction = async (callback) => callback(async (sql, parameters = []) => {
    captured.push({ sql, parameters });
    if (sql.includes("member-email:create-broadcast")) return [{ handle }];
    if (sql.includes("SELECT event_hash")) return [];
    if (sql.includes("INSERT INTO local801.audit_events")) return [{ audit_written: true }];
    return [];
  });
  const result = await createMemberEmailBroadcast(context(), {
    subject: "Synthetic member update",
    body: "This is a Preview-only message.",
  }, {
    env: previewEnv,
    keyConfig,
    query: audienceQuery(),
    transaction,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(result.handle, handle);
  assert.equal(result.audience.eligible, 3);
  const contentInsert = captured.find((call) => call.sql.includes("member_email_broadcast_content"));
  const recipientInsert = captured.find((call) => call.sql.includes("member-email:freeze-recipients"));
  assert.ok(contentInsert);
  assert.ok(recipientInsert);
  assert.doesNotMatch(JSON.stringify(contentInsert.parameters), /Synthetic member update|Preview-only message/);
  assert.doesNotMatch(JSON.stringify(recipientInsert.parameters), /@example\.test|avery|riley|shared\.household/i);
  assert.match(String(contentInsert.parameters[2]), /^p1\./);
  const frozenRecipients = JSON.parse(String(recipientInsert.parameters[2]));
  assert.equal(frozenRecipients.length, audienceRows.length);
  assert.equal(frozenRecipients[0].person_id, audienceRows[0].person_id);
  assert.equal(frozenRecipients[0].contact_method_id, audienceRows[0].home_contact_id);
  assert.equal(frozenRecipients[0].contact_kind, "home");
  assert.equal(frozenRecipients[0].personId, undefined);
});

test("draft creation freezes approved attachment metadata without exposing storage details", async () => {
  const captured = [];
  const transaction = async (callback) => callback(async (sql, parameters = []) => {
    captured.push({ sql, parameters });
    if (sql.includes("member-email:create-broadcast")) return [{ handle }];
    if (sql.includes("SELECT event_hash")) return [];
    if (sql.includes("INSERT INTO local801.audit_events")) return [{ audit_written: true }];
    return [];
  });
  await createMemberEmailBroadcast(context(), {
    subject: "Synthetic member update",
    body: "This is a Preview-only message.",
    attachmentHandles: [documentHandle],
  }, {
    env: previewEnv,
    keyConfig,
    query: audienceQuery(async (sql) => sql.includes("member-email:resolve-attachments") ? [{
      document_id: documentId,
      handle: documentHandle,
      title: "Synthetic agenda",
      original_filename: "synthetic-agenda.pdf",
      media_type: "application/pdf",
      byte_size: 128,
      sha256: "f".repeat(64),
      display_order: 0,
    }] : null),
    transaction,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const attachmentInsert = captured.find((call) => call.sql.includes("member-email:freeze-attachments"));
  assert.ok(attachmentInsert);
  const frozen = JSON.parse(String(attachmentInsert.parameters[2]));
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].document_id, documentId);
  assert.equal(frozen[0].original_filename, "synthetic-agenda.pdf");
  assert.doesNotMatch(JSON.stringify(attachmentInsert), /storage_key|encryption_key/i);
});

test("protected email preview restores the formatted body and frozen attachments", async () => {
  const preview = await getMemberEmailBroadcastPreview(context(), handle, {
    env: previewEnv,
    keyConfig,
    query: async (sql) => {
      if (sql.includes("member-email:preview-detail")) return [{
        ...realTestRow(),
        audience_kind: "members",
        audience_label: "All current members",
        audience_reference_handle: null,
        represented_count: 5,
        attachment_count: 1,
        real_test_sent_at: "2026-08-25T13:00:00.000Z",
      }];
      if (sql.includes("member-email:preview-attachments")) return [{
        document_id: documentId,
        handle: documentHandle,
        title: "Synthetic agenda",
        original_filename: "synthetic-agenda.pdf",
        media_type: "application/pdf",
        byte_size: 128,
        sha256: "f".repeat(64),
        display_order: 1,
      }];
      throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
    },
  });
  assert.equal(preview?.subject, "Synthetic member update");
  assert.match(preview?.html ?? "", /<strong>Preview-only<\/strong>/);
  assert.equal(preview?.realTestSentAt, "2026-08-25T13:00:00.000Z");
  assert.deepEqual(preview?.attachments, [{
    handle: documentHandle,
    title: "Synthetic agenda",
    originalFilename: "synthetic-agenda.pdf",
    mediaType: "application/pdf",
    byteSize: 128,
    available: true,
  }]);
});

test("the broadcast creator cannot approve their own reviewed draft", async () => {
  const row = {
    id: broadcastId,
    handle,
    status: "review",
    source_snapshot_id: snapshotId,
    snapshot_date: "2026-08-01",
    eligible_count: 3,
    missing_count: 1,
    duplicate_count: 1,
    suppressed_count: 0,
    scheduled_for: null,
    created_by: creatorId,
    approved_by: null,
    simulated_at: null,
    created_at: "2026-08-25T12:00:00.000Z",
    subject_encrypted_payload: "p1.placeholder.placeholder.placeholder",
    subject_encryption_key_version: "v1",
    subject_encryption_format_version: 1,
  };
  let writes = 0;
  const transaction = async (callback) => callback(async (sql) => {
    if (sql.includes("member-email:lock-broadcast")) return [row];
    writes += 1;
    return [];
  });
  await assert.rejects(approveMemberEmailBroadcast(context(), handle, {
    env: previewEnv,
    transaction,
  }), (error) => error?.code === "SEPARATE_APPROVER_REQUIRED");
  assert.equal(writes, 0);
});

test("only System Owner and Local Administrator receive the broadcast permission and navigation", async () => {
  const access = await import("../src/lib/access.ts");
  for (const role of Object.keys(access.roleLabels)) {
    const expected = role === "system_owner" || role === "local_admin";
    assert.equal(access.can(role, "sendMemberEmail"), expected);
    assert.equal(access.navForRole(role).some((item) => item.href === "/email-broadcasts"), expected);
  }
});

test("migrations and routes preserve protected authenticated boundaries across Preview and Production", () => {
  const migration = readFileSync(new URL("../db/migrations/0035__preview_member_email_broadcasts.sql", import.meta.url), "utf8");
  const audienceMigration = readFileSync(new URL("../db/migrations/0036__member_email_audience_selection.sql", import.meta.url), "utf8");
  const registeredUserMigration = readFileSync(new URL("../db/migrations/0037__registered_user_email_audience.sql", import.meta.url), "utf8");
  const attachmentMigration = readFileSync(new URL("../db/migrations/0038__member_email_document_attachments.sql", import.meta.url), "utf8");
  const productionMigration = readFileSync(new URL("../db/migrations/0039__production_member_email_delivery.sql", import.meta.url), "utf8");
  const runtimePrivilegeMigration = readFileSync(new URL("../db/migrations/0046__member_email_runtime_privileges.sql", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/email-broadcasts/page.tsx", import.meta.url), "utf8");
  const previewPage = readFileSync(new URL("../src/app/email-broadcasts/[handle]/page.tsx", import.meta.url), "utf8");
  const http = readFileSync(new URL("../src/lib/member-email-http.ts", import.meta.url), "utf8");
  const production = readFileSync(new URL("../src/lib/member-email-production.ts", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../src/workflows/deliver-member-email.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../src/app/api/webhooks/resend/route.ts", import.meta.url), "utf8");
  assert.match(migration, /email_encrypted_payload/);
  assert.match(migration, /email_blind_index/);
  assert.doesNotMatch(migration, /\bemail_address\b|\brecipient_email\b/i);
  assert.match(audienceMigration, /audience_kind/);
  assert.match(audienceMigration, /user_id uuid references local801\.users/);
  assert.match(audienceMigration, /member_email_recipients_subject_ck/);
  assert.match(registeredUserMigration, /registered_users/);
  assert.match(attachmentMigration, /member_email_broadcast_attachments/);
  assert.match(attachmentMigration, /document_id uuid references local801\.documents\(id\) on delete set null/);
  assert.doesNotMatch(attachmentMigration, /storage_key|encrypted_payload/);
  assert.match(productionMigration, /provider_message_id/);
  assert.match(productionMigration, /delivery_status/);
  assert.match(productionMigration, /member_email_templates/);
  assert.doesNotMatch(productionMigration, /recipient_email|email_address/i);
  assert.match(runtimePrivilegeMigration, /revoke all on table[\s\S]*member_email_broadcasts[\s\S]*from public/i);
  assert.match(runtimePrivilegeMigration, /grant select, insert, update on table local801\.member_email_broadcasts to local801_app/i);
  assert.match(runtimePrivilegeMigration, /grant select, insert on table local801\.member_email_broadcast_content to local801_app/i);
  assert.match(runtimePrivilegeMigration, /grant select, insert, update on table local801\.member_email_broadcast_recipients to local801_app/i);
  assert.match(runtimePrivilegeMigration, /grant select, insert on table local801\.member_email_broadcast_attachments to local801_app/i);
  assert.match(runtimePrivilegeMigration, /grant select, insert on table local801\.member_email_delivery_events to local801_app/i);
  assert.match(runtimePrivilegeMigration, /grant select, insert on table local801\.member_email_templates to local801_app/i);
  assert.doesNotMatch(runtimePrivilegeMigration, /grant\s+all|grant[^;]*delete/i);
  assert.match(page, /memberEmailRuntimeEnabled\(\)/);
  assert.match(page, /permission="sendMemberEmail"/);
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /local801-member-email-safe-failure/);
  assert.match(page, /safeProductionAuthInternalFailure/);
  assert.match(previewPage, /getMemberEmailBroadcastPreview/);
  assert.match(previewPage, /permission="sendMemberEmail"/);
  assert.match(http, /requirePreviewUser\("sendMemberEmail"\)/);
  assert.match(http, /memberEmailRuntimeEnabled\(\)/);
  assert.match(http, /hasExactSameOrigin/);
  assert.match(production, /maxRecipients: 1000|1,000 eligible recipients/);
  assert.match(production, /resend\.batch\.send/);
  assert.match(production, /idempotencyKey/);
  assert.match(production, /memberEmailProductionBoundary\(\)/);
  assert.match(production, /delivery_status='pending'/);
  assert.match(workflow, /"use workflow"/);
  assert.match(workflow, /directive === "paused"/);
  assert.match(webhook, /applyResendWebhook/);
  assert.match(webhook, /svix-signature/);
});
