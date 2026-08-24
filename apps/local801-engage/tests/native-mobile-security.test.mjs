import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getMobileDeviceConfiguration,
  issueMobileAttestationChallenge,
  MobileDeviceError,
  registerAttestedMobileDevice,
} from "../src/lib/mobile-device-trust.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const challengeId = "10000000-0000-4000-8000-000000000003";
const deviceId = "10000000-0000-4000-8000-000000000004";
const context = { organizationId, userId, role: "cat_member" };

function mobileEnv(overrides = {}) {
  return {
    LOCAL801_NATIVE_MOBILE_ENABLED: "1",
    LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL: "https://attest.cyang.io",
    LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX: "a".repeat(64),
    LOCAL801_MOBILE_PUSH_GATEWAY_URL: "https://push.cyang.io",
    LOCAL801_MOBILE_PUSH_HMAC_SECRET_HEX: "b".repeat(64),
    LOCAL801_APPLE_TEAM_ID: "A1B2C3D4E5",
    LOCAL801_ANDROID_CLOUD_PROJECT_NUMBER: "123456789012",
    ...overrides,
  };
}

test("native mobile configuration accepts only owner-controlled canonical gateways", () => {
  assert.equal(getMobileDeviceConfiguration(mobileEnv()).enabled, true);
  for (const env of [
    mobileEnv({ LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL: "https://attacker.example.test" }),
    mobileEnv({ LOCAL801_MOBILE_PUSH_GATEWAY_URL: "http://push.cyang.io" }),
    mobileEnv({ LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX: "weak" }),
    mobileEnv({ LOCAL801_APPLE_TEAM_ID: "invalid" }),
  ]) assert.equal(getMobileDeviceConfiguration(env).enabled, false);
});

test("attestation challenges store only a digest and expire after five minutes", async () => {
  let statement;
  const issued = await issueMobileAttestationChallenge(context, {
    env: mobileEnv(), id: () => challengeId, now: () => new Date("2026-08-18T12:00:00.000Z"),
    challenge: () => Buffer.alloc(32, 7),
    query: async (sql, parameters) => { statement = { sql, parameters }; return [{ id: challengeId }]; },
  });
  assert.equal(issued.challengeHandle, challengeId);
  assert.equal(issued.expiresAt, "2026-08-18T12:05:00.000Z");
  assert.match(statement.sql, /challenge_hash/);
  assert.equal(statement.parameters.includes(issued.challenge), false);
  assert.match(statement.parameters[3], /^[0-9a-f]{64}$/);
});

test("verified native registration consumes the exact challenge and stores only a device-key digest", async () => {
  const challenge = Buffer.alloc(32, 8).toString("base64url");
  const queries = []; let verifiedInput;
  const result = await registerAttestedMobileDevice(context, {
    challengeHandle: challengeId, challenge, platform: "android", evidence: "e".repeat(64),
    evidenceKind: "play_integrity", keyId: "k".repeat(32),
  }, {
    env: mobileEnv(), id: () => deviceId,
    verify: async (input) => { verifiedInput = input; return { valid: true, deviceKey: "verified-device-key-000000000000", integrityLevel: "strong_integrity" }; },
    transaction: async (callback) => callback(async (sql, parameters) => {
      queries.push({ sql, parameters });
      if (sql.includes("FROM local801.mobile_attestation_challenges")) return [{ id: challengeId }];
      if (sql.includes("INSERT INTO local801.mobile_devices")) return [{ id: deviceId }];
      if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
      return [];
    }),
  });
  assert.equal(verifiedInput.evidenceKind, "play_integrity");
  assert.equal(result.integrityLevel, "strong_integrity");
  const insert = queries.find(({ sql }) => sql.includes("INSERT INTO local801.mobile_devices"));
  assert.match(insert.parameters[4], /^[0-9a-f]{64}$/);
  assert.equal(insert.parameters.includes("verified-device-key-000000000000"), false);
  assert.equal(queries.some(({ sql }) => sql.includes("used_at = now()")), true);
  assert.equal(queries.some(({ sql }) => sql.includes("session.mobile_device_attested")), false);
  assert.equal(queries.some(({ sql }) => sql.includes("INSERT INTO local801.audit_events")), true);
});

test("platform/evidence mismatches and stale challenges fail closed before device persistence", async () => {
  await assert.rejects(() => registerAttestedMobileDevice(context, {
    challengeHandle: challengeId, challenge: Buffer.alloc(32, 8).toString("base64url"), platform: "ios",
    evidence: "e".repeat(64), evidenceKind: "play_integrity", keyId: "k".repeat(32),
  }, { env: mobileEnv() }), (error) => error instanceof MobileDeviceError && error.code === "INVALID_ATTESTATION");

  let inserted = false;
  await assert.rejects(() => registerAttestedMobileDevice(context, {
    challengeHandle: challengeId, challenge: Buffer.alloc(32, 8).toString("base64url"), platform: "ios",
    evidence: "e".repeat(64), evidenceKind: "app_attest", keyId: "k".repeat(32),
  }, {
    env: mobileEnv(), verify: async () => ({ valid: true, deviceKey: "verified-device-key-000000000000", integrityLevel: "app_attested" }),
    transaction: async (callback) => callback(async (sql) => { if (sql.includes("INSERT INTO local801.mobile_devices")) inserted = true; return []; }),
  }), (error) => error instanceof MobileDeviceError && error.code === "CHALLENGE_STALE");
  assert.equal(inserted, false);
});

test("native shells implement device-only features without a protected offline record store", () => {
  const android = readFileSync(new URL("../android/app/src/main/java/io/cyang/local801/engage/Local801NativePlugin.java", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../android/app/src/main/java/io/cyang/local801/engage/Local801UploadWorker.java", import.meta.url), "utf8");
  const ios = readFileSync(new URL("../ios/App/App/Local801NativePlugin.swift", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/lib/native-mobile.ts", import.meta.url), "utf8");
  const notificationRouter = readFileSync(new URL("../src/components/NativeNotificationRouter.tsx", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../db/migrations/0027__native_mobile_security_and_delivery.sql", import.meta.url), "utf8");
  assert.match(android, /IntegrityManagerFactory/); assert.match(android, /BiometricPrompt/); assert.match(android, /GmsBarcodeScanning/);
  assert.match(android, /getNoBackupFilesDir/); assert.match(worker, /AES\/GCM\/NoPadding/); assert.match(worker, /https:\/\/cat\.cyang\.io\/api\/documents\/upload/);
  assert.match(ios, /DCAppAttestService/); assert.match(ios, /VNDocumentCameraViewController/); assert.match(ios, /completeFileProtection/);
  assert.match(client, /queueBackgroundUpload/); assert.doesNotMatch(client, /localStorage|indexedDB|sessionStorage/);
  assert.match(notificationRouter, /pushNotificationActionPerformed/); assert.match(notificationRouter, /actionId === "later"/);
  assert.match(migration, /challenge_hash text not null/); assert.match(migration, /push_token_encrypted_payload/);
  assert.doesNotMatch(migration, /push_token\s+text|device_key\s+text|member_record/);
});

test("native shells remain compatible with the supported Capacitor and OS versions", () => {
  const activity = readFileSync(new URL("../android/app/src/main/java/io/cyang/local801/engage/MainActivity.java", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../ios/App/App/Local801NativePlugin.swift", import.meta.url), "utf8");
  const sceneDelegate = readFileSync(new URL("../ios/App/App/SceneDelegate.swift", import.meta.url), "utf8");

  assert.match(activity, /public void onStart\(\)/);
  assert.match(activity, /public void onStop\(\)/);
  assert.doesNotMatch(activity, /protected void on(?:Start|Stop)\(\)/);
  assert.match(plugin, /if #available\(iOS 16\.0, \*\)/);
  assert.match(sceneDelegate, /ApplicationDelegateProxy\.shared\.application/);
  assert.doesNotMatch(sceneDelegate, /SceneDelegateProxy/);
});
