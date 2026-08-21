import assert from "node:assert/strict";
import test from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getAppConfig, getDatabaseConfig, getEncryptionConfig } from "../src/lib/config.ts";
import { decryptEnvelope, encryptData } from "../src/lib/encryption.ts";
import {
  assertSafeStorageKey,
  checkStorageReadiness,
  deleteObject,
  encryptedObjectSizeLimit,
  generateStorageKey,
  getObject,
  headObject,
  putObject,
  setR2ClientFactoryForTests,
} from "../src/lib/r2.ts";
import { normalizeOriginalFilename } from "../src/lib/document-storage.ts";
import { assertSyntheticSeedAllowed } from "../scripts/seed-guards.mjs";

const originalEnv = { ...process.env };
const key = (fill) => Buffer.alloc(32, fill).toString("base64");
const encryptionEnv = (activeVersion = "v1", keys = { v1: key(1) }) => ({
  ...originalEnv,
  LOCAL801_ENCRYPTION_MASTER_KEYS: JSON.stringify(keys),
  LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: activeVersion,
});

test.afterEach(() => {
  process.env = { ...originalEnv };
  setR2ClientFactoryForTests(null);
});

test("Local 801 import size defaults to the scanner's exact 20 MiB limit", () => {
  const env = { ...originalEnv };
  delete env.LOCAL801_IMPORT_MAX_BYTES;
  assert.equal(getAppConfig(env).LOCAL801_IMPORT_MAX_BYTES, 20 * 1024 * 1024);
});

test("database config refuses missing LOCAL801_DATABASE_URL and never falls back to DATABASE_URL", () => {
  const env = { ...originalEnv, DATABASE_URL: "postgres://doclinks.invalid/database" };
  delete env.LOCAL801_DATABASE_URL;
  assert.throws(() => getDatabaseConfig(env), /LOCAL801_DATABASE_URL is required/);
});

test("encryption round trips and ciphertext differs from plaintext", () => {
  const env = encryptionEnv();
  const plaintext = Buffer.from("hello synthetic preview");
  const encrypted = encryptData(plaintext, env);
  assert.notDeepEqual(encrypted, plaintext);
  assert.equal(encrypted.includes(plaintext), false);
  assert.equal(decryptEnvelope(encrypted, env).plaintext.toString("utf8"), plaintext.toString("utf8"));
});

test("encryption rejects the wrong key", () => {
  const encrypted = encryptData(Buffer.from("synthetic"), encryptionEnv());
  assert.throws(
    () => decryptEnvelope(encrypted, encryptionEnv("v1", { v1: key(9) })),
    /authentication failed/,
  );
});

test("encryption rejects ciphertext tampering", () => {
  const env = encryptionEnv();
  const envelope = JSON.parse(encryptData(Buffer.from("synthetic"), env).toString("utf8"));
  envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
  assert.throws(() => decryptEnvelope(Buffer.from(JSON.stringify(envelope)), env), /authentication failed/);
});

test("encryption rejects an unknown key version", () => {
  const env = encryptionEnv();
  const envelope = JSON.parse(encryptData(Buffer.from("synthetic"), env).toString("utf8"));
  envelope.keyVersion = "v404";
  assert.throws(() => decryptEnvelope(Buffer.from(JSON.stringify(envelope)), env), /Unknown encryption key version/);
});

test("new ciphertext uses the active key and old keys continue to decrypt after rotation", () => {
  const beforeRotation = encryptionEnv("v1", { v1: key(1) });
  const oldPayload = encryptData(Buffer.from("old"), beforeRotation);
  const afterRotation = encryptionEnv("v2", { v1: key(1), v2: key(2) });
  const newPayload = encryptData(Buffer.from("new"), afterRotation);
  assert.equal(decryptEnvelope(newPayload, afterRotation).keyVersion, "v2");
  assert.equal(decryptEnvelope(oldPayload, afterRotation).plaintext.toString("utf8"), "old");
});

test("encryption environment rejects malformed, duplicate, missing-active, and wrong-length keys", () => {
  assert.throws(
    () => getEncryptionConfig({ ...originalEnv, LOCAL801_ENCRYPTION_MASTER_KEYS: "not-json", LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: "v1" }),
    /valid JSON/,
  );
  assert.throws(
    () => getEncryptionConfig({ ...originalEnv, LOCAL801_ENCRYPTION_MASTER_KEYS: `{"v1":"${key(1)}","v1":"${key(2)}"}`, LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: "v1" }),
    /duplicate key version/,
  );
  assert.throws(() => getEncryptionConfig(encryptionEnv("v2")), /must match an entry/);
  assert.throws(
    () => getEncryptionConfig(encryptionEnv("v1", { v1: Buffer.alloc(31).toString("base64") })),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => getEncryptionConfig(encryptionEnv("v1:unsafe", { "v1:unsafe": key(1) })),
    /key versions must use/,
  );
});

test("storage keys are generated independently of filenames and reject traversal", () => {
  const storageKey = generateStorageKey(
    "documents",
    "35e10e0e-e82c-4b7e-9d18-726f4ebef649",
    new Date("2026-08-11T00:00:00.000Z"),
  );
  assert.equal(storageKey, "local801/documents/2026/08/35e10e0e-e82c-4b7e-9d18-726f4ebef649");
  assert.equal(normalizeOriginalFilename("../../synthetic-roster.xlsx"), "synthetic-roster.xlsx");
  assert.equal(storageKey.includes("synthetic-roster.xlsx"), false);
  assert.throws(() => assertSafeStorageKey("../../doclinks/secret"), /Invalid Local 801 storage key/);
  assert.throws(() => generateStorageKey("../../doclinks"), /Invalid Local 801 storage kind/);
});

test("R2 readiness and writes use the private bucket with an opaque content type", async () => {
  process.env.LOCAL801_R2_ACCOUNT_ID = "abc123";
  process.env.LOCAL801_R2_ENDPOINT = "https://abc123.r2.cloudflarestorage.com";
  process.env.LOCAL801_R2_BUCKET = "local801-private";
  process.env.LOCAL801_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.LOCAL801_R2_SECRET_ACCESS_KEY = "test-secret-key";
  const commands = [];
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      commands.push(command);
      return {};
    },
  }));

  assert.deepEqual(await checkStorageReadiness(), { storage: "ok" });
  const storageKey = generateStorageKey("imports");
  await putObject(storageKey, Buffer.from("ciphertext-only"));

  assert.equal(commands[0] instanceof HeadBucketCommand, true);
  assert.equal(commands[0].input.Bucket, "local801-private");
  assert.equal(commands[1] instanceof PutObjectCommand, true);
  assert.equal(commands[1].input.Key, storageKey);
  assert.equal(commands[1].input.ContentType, "application/octet-stream");
});

test("R2 get, head, and delete operations are mockable without live credentials", async () => {
  process.env.LOCAL801_R2_ACCOUNT_ID = "abc123";
  process.env.LOCAL801_R2_ENDPOINT = "https://abc123.r2.cloudflarestorage.com";
  process.env.LOCAL801_R2_BUCKET = "local801-private";
  process.env.LOCAL801_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.LOCAL801_R2_SECRET_ACCESS_KEY = "test-secret-key";
  const commands = [];
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      commands.push(command);
      if (command instanceof GetObjectCommand) return { Body: Uint8Array.from([1, 2, 3]) };
      if (command instanceof HeadObjectCommand) return { ContentLength: 3 };
      return {};
    },
  }));
  const storageKey = generateStorageKey("reports");

  assert.deepEqual((await getObject(storageKey)).body, Buffer.from([1, 2, 3]));
  assert.deepEqual(await headObject(storageKey), { exists: true, contentLength: 3 });
  assert.deepEqual(await deleteObject(storageKey), { deleted: true, storageKey });
  assert.equal(commands[0] instanceof GetObjectCommand, true);
  assert.equal(commands[1] instanceof HeadObjectCommand, true);
  assert.equal(commands[2] instanceof DeleteObjectCommand, true);
});

test("R2 retrieval rejects an oversized encrypted object before buffering it", async () => {
  process.env.LOCAL801_IMPORT_MAX_BYTES = "3";
  process.env.LOCAL801_R2_ACCOUNT_ID = "abc123";
  process.env.LOCAL801_R2_ENDPOINT = "https://abc123.r2.cloudflarestorage.com";
  process.env.LOCAL801_R2_BUCKET = "local801-private";
  process.env.LOCAL801_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.LOCAL801_R2_SECRET_ACCESS_KEY = "test-secret-key";
  const maximumBytes = encryptedObjectSizeLimit(3);
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      assert.equal(command instanceof GetObjectCommand, true);
      return { Body: Buffer.alloc(maximumBytes + 1) };
    },
  }));

  await assert.rejects(
    getObject(generateStorageKey("documents")),
    /exceeds the configured size limit/,
  );
});

test("R2 streaming retrieval stops when cumulative chunks exceed the encrypted-object limit", async () => {
  process.env.LOCAL801_IMPORT_MAX_BYTES = "3";
  process.env.LOCAL801_R2_ACCOUNT_ID = "abc123";
  process.env.LOCAL801_R2_ENDPOINT = "https://abc123.r2.cloudflarestorage.com";
  process.env.LOCAL801_R2_BUCKET = "local801-private";
  process.env.LOCAL801_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.LOCAL801_R2_SECRET_ACCESS_KEY = "test-secret-key";
  let yieldedChunks = 0;
  async function* oversizedBody() {
    yieldedChunks += 1;
    yield Buffer.alloc(1024);
    yieldedChunks += 1;
    yield Buffer.alloc(1029);
    yieldedChunks += 1;
    yield Buffer.alloc(1);
  }
  setR2ClientFactoryForTests(() => ({
    async send() {
      return { Body: oversizedBody() };
    },
  }));

  await assert.rejects(
    getObject(generateStorageKey("documents")),
    /exceeds the configured size limit/,
  );
  assert.equal(yieldedChunks, 2);
});

test("R2 arrayBuffer fallback fails closed without a validated ContentLength", async () => {
  process.env.LOCAL801_R2_ACCOUNT_ID = "abc123";
  process.env.LOCAL801_R2_ENDPOINT = "https://abc123.r2.cloudflarestorage.com";
  process.env.LOCAL801_R2_BUCKET = "local801-private";
  process.env.LOCAL801_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.LOCAL801_R2_SECRET_ACCESS_KEY = "test-secret-key";
  let arrayBufferCalls = 0;
  setR2ClientFactoryForTests(() => ({
    async send() {
      return {
        Body: {
          async arrayBuffer() {
            arrayBufferCalls += 1;
            return new ArrayBuffer(1);
          },
        },
      };
    },
  }));

  await assert.rejects(
    getObject(generateStorageKey("documents")),
    /cannot be safely bounded/,
  );
  assert.equal(arrayBufferCalls, 0);
});

test("synthetic seed refuses production and requires explicit opt-in", () => {
  assert.throws(
    () => assertSyntheticSeedAllowed({ NODE_ENV: "production", LOCAL801_ALLOW_SYNTHETIC_SEED: "1", LOCAL801_DATABASE_URL: "postgres://synthetic" }),
    /NODE_ENV=production/,
  );
  assert.throws(
    () => assertSyntheticSeedAllowed({ VERCEL_ENV: "production", LOCAL801_ALLOW_SYNTHETIC_SEED: "1", LOCAL801_DATABASE_URL: "postgres://synthetic" }),
    /VERCEL_ENV=production/,
  );
  assert.throws(
    () => assertSyntheticSeedAllowed({ LOCAL801_DATABASE_URL: "postgres://synthetic" }),
    /LOCAL801_ALLOW_SYNTHETIC_SEED=1/,
  );
  assert.throws(
    () => assertSyntheticSeedAllowed({ DATABASE_URL: "postgres://doclinks", LOCAL801_ALLOW_SYNTHETIC_SEED: "1" }),
    /LOCAL801_DATABASE_URL is required/,
  );
});
