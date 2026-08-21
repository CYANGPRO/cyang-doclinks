import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpsImportMalwareScanner,
  createImportScannerAuthentication,
  getImportMalwareScanner,
} from "../src/lib/import-scanner.ts";

const secretHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const secret = Buffer.from(secretHex, "hex");
const nonceHex = "00112233445566778899aabbccddeeff";
const content = Buffer.from("synthetic scanner body\n", "utf8");
const scannerEnv = {
  LOCAL801_MALWARE_SCANNER_ENABLED: "1",
  LOCAL801_MALWARE_SCANNER_URL: "https://scan.cyang.io",
  LOCAL801_MALWARE_SCANNER_CLIENT_ID: "local801-preview",
  LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX: secretHex,
};
const deterministicDependencies = {
  now: () => 1_700_000_000_000,
  nonce: () => Buffer.from(nonceHex, "hex"),
};

function scannerRequest() {
  return { content, mediaType: "text/csv", originalFilename: "synthetic.csv" };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("scanner HMAC canonicalization and signature exactly match the protocol", () => {
  const authentication = createImportScannerAuthentication({
    content,
    clientId: "local801-preview",
    hmacSecret: secret,
    timestamp: "1700000000",
    nonce: nonceHex,
  });
  assert.equal(authentication.bodyHash, "6ab43e4157d8ddeded6549fc30a03a5d7887bebf1df1e58fbe4432762dc6614e");
  assert.equal(authentication.canonical,
    "v1\nPOST\n/v1/scan\nlocal801-preview\n1700000000\n00112233445566778899aabbccddeeff\n6ab43e4157d8ddeded6549fc30a03a5d7887bebf1df1e58fbe4432762dc6614e");
  assert.equal(authentication.canonical.endsWith("\n"), false);
  assert.equal(authentication.signature, "6f0a470ee25fce6bd16990827376bc70e1922822b34508bedd3cd7bd798ad3c1");
});

test("valid configured scanner sends exact bytes and maps clean", async () => {
  const calls = [];
  const scanner = getImportMalwareScanner(scannerEnv, {
    ...deterministicDependencies,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ status: "clean", bytes: content.byteLength });
    },
  });
  assert.deepEqual(await scanner.scan(scannerRequest()), { outcome: "clean" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://scan.cyang.io/v1/scan");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(calls[0].init.body, content);
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/octet-stream",
    "X-Scanner-Client-Id": "local801-preview",
    "X-Scanner-Timestamp": "1700000000",
    "X-Scanner-Nonce": nonceHex,
    "X-Scanner-Content-SHA256": "6ab43e4157d8ddeded6549fc30a03a5d7887bebf1df1e58fbe4432762dc6614e",
    "X-Scanner-Signature": "6f0a470ee25fce6bd16990827376bc70e1922822b34508bedd3cd7bd798ad3c1",
  });
});

test("infected scanner verdict maps to malicious without exposing its signature", async () => {
  const scanner = getImportMalwareScanner(scannerEnv, {
    ...deterministicDependencies,
    fetch: async () => jsonResponse({ status: "infected", signature: "Synthetic-Test-Signature", bytes: content.byteLength }),
  });
  assert.deepEqual(await scanner.scan(scannerRequest()), { outcome: "malicious" });
});

test("scanner authentication and capacity statuses map without retrying authentication forever", async () => {
  for (const [status, expected] of [
    [401, { outcome: "terminal_scanner_failure", providerCode: "authentication_failed" }],
    [429, { outcome: "temporary_failure", providerCode: "rate_limited" }],
    [500, { outcome: "temporary_failure", providerCode: "server_failure" }],
    [503, { outcome: "temporary_failure", providerCode: "server_failure" }],
  ]) {
    const scanner = createHttpsImportMalwareScanner(
      { clientId: "local801-preview", hmacSecret: secret },
      { ...deterministicDependencies, fetch: async () => new Response(null, { status }) },
    );
    assert.deepEqual(await scanner.scan(scannerRequest()), expected);
  }
});

test("scanner network failures are temporary and TLS failures are terminal", async () => {
  const networkScanner = createHttpsImportMalwareScanner(
    { clientId: "local801-preview", hmacSecret: secret },
    { ...deterministicDependencies, fetch: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    } },
  );
  assert.deepEqual(await networkScanner.scan(scannerRequest()), {
    outcome: "temporary_failure",
    providerCode: "network_failure",
  });

  const tlsScanner = createHttpsImportMalwareScanner(
    { clientId: "local801-preview", hmacSecret: secret },
    { ...deterministicDependencies, fetch: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } });
    } },
  );
  assert.deepEqual(await tlsScanner.scan(scannerRequest()), {
    outcome: "terminal_scanner_failure",
    providerCode: "tls_failure",
  });

  const interruptedBodyScanner = createHttpsImportMalwareScanner(
    { clientId: "local801-preview", hmacSecret: secret },
    { ...deterministicDependencies, fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new TypeError("socket closed"), { cause: { code: "ECONNRESET" } }));
      },
    }), { status: 200 }) },
  );
  assert.deepEqual(await interruptedBodyScanner.scan(scannerRequest()), {
    outcome: "temporary_failure",
    providerCode: "network_failure",
  });
});

test("scanner timeout aborts the request and maps to temporary failure", async () => {
  let observedAbort = false;
  const scanner = createHttpsImportMalwareScanner(
    { clientId: "local801-preview", hmacSecret: secret },
    {
      ...deterministicDependencies,
      timeoutMs: 10,
      fetch: async (_url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    },
  );
  assert.deepEqual(await scanner.scan(scannerRequest()), { outcome: "temporary_failure", providerCode: "timeout" });
  assert.equal(observedAbort, true);

  const stalledBodyScanner = createHttpsImportMalwareScanner(
    { clientId: "local801-preview", hmacSecret: secret },
    {
      ...deterministicDependencies,
      timeoutMs: 10,
      fetch: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true });
        },
      }), { status: 200 }),
    },
  );
  assert.deepEqual(await stalledBodyScanner.scan(scannerRequest()), {
    outcome: "temporary_failure",
    providerCode: "timeout",
  });
});

test("malformed, oversized, and shape-invalid scanner JSON fail closed", async () => {
  const responses = [
    new Response("not-json", { status: 200 }),
    new Response("x".repeat(4_097), { status: 200 }),
    jsonResponse({ status: "clean", bytes: content.byteLength, unexpected: true }),
    jsonResponse({ status: "clean", bytes: content.byteLength + 1 }),
  ];
  for (const response of responses) {
    const scanner = createHttpsImportMalwareScanner(
      { clientId: "local801-preview", hmacSecret: secret },
      { ...deterministicDependencies, fetch: async () => response },
    );
    assert.deepEqual(await scanner.scan(scannerRequest()), {
      outcome: "terminal_scanner_failure",
      providerCode: "invalid_response",
    });
  }
});

test("redirects are not followed", async () => {
  let calls = 0;
  let redirectMode;
  const scanner = createHttpsImportMalwareScanner(
    { clientId: "local801-preview", hmacSecret: secret },
    {
      ...deterministicDependencies,
      fetch: async (_url, init) => {
        calls += 1;
        redirectMode = init.redirect;
        return new Response(null, { status: 302, headers: { Location: "https://example.test/steal" } });
      },
    },
  );
  assert.deepEqual(await scanner.scan(scannerRequest()), {
    outcome: "terminal_scanner_failure",
    providerCode: "redirect_not_allowed",
  });
  assert.equal(calls, 1);
  assert.equal(redirectMode, "manual");
});

test("invalid scanner URLs and identifiers fail closed without outbound requests", async () => {
  for (const patch of [
    { LOCAL801_MALWARE_SCANNER_URL: "http://scan.cyang.io" },
    { LOCAL801_MALWARE_SCANNER_URL: "https://scan.cyang.io:444" },
    { LOCAL801_MALWARE_SCANNER_URL: "https://scan.cyang.io/v1/scan" },
    { LOCAL801_MALWARE_SCANNER_URL: "https://scan.cyang.io?destination=example.test" },
    { LOCAL801_MALWARE_SCANNER_URL: "https://scan.cyang.io#fragment" },
    { LOCAL801_MALWARE_SCANNER_URL: "https://user:pass@scan.cyang.io" },
    { LOCAL801_MALWARE_SCANNER_URL: "https://example.test" },
    { LOCAL801_MALWARE_SCANNER_CLIENT_ID: "unsafe client" },
    { LOCAL801_MALWARE_SCANNER_ENABLED: "true" },
  ]) {
    let calls = 0;
    const scanner = getImportMalwareScanner({ ...scannerEnv, ...patch }, { fetch: async () => {
      calls += 1;
      throw new Error("must not fetch");
    } });
    assert.deepEqual(await scanner.scan(scannerRequest()), {
      outcome: "terminal_scanner_failure",
      providerCode: "configuration_invalid",
    });
    assert.equal(calls, 0);
  }
});

test("invalid scanner secret format fails closed without revealing authentication material", async () => {
  for (const invalidSecret of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
    const result = await getImportMalwareScanner({
      ...scannerEnv,
      LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX: invalidSecret,
    }).scan(scannerRequest());
    assert.deepEqual(result, { outcome: "terminal_scanner_failure", providerCode: "configuration_invalid" });
    assert.equal(JSON.stringify(result).includes(invalidSecret || secretHex), false);
  }
});

test("disabled scanner preserves the unavailable fail-closed behavior", async () => {
  const result = await getImportMalwareScanner({
    ...scannerEnv,
    LOCAL801_MALWARE_SCANNER_ENABLED: "0",
  }).scan(scannerRequest());
  assert.deepEqual(result, { outcome: "terminal_scanner_failure", providerCode: "not_configured" });
  assert.equal(JSON.stringify(result).includes(secretHex), false);
  assert.equal(JSON.stringify(result).includes("6f0a470ee25fce6bd16990827376bc70e1922822b34508bedd3cd7bd798ad3c1"), false);
});
