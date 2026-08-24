import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";
import { mapHeaders, parseCsv, recognizedMappings } from "./imports.ts";
import { getProductionLaunchState } from "./production-launch-policy.ts";
import type { ImportScannerOutcome } from "./import-processing.ts";

const scannerBaseUrl = "https://scan.cyang.io";
const scannerEndpoint = `${scannerBaseUrl}/v1/scan`;
const scannerRequestTimeoutMs = 10_000;
const scannerResponseMaxBytes = 4_096;
const scannerClientIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const lowercaseHexSecretPattern = /^[0-9a-f]{64}$/;
const lowercaseHexNoncePattern = /^[0-9a-f]{32}$/;

type ImportScannerConfiguration = Readonly<{
  clientId: string;
  hmacSecret: Buffer;
}>;

type ScannerFetch = (
  input: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => Promise<globalThis.Response>;

type ScannerAdapterDependencies = Readonly<{
  fetch?: ScannerFetch;
  now?: () => number;
  nonce?: (size: number) => Buffer;
  timeoutMs?: number;
}>;

export type ImportScannerRequest = Readonly<{
  content: Buffer;
  mediaType: string;
  originalFilename: string;
}>;

export type ImportScannerResult = Readonly<{
  outcome: ImportScannerOutcome;
  providerCode?: string;
}>;

export interface ImportMalwareScanner {
  scan(request: ImportScannerRequest): Promise<ImportScannerResult>;
}

const unavailableScanner: ImportMalwareScanner = {
  async scan() {
    return { outcome: "terminal_scanner_failure", providerCode: "not_configured" };
  },
};

const invalidConfigurationScanner: ImportMalwareScanner = {
  async scan() {
    return { outcome: "terminal_scanner_failure", providerCode: "configuration_invalid" };
  },
};

let scannerOverride: ImportMalwareScanner | null = null;

function readScannerConfiguration(env: NodeJS.ProcessEnv):
  | { state: "disabled" }
  | { state: "invalid" }
  | { state: "enabled"; configuration: ImportScannerConfiguration } {
  const enabled = env.LOCAL801_MALWARE_SCANNER_ENABLED ?? "0";
  if (enabled === "0") return { state: "disabled" };
  if (enabled !== "1") return { state: "invalid" };

  const configuredUrl = env.LOCAL801_MALWARE_SCANNER_URL ?? scannerBaseUrl;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    return { state: "invalid" };
  }
  if (parsedUrl.protocol !== "https:"
    || parsedUrl.hostname.toLowerCase() !== "scan.cyang.io"
    || parsedUrl.port
    || parsedUrl.username
    || parsedUrl.password
    || (parsedUrl.pathname !== "" && parsedUrl.pathname !== "/")
    || parsedUrl.search
    || parsedUrl.hash) {
    return { state: "invalid" };
  }

  const clientId = env.LOCAL801_MALWARE_SCANNER_CLIENT_ID ?? "";
  const secretHex = env.LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX ?? "";
  if (!scannerClientIdPattern.test(clientId) || !lowercaseHexSecretPattern.test(secretHex)) {
    return { state: "invalid" };
  }
  return {
    state: "enabled",
    configuration: Object.freeze({ clientId, hmacSecret: Buffer.from(secretHex, "hex") }),
  };
}

export function getImportMalwareScanner(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ScannerAdapterDependencies = {},
) {
  if (scannerOverride) return scannerOverride;
  const selected = readScannerConfiguration(env);
  if (selected.state === "disabled") return unavailableScanner;
  if (selected.state === "invalid") return invalidConfigurationScanner;
  return createHttpsImportMalwareScanner(selected.configuration, dependencies);
}

/** Test seam only. Production selection remains environment-driven. */
export function setImportMalwareScannerForTests(scanner: ImportMalwareScanner | null) {
  scannerOverride = scanner;
}

export function createImportScannerAuthentication(input: Readonly<{
  content: Buffer;
  clientId: string;
  hmacSecret: Buffer;
  timestamp: string;
  nonce: string;
}>) {
  if (!scannerClientIdPattern.test(input.clientId)
    || input.hmacSecret.byteLength !== 32
    || !/^(?:0|[1-9][0-9]*)$/.test(input.timestamp)
    || !lowercaseHexNoncePattern.test(input.nonce)) {
    throw new TypeError("Import scanner authentication input is invalid.");
  }
  const bodyHash = createHash("sha256").update(input.content).digest("hex");
  const canonical = [
    "v1",
    "POST",
    "/v1/scan",
    input.clientId,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
  const signature = createHmac("sha256", input.hmacSecret).update(canonical, "utf8").digest("hex");
  return Object.freeze({ bodyHash, canonical, signature });
}

async function readBoundedJson(response: Response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > scannerResponseMaxBytes) {
      throw new Error("invalid_response");
    }
  }
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > scannerResponseMaxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("invalid_response");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, byteLength));
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid_response");
  }
}

function scannerVerdict(value: unknown, expectedBytes: number): "clean" | "infected" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes !== expectedBytes) return null;
  const keys = Object.keys(record);
  if (record.status === "clean") {
    return keys.length === 2 && keys.every((key) => key === "status" || key === "bytes") ? "clean" : null;
  }
  if (record.status === "infected") {
    return keys.length === 3
      && keys.every((key) => key === "status" || key === "signature" || key === "bytes")
      && typeof record.signature === "string"
      && record.signature.length > 0
      && record.signature.length <= 255
      ? "infected"
      : null;
  }
  return null;
}

function networkFailureResult(error: unknown): ImportScannerResult {
  const cause = error && typeof error === "object" && "cause" in error
    && error.cause && typeof error.cause === "object" ? error.cause : error;
  const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "";
  if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|UNABLE_TO_VERIFY|SELF_SIGNED_CERT)/.test(code)) {
    return { outcome: "terminal_scanner_failure", providerCode: "tls_failure" };
  }
  if (new Set([
    "ECONNREFUSED", "ECONNRESET", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH",
    "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  ]).has(code)) {
    return { outcome: "temporary_failure", providerCode: "network_failure" };
  }
  return { outcome: "terminal_scanner_failure", providerCode: "protocol_failure" };
}

export function createHttpsImportMalwareScanner(
  configuration: ImportScannerConfiguration,
  dependencies: ScannerAdapterDependencies = {},
): ImportMalwareScanner {
  const fetchScanner = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const makeNonce = dependencies.nonce ?? ((size: number) => randomBytes(size));
  const timeoutMs = dependencies.timeoutMs ?? scannerRequestTimeoutMs;
  if (!scannerClientIdPattern.test(configuration.clientId)
    || configuration.hmacSecret.byteLength !== 32
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > scannerRequestTimeoutMs) {
    return invalidConfigurationScanner;
  }

  return {
    async scan(request) {
      const content = Buffer.from(request.content);
      const timestamp = Math.floor(now() / 1_000).toString(10);
      let nonceBytes: Buffer;
      try {
        nonceBytes = makeNonce(16);
      } catch {
        return { outcome: "terminal_scanner_failure", providerCode: "nonce_generation_failed" };
      }
      if (!Buffer.isBuffer(nonceBytes) || nonceBytes.byteLength !== 16) {
        return { outcome: "terminal_scanner_failure", providerCode: "nonce_generation_failed" };
      }
      let authentication: ReturnType<typeof createImportScannerAuthentication>;
      try {
        authentication = createImportScannerAuthentication({
          content,
          clientId: configuration.clientId,
          hmacSecret: configuration.hmacSecret,
          timestamp,
          nonce: nonceBytes.toString("hex"),
        });
      } catch {
        return { outcome: "terminal_scanner_failure", providerCode: "configuration_invalid" };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchScanner(scannerEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Scanner-Client-Id": configuration.clientId,
            "X-Scanner-Timestamp": timestamp,
            "X-Scanner-Nonce": nonceBytes.toString("hex"),
            "X-Scanner-Content-SHA256": authentication.bodyHash,
            "X-Scanner-Signature": authentication.signature,
          },
          body: content,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          return { outcome: "temporary_failure", providerCode: "timeout" };
        }
        return networkFailureResult(error);
      }

      try {
        if (response.status >= 300 && response.status < 400) {
          return { outcome: "terminal_scanner_failure", providerCode: "redirect_not_allowed" };
        }
        if (response.status === 401) {
          return { outcome: "terminal_scanner_failure", providerCode: "authentication_failed" };
        }
        if (response.status === 429) {
          return { outcome: "temporary_failure", providerCode: "rate_limited" };
        }
        if (response.status >= 500 && response.status <= 599) {
          return { outcome: "temporary_failure", providerCode: "server_failure" };
        }
        if (response.status !== 200) {
          return { outcome: "terminal_scanner_failure", providerCode: "unexpected_status" };
        }

        let payload: unknown;
        try {
          payload = await readBoundedJson(response);
        } catch (error) {
          if (controller.signal.aborted) {
            return { outcome: "temporary_failure", providerCode: "timeout" };
          }
          if (!(error instanceof Error) || error.message !== "invalid_response") {
            return networkFailureResult(error);
          }
          return { outcome: "terminal_scanner_failure", providerCode: "invalid_response" };
        }
        const verdict = scannerVerdict(payload, content.byteLength);
        if (verdict === "clean") return { outcome: "clean" };
        if (verdict === "infected") return { outcome: "malicious" };
        return { outcome: "terminal_scanner_failure", providerCode: "invalid_response" };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function durablePreviewImportsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.VERCEL_ENV === "preview"
    && env.LOCAL801_PREVIEW_AUTH_ENABLED === "1"
    && env.LOCAL801_DURABLE_IMPORTS_ENABLED === "1";
}

export function isCsvImportSource(mediaType: string, originalFilename: string) {
  return mediaType.toLowerCase() === "text/csv" || originalFilename.toLowerCase().endsWith(".csv");
}

export function durableImportProcessingEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (durablePreviewImportsEnabled(env)) return true;
  return env.VERCEL_ENV === "production"
    && env.LOCAL801_PROTECTED_DURABLE_IMPORTS_ENABLED === "1"
    && env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"
    && env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"
    && env.LOCAL801_PII_BACKFILL_ENABLED !== "1"
    && getProductionLaunchState(env).ready;
}

export function isXlsxImportSource(mediaType: string, originalFilename: string) {
  return mediaType.toLowerCase() === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || originalFilename.toLowerCase().endsWith(".xlsx");
}

export function isSupportedImportSource(mediaType: string, originalFilename: string) {
  return isCsvImportSource(mediaType, originalFilename) || isXlsxImportSource(mediaType, originalFilename);
}

function rowsUseStrictSyntheticIdentities(rows: string[][]) {
  const headers = rows[0] ?? [];
  if (rows.length < 2 || recognizedMappings(headers).length === 0) return false;
  const authoritativeColumns = mapHeaders(headers).map((header, index) => ({
    index,
    mappedTo: header.mappedTo,
  })).filter((header) => header.mappedTo === "work_email"
    || header.mappedTo === "employee_identifier"
    || header.mappedTo === "member_identifier");
  return rows.slice(1).every((cells) => {
    let hasIdentity = false;
    for (const column of authoritativeColumns) {
      const value = cells[column.index]?.trim();
      if (!value) continue;
      hasIdentity = true;
      if (column.mappedTo === "work_email" && !value.toLowerCase().endsWith("@example.test")) return false;
      if ((column.mappedTo === "employee_identifier" || column.mappedTo === "member_identifier")
        && !value.toUpperCase().startsWith("SYNTH-")) return false;
    }
    return hasIdentity;
  });
}

export function areStrictSyntheticImportSheets(
  sheets: ReadonlyArray<{ state: string; rows: string[][] }>,
) {
  const included = sheets.filter((sheet) => sheet.state === "included");
  return included.length > 0 && included.every((sheet) => rowsUseStrictSyntheticIdentities(sheet.rows));
}

/**
 * Durable Preview acceptance is limited to CSV rows using the synthetic
 * identity namespace. Malware scanning remains an independent required step.
 */
export function isStrictSyntheticPreviewCsv(content: Buffer, mediaType: string, originalFilename: string) {
  if (!isCsvImportSource(mediaType, originalFilename)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return false;
  }
  return rowsUseStrictSyntheticIdentities(parseCsv(text));
}
