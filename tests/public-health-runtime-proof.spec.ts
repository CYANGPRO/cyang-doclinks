import { expect, test } from "@playwright/test";
import { NextRequest, NextResponse } from "next/server";
import { getPublicHealthRoute, type PublicHealthRouteDeps } from "../src/app/api/health/public/route";

function makeDeps(overrides?: Partial<PublicHealthRouteDeps>): PublicHealthRouteDeps {
  const deps = {
    enforceGlobalApiRateLimit: async () => ({ ok: true, status: 200, retryAfterSeconds: 0 }),
    getCachedPublicHealthSnapshot: async () => ({
      ok: false,
      service: "cyang.io",
      ts: Date.now(),
      status: "degraded",
    }),
    getRouteTimeoutMs: () => 3_000,
    isRouteTimeoutError: ((_: unknown): _ is never => false),
    withRouteTimeout: async <T>(work: Promise<T>) => work,
    withRequestTelemetry: async <T>(_req: NextRequest, fn: () => Promise<T>) => fn(),
    jsonError: (error: string, status: number, extra?: { headers?: HeadersInit }) =>
      NextResponse.json({ ok: false as const, error }, { status, headers: extra?.headers }),
    ...overrides,
  };
  return deps as unknown as PublicHealthRouteDeps;
}

test.describe("public health runtime proofs", () => {
  test("returns sanitized public health snapshots with public cache headers", async () => {
    const res = await getPublicHealthRoute(
      new NextRequest("https://app.example.test/api/health/public", { method: "GET" }),
      makeDeps()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(JSON.stringify(body)).not.toContain("database");
    expect(JSON.stringify(body)).not.toContain("column");
  });

  test("rate limits safely without exposing internal dependency detail", async () => {
    const res = await getPublicHealthRoute(
      new NextRequest("https://app.example.test/api/health/public", { method: "GET" }),
      makeDeps({
        enforceGlobalApiRateLimit: async () => ({ ok: false, status: 429, retryAfterSeconds: 30 }),
      })
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ ok: false, error: "RATE_LIMIT" });
  });

  test("summarizes internal helper failures as sanitized server errors", async () => {
    const res = await getPublicHealthRoute(
      new NextRequest("https://app.example.test/api/health/public", { method: "GET" }),
      makeDeps({
        getCachedPublicHealthSnapshot: async () => {
          throw new Error('column "enc_key_version" does not exist');
        },
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("SERVER_ERROR");
    expect(JSON.stringify(body)).not.toContain("enc_key_version");
  });
});
