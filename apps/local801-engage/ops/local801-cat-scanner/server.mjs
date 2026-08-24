import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

export const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 4096;
const clientIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const hex32Pattern = /^[0-9a-f]{64}$/;
const noncePattern = /^[0-9a-f]{32}$/;

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid.`);
  }
  return parsed;
}

export function readScannerAdapterConfig(env = process.env) {
  const bindHost = env.LOCAL801_SCANNER_BIND_HOST ?? "127.0.0.1";
  const clamdHost = env.LOCAL801_SCANNER_CLAMD_HOST ?? "127.0.0.1";
  const clamdSocket = env.LOCAL801_SCANNER_CLAMD_SOCKET ?? "";
  const allowedHost = env.LOCAL801_SCANNER_ALLOWED_HOST ?? "scan.cyang.io";
  const nonceStatePath = env.LOCAL801_SCANNER_NONCE_STATE_PATH ?? "/run/local801-cat-scanner/nonces.json";
  const clientId = env.LOCAL801_SCANNER_CLIENT_ID ?? "";
  const secretHex = env.LOCAL801_SCANNER_HMAC_SECRET_HEX ?? "";
  const previewSecretHex = env.LOCAL801_SCANNER_PREVIEW_HMAC_SECRET_HEX ?? "";
  if (!new Set(["127.0.0.1", "::1"]).has(bindHost)) {
    throw new Error("LOCAL801_SCANNER_BIND_HOST must be loopback.");
  }
  if (!new Set(["127.0.0.1", "::1"]).has(clamdHost)) {
    throw new Error("LOCAL801_SCANNER_CLAMD_HOST must be loopback.");
  }
  if (clamdSocket && !/^\/(?:run|var\/run)\/clamav\/[A-Za-z0-9._-]{1,128}$/.test(clamdSocket)) {
    throw new Error("LOCAL801_SCANNER_CLAMD_SOCKET must be a ClamAV runtime socket path.");
  }
  if (allowedHost !== "scan.cyang.io") {
    throw new Error("LOCAL801_SCANNER_ALLOWED_HOST must be scan.cyang.io.");
  }
  if (nonceStatePath !== "/run/local801-cat-scanner/nonces.json") {
    throw new Error("LOCAL801_SCANNER_NONCE_STATE_PATH must use the private runtime directory.");
  }
  if (!clientIdPattern.test(clientId) || !hex32Pattern.test(secretHex)
    || (previewSecretHex !== "" && !hex32Pattern.test(previewSecretHex))) {
    throw new Error("Scanner client authentication configuration is invalid.");
  }
  const clientSecrets = new Map([[clientId, Buffer.from(secretHex, "hex")]]);
  if (previewSecretHex !== "") {
    if (clientId === "local801-preview") {
      throw new Error("Scanner Preview authentication must be separate from the primary client.");
    }
    clientSecrets.set("local801-preview", Buffer.from(previewSecretHex, "hex"));
  }
  return Object.freeze({
    bindHost,
    port: boundedInteger(env.LOCAL801_SCANNER_PORT, 8089, 1024, 65535, "LOCAL801_SCANNER_PORT"),
    allowedHost,
    nonceStatePath,
    clientId,
    hmacSecret: Buffer.from(secretHex, "hex"),
    clientSecrets,
    clamdSocket,
    clamdHost,
    clamdPort: boundedInteger(env.LOCAL801_SCANNER_CLAMD_PORT, 3310, 1, 65535, "LOCAL801_SCANNER_CLAMD_PORT"),
    maximumBytes: boundedInteger(
      env.LOCAL801_SCANNER_MAX_BYTES,
      MAX_SCAN_BYTES,
      1,
      MAX_SCAN_BYTES,
      "LOCAL801_SCANNER_MAX_BYTES",
    ),
    timestampSkewSeconds: boundedInteger(
      env.LOCAL801_SCANNER_TIMESTAMP_SKEW_SECONDS,
      300,
      30,
      300,
      "LOCAL801_SCANNER_TIMESTAMP_SKEW_SECONDS",
    ),
    nonceTtlSeconds: boundedInteger(
      env.LOCAL801_SCANNER_NONCE_TTL_SECONDS,
      600,
      300,
      900,
      "LOCAL801_SCANNER_NONCE_TTL_SECONDS",
    ),
    rateLimitPerMinute: boundedInteger(
      env.LOCAL801_SCANNER_RATE_LIMIT_PER_MINUTE,
      60,
      1,
      600,
      "LOCAL801_SCANNER_RATE_LIMIT_PER_MINUTE",
    ),
    maximumConcurrent: boundedInteger(
      env.LOCAL801_SCANNER_MAX_CONCURRENT,
      4,
      1,
      16,
      "LOCAL801_SCANNER_MAX_CONCURRENT",
    ),
    clamdTimeoutMs: boundedInteger(
      env.LOCAL801_SCANNER_CLAMD_TIMEOUT_MS,
      8000,
      1000,
      9000,
      "LOCAL801_SCANNER_CLAMD_TIMEOUT_MS",
    ),
  });
}

function singleHeader(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

function safeHexEqual(actual, expected) {
  if (!hex32Pattern.test(actual) || !hex32Pattern.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function createScannerSecurityState(options = {}) {
  const path = options.path ?? "";
  const state = { nonces: new Map(), requestTimes: [], persist: () => undefined };
  if (!path) return state;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !Array.isArray(parsed.nonces) || !Array.isArray(parsed.requestTimes)) {
      throw new Error("Scanner replay state is invalid.");
    }
    for (const entry of parsed.nonces) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"
        || !noncePattern.test(entry[0])
        || !Number.isSafeInteger(entry[1]) || entry[1] < 0) {
        throw new Error("Scanner replay state is invalid.");
      }
      state.nonces.set(entry[0], entry[1]);
    }
    if (!parsed.requestTimes.every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("Scanner replay state is invalid.");
    }
    state.requestTimes = parsed.requestTimes;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  state.persist = () => {
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({
      nonces: [...state.nonces.entries()],
      requestTimes: state.requestTimes,
    }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  };
  return state;
}

export function authorizeScannerRequest({ headers, body, config, state, now = Date.now() }) {
  const clientId = singleHeader(headers, "x-scanner-client-id");
  const timestamp = singleHeader(headers, "x-scanner-timestamp");
  const nonce = singleHeader(headers, "x-scanner-nonce");
  const suppliedHash = singleHeader(headers, "x-scanner-content-sha256");
  const suppliedSignature = singleHeader(headers, "x-scanner-signature");
  const hmacSecret = config.clientSecrets instanceof Map
    ? config.clientSecrets.get(clientId)
    : clientId === config.clientId ? config.hmacSecret : undefined;
  if (!Buffer.isBuffer(hmacSecret) || hmacSecret.byteLength !== 32
    || !/^(?:0|[1-9][0-9]*)$/.test(timestamp)
    || !noncePattern.test(nonce)
    || !hex32Pattern.test(suppliedHash)
    || !hex32Pattern.test(suppliedSignature)) {
    return { ok: false, status: 401, code: "authentication_failed" };
  }

  const timestampMilliseconds = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMilliseconds)
    || Math.abs(now - timestampMilliseconds) > config.timestampSkewSeconds * 1000) {
    return { ok: false, status: 401, code: "authentication_failed" };
  }
  const actualHash = createHash("sha256").update(body).digest("hex");
  if (!safeHexEqual(suppliedHash, actualHash)) {
    return { ok: false, status: 401, code: "authentication_failed" };
  }
  const canonical = ["v1", "POST", "/v1/scan", clientId, timestamp, nonce, actualHash].join("\n");
  const expectedSignature = createHmac("sha256", hmacSecret).update(canonical, "utf8").digest("hex");
  if (!safeHexEqual(suppliedSignature, expectedSignature)) {
    return { ok: false, status: 401, code: "authentication_failed" };
  }

  const nonceCutoff = now - config.nonceTtlSeconds * 1000;
  for (const [key, recordedAt] of state.nonces) {
    if (recordedAt < nonceCutoff) state.nonces.delete(key);
  }
  const nonceKey = nonce;
  if (state.nonces.has(nonceKey)) {
    return { ok: false, status: 401, code: "authentication_failed" };
  }

  const rateCutoff = now - 60_000;
  state.requestTimes = state.requestTimes.filter((recordedAt) => recordedAt >= rateCutoff);
  if (state.requestTimes.length >= config.rateLimitPerMinute) {
    return { ok: false, status: 429, code: "rate_limited" };
  }
  state.nonces.set(nonceKey, now);
  state.requestTimes.push(now);
  try {
    state.persist();
  } catch {
    state.nonces.delete(nonceKey);
    state.requestTimes.pop();
    return { ok: false, status: 503, code: "state_unavailable" };
  }
  return { ok: true };
}

function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.byteLength,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readBoundedBody(request, maximumBytes) {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximumBytes) {
      throw Object.assign(new Error("invalid_body_size"), { status: 413 });
    }
  }
  const chunks = [];
  let byteLength = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    byteLength += chunk.byteLength;
    if (byteLength > maximumBytes) {
      request.resume();
      throw Object.assign(new Error("invalid_body_size"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (byteLength < 1 || (typeof contentLength === "string" && Number(contentLength) !== byteLength)) {
    throw Object.assign(new Error("invalid_body_size"), { status: 400 });
  }
  return Buffer.concat(chunks, byteLength);
}

function parseClamdReply(reply) {
  const normalized = reply.replace(/\0+$/g, "").trim();
  if (normalized === "stream: OK") return { status: "clean" };
  const infected = /^stream: (.{1,255}) FOUND$/.exec(normalized);
  if (infected) {
    const signature = infected[1].replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
    if (signature) return { status: "infected", signature };
  }
  throw new Error("clamd_invalid_response");
}

export function scanWithClamd(content, config, dependencies = {}) {
  const connect = dependencies.connect ?? createConnection;
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    const responseChunks = [];
    const socket = connect(config.clamdSocket
      ? { path: config.clamdSocket }
      : { host: config.clamdHost, port: config.clamdPort });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error("clamd_timeout")));
    }, config.clamdTimeoutMs);
    socket.once("error", () => finish(() => reject(new Error("clamd_unavailable"))));
    socket.on("data", (chunk) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > RESPONSE_LIMIT_BYTES) {
        socket.destroy();
        finish(() => reject(new Error("clamd_invalid_response")));
        return;
      }
      responseChunks.push(Buffer.from(chunk));
    });
    socket.once("end", () => finish(() => {
      try {
        resolve(parseClamdReply(Buffer.concat(responseChunks, responseBytes).toString("utf8")));
      } catch {
        reject(new Error("clamd_invalid_response"));
      }
    }));
    socket.once("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0", "utf8"));
      for (let offset = 0; offset < content.byteLength; offset += 64 * 1024) {
        const chunk = content.subarray(offset, Math.min(content.byteLength, offset + 64 * 1024));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.byteLength);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}

export function createScannerRequestHandler(config, dependencies = {}) {
  const state = dependencies.state ?? createScannerSecurityState({ path: config.nonceStatePath ?? "" });
  const scan = dependencies.scan ?? ((body) => scanWithClamd(body, config));
  const now = dependencies.now ?? Date.now;
  const logger = dependencies.logger ?? ((event) => console.info(JSON.stringify(event)));
  let active = 0;

  return async function scannerRequestHandler(request, response) {
    if (singleHeader(request.headers, "host") !== config.allowedHost) {
      writeJson(response, 404, { status: "not_found" });
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.url !== "/v1/scan") {
      writeJson(response, 404, { status: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      writeJson(response, 405, { status: "method_not_allowed" });
      return;
    }
    if (singleHeader(request.headers, "content-type").toLowerCase() !== "application/octet-stream") {
      writeJson(response, 415, { status: "unsupported_media_type" });
      return;
    }
    if (active >= config.maximumConcurrent) {
      request.resume();
      writeJson(response, 429, { status: "busy" });
      return;
    }

    active += 1;
    try {
      let body;
      try {
        body = await readBoundedBody(request, config.maximumBytes);
      } catch (error) {
        writeJson(response, error && typeof error === "object" && "status" in error ? error.status : 400,
          { status: "invalid_request" });
        return;
      }
      const authorization = authorizeScannerRequest({ headers: request.headers, body, config, state, now: now() });
      if (!authorization.ok) {
        writeJson(response, authorization.status, { status: authorization.code });
        return;
      }

      let verdict;
      try {
        verdict = await scan(body);
      } catch {
        logger({ event: "local801_scanner_request", outcome: "unavailable" });
        writeJson(response, 503, { status: "unavailable" });
        return;
      }
      if (verdict.status === "clean") {
        logger({ event: "local801_scanner_request", outcome: "clean" });
        writeJson(response, 200, { status: "clean", bytes: body.byteLength });
        return;
      }
      if (verdict.status === "infected" && typeof verdict.signature === "string") {
        logger({ event: "local801_scanner_request", outcome: "infected" });
        writeJson(response, 200, { status: "infected", signature: verdict.signature.slice(0, 255), bytes: body.byteLength });
        return;
      }
      logger({ event: "local801_scanner_request", outcome: "invalid_verdict" });
      writeJson(response, 503, { status: "unavailable" });
    } finally {
      active -= 1;
    }
  };
}

export function createScannerAdapterServer(config, dependencies = {}) {
  const server = createServer(createScannerRequestHandler(config, dependencies));
  server.headersTimeout = 5000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readScannerAdapterConfig();
  const server = createScannerAdapterServer(config);
  server.listen(config.port, config.bindHost, () => {
    console.info(JSON.stringify({ event: "local801_scanner_started", status: "ready" }));
  });
}
