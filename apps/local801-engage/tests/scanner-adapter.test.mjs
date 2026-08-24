import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImportScannerAuthentication } from "../src/lib/import-scanner.ts";
import {
  authorizeScannerRequest,
  createScannerAdapterServer,
  createScannerSecurityState,
  readScannerAdapterConfig,
  scanWithClamd,
} from "../ops/local801-cat-scanner/server.mjs";

const secret = Buffer.alloc(32, 9);

function adapterConfig(overrides = {}) {
  return {
    bindHost: "127.0.0.1",
    port: 8089,
    allowedHost: "scan.cyang.io",
    clientId: "local801-production",
    hmacSecret: secret,
    clamdHost: "127.0.0.1",
    clamdPort: 3310,
    maximumBytes: 20 * 1024 * 1024,
    timestampSkewSeconds: 300,
    nonceTtlSeconds: 600,
    rateLimitPerMinute: 60,
    maximumConcurrent: 4,
    clamdTimeoutMs: 8000,
    ...overrides,
  };
}

function signedHeaders(body, {
  timestamp = "1787160000",
  nonce = "1".repeat(32),
  clientId = "local801-production",
  hmacSecret = secret,
} = {}) {
  const auth = createImportScannerAuthentication({
    content: body,
    clientId,
    hmacSecret,
    timestamp,
    nonce,
  });
  return {
    "x-scanner-client-id": clientId,
    "x-scanner-timestamp": timestamp,
    "x-scanner-nonce": nonce,
    "x-scanner-content-sha256": auth.bodyHash,
    "x-scanner-signature": auth.signature,
  };
}

function send(server, body, headers = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/v1/scan",
      headers: {
        Host: "scan.cyang.io",
        "Content-Type": "application/octet-stream",
        "Content-Length": body.byteLength,
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("scanner systemd hardening remains compatible with the Node runtime", () => {
  const unit = readFileSync(new URL("../ops/local801-cat-scanner/local801-cat-scanner.service", import.meta.url), "utf8");
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/local801-cat-scanner\/server\.mjs$/m);
  assert.match(unit, /^MemoryDenyWriteExecute=false$/m);
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute=true$/m);
  assert.match(unit, /^IPAddressDeny=any$/m);
  assert.match(unit, /^IPAddressAllow=localhost$/m);
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("scanner adapter configuration requires loopback, bounded limits, and a 32-byte HMAC key", () => {
  const config = readScannerAdapterConfig({
    LOCAL801_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_SCANNER_HMAC_SECRET_HEX: secret.toString("hex"),
  });
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.maximumBytes, 20 * 1024 * 1024);
  assert.deepEqual([...config.clientSecrets.keys()], ["local801-production"]);
  assert.throws(() => readScannerAdapterConfig({
    LOCAL801_SCANNER_BIND_HOST: "0.0.0.0",
    LOCAL801_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_SCANNER_HMAC_SECRET_HEX: secret.toString("hex"),
  }), /loopback/);
  assert.throws(() => readScannerAdapterConfig({
    LOCAL801_SCANNER_ALLOWED_HOST: "example.test",
    LOCAL801_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_SCANNER_HMAC_SECRET_HEX: secret.toString("hex"),
  }), /scan\.cyang\.io/);
  assert.throws(() => readScannerAdapterConfig({
    LOCAL801_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_SCANNER_HMAC_SECRET_HEX: "abcd",
  }), /authentication/);
  assert.throws(() => readScannerAdapterConfig({
    LOCAL801_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_SCANNER_HMAC_SECRET_HEX: secret.toString("hex"),
    LOCAL801_SCANNER_PREVIEW_HMAC_SECRET_HEX: "abcd",
  }), /authentication/);
});

test("scanner accepts an isolated Preview client without sharing the Production key", () => {
  const previewSecret = Buffer.alloc(32, 7);
  const config = readScannerAdapterConfig({
    LOCAL801_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_SCANNER_HMAC_SECRET_HEX: secret.toString("hex"),
    LOCAL801_SCANNER_PREVIEW_HMAC_SECRET_HEX: previewSecret.toString("hex"),
  });
  const body = Buffer.from("strictly synthetic Preview scanner body", "utf8");
  const now = 1_787_160_000_000;
  const previewHeaders = signedHeaders(body, {
    clientId: "local801-preview",
    hmacSecret: previewSecret,
  });
  assert.deepEqual(authorizeScannerRequest({
    headers: previewHeaders,
    body,
    config,
    state: createScannerSecurityState(),
    now,
  }), { ok: true });
  assert.equal(authorizeScannerRequest({
    headers: signedHeaders(body, { clientId: "local801-preview", hmacSecret: secret }),
    body,
    config,
    state: createScannerSecurityState(),
    now,
  }).status, 401);
});

test("scanner authentication enforces body binding, timestamp skew, replay protection, and rate limits", () => {
  const body = Buffer.from("synthetic scanner body", "utf8");
  const now = 1_787_160_000_000;
  const config = adapterConfig({ rateLimitPerMinute: 1 });
  const state = createScannerSecurityState();
  const headers = signedHeaders(body);
  assert.deepEqual(authorizeScannerRequest({ headers, body, config, state, now }), { ok: true });
  assert.equal(authorizeScannerRequest({ headers, body, config, state, now }).status, 401);

  const tampered = Buffer.from("tampered", "utf8");
  assert.equal(authorizeScannerRequest({
    headers: signedHeaders(body, { nonce: "2".repeat(32) }), body: tampered, config,
    state: createScannerSecurityState(), now,
  }).status, 401);
  assert.equal(authorizeScannerRequest({
    headers: signedHeaders(body, { timestamp: "1787159000", nonce: "3".repeat(32) }), body, config,
    state: createScannerSecurityState(), now,
  }).status, 401);
  assert.equal(authorizeScannerRequest({
    headers: signedHeaders(body, { nonce: "4".repeat(32) }), body, config, state, now,
  }).status, 429);

  const unavailableState = createScannerSecurityState();
  unavailableState.persist = () => { throw new Error("synthetic state failure"); };
  const unavailable = authorizeScannerRequest({
    headers: signedHeaders(body, { nonce: "5".repeat(32) }), body,
    config: adapterConfig(), state: unavailableState, now,
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailableState.nonces.size, 0);
  assert.equal(unavailableState.requestTimes.length, 0);
});

test("scanner replay and rate state survives service restart without storing request material", () => {
  const directory = mkdtempSync(join(tmpdir(), "local801-scanner-"));
  const path = join(directory, "nonces.json");
  const body = Buffer.from("synthetic scanner body", "utf8");
  const now = 1_787_160_000_000;
  try {
    let state = createScannerSecurityState({ path });
    const headers = signedHeaders(body);
    assert.deepEqual(authorizeScannerRequest({ headers, body, config: adapterConfig(), state, now }), { ok: true });
    const persisted = readFileSync(path, "utf8");
    assert.doesNotMatch(persisted, /synthetic scanner body|x-scanner|local801-production/i);

    state = createScannerSecurityState({ path });
    assert.equal(authorizeScannerRequest({ headers, body, config: adapterConfig(), state, now }).status, 401);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanner HTTP adapter returns the narrow clean/infected contract and fails closed", async () => {
  const body = Buffer.from("synthetic scanner body", "utf8");
  const now = 1_787_160_000_000;
  const verdicts = [
    { status: "clean" },
    { status: "infected", signature: "Synthetic-Test-Signature" },
    new Error("synthetic unavailable"),
  ];
  const events = [];
  const server = createScannerAdapterServer(adapterConfig(), {
    now: () => now,
    logger: (event) => events.push(event),
    scan: async () => {
      const next = verdicts.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  await listen(server);
  try {
    let response = await send(server, body, signedHeaders(body));
    assert.deepEqual(response, { status: 200, body: { status: "clean", bytes: body.byteLength } });
    response = await send(server, body, signedHeaders(body, { nonce: "2".repeat(32) }));
    assert.deepEqual(response, {
      status: 200,
      body: { status: "infected", signature: "Synthetic-Test-Signature", bytes: body.byteLength },
    });
    response = await send(server, body, signedHeaders(body, { nonce: "3".repeat(32) }));
    assert.deepEqual(response, { status: 503, body: { status: "unavailable" } });
    response = await send(server, body, { ...signedHeaders(body, { nonce: "4".repeat(32) }),
      "x-scanner-signature": "0".repeat(64) });
    assert.equal(response.status, 401);
    assert.deepEqual(events.map((event) => event.outcome), ["clean", "infected", "unavailable"]);
    assert.ok(events.every((event) => !JSON.stringify(event).includes("local801-production")));
  } finally {
    await close(server);
  }
});

test("ClamAV transport uses framed INSTREAM bytes and parses clean and infected replies", async () => {
  const received = [];
  const replies = ["stream: OK\0", "stream: Eicar-Signature FOUND\0"];
  const clamd = createNetServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const command = Buffer.from("zINSTREAM\0", "utf8");
      if (buffered.byteLength < command.byteLength || !buffered.subarray(0, command.byteLength).equals(command)) return;
      let offset = command.byteLength;
      const chunks = [];
      while (buffered.byteLength >= offset + 4) {
        const length = buffered.readUInt32BE(offset);
        if (length === 0) {
          received.push(Buffer.concat(chunks));
          socket.end(replies.shift());
          return;
        }
        if (buffered.byteLength < offset + 4 + length) return;
        chunks.push(buffered.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
    });
  });
  await listen(clamd);
  const address = clamd.address();
  try {
    const body = Buffer.from("synthetic clamd stream", "utf8");
    let result = await scanWithClamd(body, adapterConfig({ clamdPort: address.port, clamdTimeoutMs: 2000 }));
    assert.deepEqual(result, { status: "clean" });
    result = await scanWithClamd(body, adapterConfig({ clamdPort: address.port, clamdTimeoutMs: 2000 }));
    assert.deepEqual(result, { status: "infected", signature: "Eicar-Signature" });
    assert.equal(received.length, 2);
    assert.ok(received.every((value) => value.equals(body)));
  } finally {
    await close(clamd);
  }
});
