import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { linkCampaignToCatAction } from "../src/lib/campaign-cat-links.ts";
import { setDocumentTags } from "../src/lib/document-metadata.ts";
import { cancelImportProcessing } from "../src/lib/import-operator-controls.ts";
import { getPushConfiguration, savePushSubscription, __testing as pushTesting } from "../src/lib/push-notifications.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const campaignId = "00000000-0000-4000-8000-000000000003";
const actionId = "00000000-0000-4000-8000-000000000004";
const documentId = "00000000-0000-4000-8000-000000000005";
const batchId = "00000000-0000-4000-8000-000000000006";
const handle = "a".repeat(64);
const context = { organizationId, userId, role: "local_admin" };
const auditStatement = { sql: "INSERT INTO local801.audit_events DEFAULT VALUES" };

test("campaign-to-CAT Action links resolve opaque same-tenant targets and audit atomically", async () => {
  let statements;
  const result = await linkCampaignToCatAction(context, { campaignHandle: handle, actionHandle: "b".repeat(64) }, {
    query: async () => [{ campaign_id: campaignId, action_id: actionId }],
    prepareAudit: async () => auditStatement,
    runTransaction: async (value) => { statements = value; },
  });
  assert.deepEqual(result, { linked: true });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /campaign_cat_action_links/);
  assert.match(statements[0].sql, /workspace_user_roles/);
  assert.deepEqual(statements[0].parameters, [organizationId, campaignId, actionId, userId]);
  assert.equal(statements[1], auditStatement);
});

test("document tags are bounded metadata and save in the same transaction as audit", async () => {
  let statements;
  await setDocumentTags(context, { documentHandle: handle, tags: ["Contract", "Training"] }, {
    query: async () => [{ id: documentId, title: "Synthetic document", visibility: "local_admin_only" }],
    prepareAudit: async () => auditStatement,
    runTransaction: async (value) => { statements = value; },
  });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /document_tag_assignments/);
  assert.equal(statements[0].parameters[3], '["Contract","Training"]');
  await assert.rejects(() => setDocumentTags(context, { documentHandle: handle, tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`) }, { query: async () => [] }), /no more than eight/i);
});

test("running import cancellation records a cooperative request and never marks the batch cancelled early", async () => {
  let statements;
  const result = await cancelImportProcessing({ ...context, role: "membership_data_manager" }, { batchId, reason: "incorrect_source" }, {
    query: async () => [{ state: "running" }],
    prepareAudit: async () => auditStatement,
    runTransaction: async (value) => { statements = value; },
  });
  assert.deepEqual(result, { cancellationRequested: true, immediate: false });
  assert.match(statements[0].sql, /CASE WHEN job\.state = 'queued' THEN 'cancelled'/);
  assert.match(statements[0].sql, /changed_job\.state = 'cancelled'/);
  assert.deepEqual(statements[0].parameters.slice(0, 4), [organizationId, batchId, "local801-import-v1", userId]);
});

test("push subscriptions are strictly validated, generic, no-store, and legacy writes remain atomic", async () => {
  const subscription = { endpoint: "https://push.example.test/subscription/123", expirationTime: null, keys: { p256dh: "A".repeat(65), auth: "B".repeat(22) } };
  assert.equal(pushTesting.parseSubscription(subscription).endpoint, subscription.endpoint);
  assert.throws(() => pushTesting.parseSubscription({ endpoint: "http://unsafe.test", keys: {} }), /invalid/i);
  let statements;
  const result = await savePushSubscription(context, subscription, {
    env: {}, id: () => documentId, query: async () => [], transaction: async (value) => { statements = value; },
  });
  assert.equal(result.subscribed, true);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /workspace_user_roles/);
  assert.doesNotMatch(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), /event\.data\.(json|text)/);
  assert.match(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), /You have an Engaging Local 801 update/);
  assert.deepEqual(getPushConfiguration({ LOCAL801_PUSH_ENABLED: "0" }), { enabled: false, publicKey: "", privateKey: "", subject: "" });
});

test("native projects exist without protected offline-storage plugins", () => {
  const capacitor = readFileSync(new URL("../capacitor.config.ts", import.meta.url), "utf8");
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const androidManifest = readFileSync(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  const androidActivity = readFileSync(new URL("../android/app/src/main/java/io/cyang/local801/engage/MainActivity.java", import.meta.url), "utf8");
  const iosDelegate = readFileSync(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8");
  assert.match(capacitor, /cleartext: false/);
  assert.match(capacitor, /webContentsDebuggingEnabled: false/);
  assert.match(packageJson, /@capacitor\/android/);
  assert.match(packageJson, /@capacitor\/ios/);
  assert.doesNotMatch(packageJson, /capacitor-community\/(?:sqlite|secure-storage)|@capacitor\/filesystem/);
  assert.doesNotMatch(serviceWorker, /indexedDB|localStorage|sessionStorage/);
  assert.match(serviceWorker, /isStaticAsset/);
  assert.match(androidManifest, /android:allowBackup="false"/);
  assert.match(androidManifest, /android:usesCleartextTraffic="false"/);
  assert.match(androidActivity, /WebSettings\.LOAD_NO_CACHE/);
  assert.match(iosDelegate, /WKWebsiteDataTypeDiskCache/);
});

test("migration 0021 uses tenant-qualified foreign keys and explicit cancellation invariants", () => {
  const migration = readFileSync(new URL("../db/migrations/0026__feature_complete_relationships_and_operator_controls.sql", import.meta.url), "utf8");
  assert.match(migration, /campaign_cat_action_links/);
  assert.match(migration, /foreign key \(organization_id, campaign_id\)/i);
  assert.match(migration, /document_tag_assignments/);
  assert.match(migration, /num_nonnulls\(related_document_id, campaign_id, cat_action_id\) = 1/);
  assert.match(migration, /cancellation_requested_at/);
  assert.match(migration, /create table local801\.push_delivery_state/);
  assert.match(migration, /last_work_digest text not null/);
  assert.match(migration, /state in \('queued', 'running', 'succeeded', 'failed', 'cancelled'\)/);
});
