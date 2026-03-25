import { expect, test } from "@playwright/test";
import { NextRequest, NextResponse } from "next/server";
import { getServeRoute, type ServeRouteDeps } from "../src/app/serve/[docId]/route";
import { postUploadCompleteRoute, type UploadCompleteRouteDeps } from "../src/app/api/admin/upload/complete/route";

type DocState = {
  id: string;
  ownerId: string;
  orgId: string | null;
  title: string;
  originalFilename: string;
  contentType: string;
  r2Bucket: string;
  r2Key: string;
  sizeBytes: number;
  encryptionEnabled: boolean;
  status: string;
  scanStatus: string;
  moderationStatus: string;
  riskLevel: string;
  riskFlags: Record<string, unknown> | null;
};

type UploadHarness = {
  doc: DocState;
  aliases: string[];
  queuedScans: Array<{ docId: string; bucket: string; key: string }>;
  deletedKeys: string[];
  mintedTickets: string[];
  object: {
    body: Buffer;
    contentType: string;
    metadata: Record<string, string>;
  };
};

function makeUploadHarness(overrides?: Partial<DocState>): UploadHarness {
  const id = "11111111-1111-4111-8111-111111111111";
  const uploadBody = Buffer.from("%PDF-1.7\nok");
  return {
    doc: {
      id,
      ownerId: "owner-1",
      orgId: null,
      title: "Quarterly Report",
      originalFilename: "report.pdf",
      contentType: "application/pdf",
      r2Bucket: "docs-bucket",
      r2Key: `docs/${id}_report.pdf`,
      sizeBytes: uploadBody.byteLength,
      encryptionEnabled: true,
      status: "uploading",
      scanStatus: "pending",
      moderationStatus: "active",
      riskLevel: "low",
      riskFlags: null,
      ...overrides,
    },
    aliases: [],
    queuedScans: [],
    deletedKeys: [],
    mintedTickets: [],
    object: {
      body: uploadBody,
      contentType: "application/pdf",
      metadata: {
        "doc-id": id,
        "orig-content-type": "application/pdf",
        "orig-ext": ".pdf",
      },
    },
  };
}

function asyncBuffer(body: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function jsonError(error: string, status: number, extra?: { message?: string; headers?: HeadersInit }) {
  return NextResponse.json(
    {
      ok: false as const,
      error,
      ...(extra?.message ? { message: extra.message } : {}),
    },
    { status, headers: extra?.headers }
  );
}

function uploadSql(state: UploadHarness): UploadCompleteRouteDeps["sql"] {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("from public.docs") && text.includes("where r2_bucket =")) {
      const [bucket, key] = values;
      if (bucket === state.doc.r2Bucket && key === state.doc.r2Key) {
        return [{ id: state.doc.id }];
      }
      return [];
    }
    if (text.includes("coalesce(original_filename, title, '')::text as name")) {
      return [
        {
          id: state.doc.id,
          name: state.doc.originalFilename,
          content_type: state.doc.contentType,
          r2_bucket: state.doc.r2Bucket,
          r2_key: state.doc.r2Key,
        },
      ];
    }
    if (text.includes("set status = 'uploading'")) {
      state.doc.status = "uploading";
      return [];
    }
    if (text.includes("size_bytes::bigint as size_bytes") && text.includes("encryption_enabled::boolean")) {
      return [
        {
          size_bytes: state.doc.sizeBytes,
          encryption_enabled: state.doc.encryptionEnabled,
        },
      ];
    }
    if (text.includes("set\n        title = coalesce(") || text.includes("set\r\n        title = coalesce(")) {
      state.doc.title = String(values[0] ?? state.doc.title);
      state.doc.originalFilename = String(values[1] ?? state.doc.originalFilename);
      state.doc.contentType = String(values[2] ?? state.doc.contentType);
      state.doc.status = "ready";
      state.doc.scanStatus = String(values[3] ?? state.doc.scanStatus);
      state.doc.riskLevel = String(values[4] ?? state.doc.riskLevel);
      state.doc.riskFlags = (values[5] as Record<string, unknown>) ?? state.doc.riskFlags;
      state.doc.moderationStatus = state.doc.riskLevel === "high" ? "quarantined" : "active";
      return [
        {
          doc_state: state.doc.status,
          scan_state: state.doc.scanStatus,
          moderation_status: state.doc.moderationStatus,
        },
      ];
    }
    if (text.includes("select owner_id::text as owner_id")) {
      return [
        {
          owner_id: state.doc.ownerId,
          org_id: state.doc.orgId,
          size_bytes: state.doc.sizeBytes,
        },
      ];
    }
    if (text.includes("insert into public.doc_aliases")) {
      state.aliases.push(String(values[0]));
      return [];
    }
    throw new Error(`Unhandled upload SQL: ${text}`);
  }) as UploadCompleteRouteDeps["sql"];
}

function makeUploadDeps(state: UploadHarness): UploadCompleteRouteDeps {
  const deps = {
    validatePdfBuffer: () => ({ ok: true, riskLevel: "low", flags: [], details: undefined }),
    sql: uploadSql(state),
    slugify: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    requireDocWrite: async () => {},
    requireUser: async () => ({
      id: state.doc.ownerId,
      orgId: state.doc.orgId,
      orgSlug: null,
      email: "owner@example.com",
      role: "admin",
    }),
    getPlanForUser: async () => ({ id: "pro" } as { id: string }),
    incrementUploads: async () => {},
    enforceGlobalApiRateLimit: async () => ({ ok: true, status: 200, retryAfterSeconds: 0 }),
    clientIpKey: () => ({ ip: "203.0.113.10", ipHash: "iphash" }),
    logDbErrorEvent: async () => {},
    logSecurityEvent: async () => {},
    detectStorageSpike: async () => {},
    getR2Bucket: () => state.doc.r2Bucket,
    r2Client: {
      send: async (command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case "HeadObjectCommand":
            return {
              ContentLength: state.object.body.byteLength,
              ContentType: state.object.contentType,
              Metadata: state.object.metadata,
            };
          case "GetObjectCommand":
            return {
              Body: asyncBuffer(state.object.body),
            };
          case "PutObjectCommand":
            state.object.contentType = "application/octet-stream";
            state.object.metadata = {
              "doc-id": state.doc.id,
              "orig-content-type": state.doc.contentType,
              "orig-ext": ".pdf",
            };
            return {};
          case "DeleteObjectCommand":
            state.deletedKeys.push(state.doc.r2Key);
            return {};
          default:
            throw new Error(`Unhandled R2 command ${command.constructor.name}`);
        }
      },
    } as unknown,
    enqueueDocScan: async ({ docId, bucket, key }: { docId: string; bucket: string; key: string }) => {
      state.queuedScans.push({ docId, bucket, key });
      state.doc.scanStatus = "pending";
    },
    encryptAes256Gcm: ({ plaintext }: { plaintext: Buffer }) => Buffer.concat([Buffer.from("enc:"), plaintext]),
    generateDataKey: () => Buffer.from("0123456789abcdef0123456789abcdef"),
    generateIv: () => Buffer.from("123456789012"),
    wrapDataKey: () => ({
      wrapped: Buffer.from("wrapped"),
      iv: Buffer.from("wrapiv"),
      tag: Buffer.from("wraptag"),
    }),
    getActiveMasterKeyOrThrow: async () => ({ id: "mk-1", key: Buffer.from("mastermastermastermastermaster12") }),
    getRouteTimeoutMs: () => 45_000,
    isRouteTimeoutError: ((_: unknown): _ is never => false),
    withRouteTimeout: async <T>(work: Promise<T>) => work,
    assertRuntimeEnv: () => {},
    isRuntimeEnvError: ((_: unknown): _ is never => false),
    validateUploadType: () => ({ ok: true, canonicalMime: "application/pdf", ext: ".pdf", family: "document" }),
    resolvePublicAppBaseUrl: () => "https://app.example.test",
    findMissingPublicTableColumns: async () => [],
    withRequestTelemetry: async <T>(_req: NextRequest, fn: () => Promise<T>) => fn(),
    jsonError,
    jsonRateLimitError: (status: number, retryAfterSeconds: number) =>
      NextResponse.json({ ok: false, error: "RATE_LIMIT" }, { status, headers: { "Retry-After": String(retryAfterSeconds) } }),
  };
  return deps as unknown as UploadCompleteRouteDeps;
}

function makeServeDeps(state: UploadHarness): ServeRouteDeps {
  const deps = {
    sql: (async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (text.includes("select owner_id::text as owner_id")) {
        return [{ owner_id: state.doc.ownerId }];
      }
      return [];
    }) as ServeRouteDeps["sql"],
    mintAccessTicket: async () => {
      const ticket = `ticket_${state.mintedTickets.length + 1}`;
      state.mintedTickets.push(ticket);
      return ticket;
    },
    resolveDoc: async (input: { token?: string; docId?: string }) => {
      const token = "token" in input ? input.token : undefined;
      const docId = "docId" in input ? input.docId : undefined;
      const blocked =
        state.doc.status !== "ready" ||
        state.doc.scanStatus !== "clean" ||
        state.doc.moderationStatus !== "active";
      if (token !== "tok_live" && docId !== state.doc.id) {
        return { ok: false, error: "NOT_FOUND" } as const;
      }
      if (blocked) {
        return { ok: false, error: "NOT_FOUND" } as const;
      }
      return {
        ok: true,
        source: token ? "token" : "direct",
        docId: state.doc.id,
        bucket: state.doc.r2Bucket,
        r2Key: state.doc.r2Key,
        title: state.doc.title,
        originalFilename: state.doc.originalFilename,
        contentType: state.doc.contentType,
        sizeBytes: state.doc.sizeBytes,
        requiresPassword: false,
      } as const;
    },
    getClientIpFromHeaders: () => "203.0.113.10",
    getUserAgentFromHeaders: () => "pw-test",
    logDocAccess: async () => {},
    rateLimit: async () => ({ ok: true, resetSeconds: 60 }),
    rateLimitHeaders: () => ({}),
    stableHash: () => "stable",
    emitWebhook: async () => {},
    geoDecisionForRequest: async () => ({ allowed: true }),
    getCountryFromHeaders: () => "US",
    assertCanServeView: async () => ({ ok: true }),
    incrementMonthlyViews: async () => {},
    enforcePlanLimitsEnabled: () => false,
    getAuthedUser: async () => ({
      id: state.doc.ownerId,
      email: "owner@example.com",
      orgId: state.doc.orgId,
      orgSlug: null,
      role: "admin",
    }),
    roleAtLeast: () => true,
    isGlobalServeDisabled: async () => false,
    isSecurityTestNoDbMode: () => false,
    getRouteTimeoutMs: () => 25_000,
    isRouteTimeoutError: ((_: unknown): _ is never => false),
    withRouteTimeout: async <T>(work: Promise<T>) => work,
    enforceIpAbuseBlock: async () => ({ ok: true, retryAfterSeconds: 0 }),
    logDbErrorEvent: async () => {},
    logSecurityEvent: async () => {},
    maybeBlockIpOnAbuse: async () => {},
    assertRuntimeEnv: () => {},
    isRuntimeEnvError: ((_: unknown): _ is never => false),
    resolvePublicAppBaseUrl: () => "https://app.example.test",
    withRequestTelemetry: async <T>(_req: NextRequest, fn: () => Promise<T>) => fn(),
  };
  return deps as unknown as ServeRouteDeps;
}

function uploadRequest(docId: string) {
  return new NextRequest("https://app.example.test/api/admin/upload/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "64",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify({
      doc_id: docId,
      title: "Quarterly Report",
      original_filename: "report.pdf",
    }),
  });
}

test.describe("upload runtime proofs", () => {
  test("finalizes a clean upload, queues scanning, and serves only after the scan is marked clean", async () => {
    const state = makeUploadHarness();
    const uploadRes = await postUploadCompleteRoute(uploadRequest(state.doc.id), makeUploadDeps(state));
    expect(uploadRes.status).toBe(200);
    const uploadBody = await uploadRes.json();
    expect(uploadBody.ok).toBeTruthy();
    expect(uploadBody.scan_state).toBe("pending");
    expect(state.queuedScans).toEqual([{ docId: state.doc.id, bucket: state.doc.r2Bucket, key: state.doc.r2Key }]);
    expect(state.aliases).toEqual(["quarterly-report"]);

    const blockedServe = await getServeRoute(
      new NextRequest(`https://app.example.test/serve/${state.doc.id}?token=tok_live`, { method: "GET" }),
      { params: Promise.resolve({ docId: state.doc.id }) },
      makeServeDeps(state)
    );
    expect(blockedServe.status).toBe(404);

    state.doc.scanStatus = "clean";
    const releasedServe = await getServeRoute(
      new NextRequest(`https://app.example.test/serve/${state.doc.id}?token=tok_live`, { method: "GET" }),
      { params: Promise.resolve({ docId: state.doc.id }) },
      makeServeDeps(state)
    );
    expect(releasedServe.status).toBe(302);
    expect(releasedServe.headers.get("location")).toBe("https://app.example.test/t/ticket_1");
  });

  test("blocks legacy unencrypted docs at finalize time and deletes the plaintext object", async () => {
    const state = makeUploadHarness({ encryptionEnabled: false });
    const res = await postUploadCompleteRoute(uploadRequest(state.doc.id), makeUploadDeps(state));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ENCRYPTION_REQUIRED");
    expect(state.deletedKeys).toEqual([state.doc.r2Key]);
  });

  test("fails closed when scanner results stay unknown or quarantined at serve time", async () => {
    const state = makeUploadHarness({ status: "ready", scanStatus: "error", moderationStatus: "active" });
    const unknownResult = await getServeRoute(
      new NextRequest(`https://app.example.test/serve/${state.doc.id}?token=tok_live`, { method: "GET" }),
      { params: Promise.resolve({ docId: state.doc.id }) },
      makeServeDeps(state)
    );
    expect(unknownResult.status).toBe(404);

    state.doc.scanStatus = "clean";
    state.doc.moderationStatus = "quarantined";
    const quarantined = await getServeRoute(
      new NextRequest(`https://app.example.test/serve/${state.doc.id}?token=tok_live`, { method: "GET" }),
      { params: Promise.resolve({ docId: state.doc.id }) },
      makeServeDeps(state)
    );
    expect(quarantined.status).toBe(404);
  });
});
