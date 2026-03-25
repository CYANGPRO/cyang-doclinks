export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { enforceGlobalApiRateLimit } from "@/lib/securityTelemetry";
import { getCachedPublicHealthSnapshot } from "@/lib/health";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { withRequestTelemetry } from "@/lib/perfTelemetry";
import { jsonError } from "@/lib/apiResponses";

const PUBLIC_STATUS_S_MAXAGE = 300;
const PUBLIC_STATUS_STALE_WHILE_REVALIDATE = 900;

export type PublicHealthRouteDeps = {
  enforceGlobalApiRateLimit: typeof enforceGlobalApiRateLimit;
  getCachedPublicHealthSnapshot: typeof getCachedPublicHealthSnapshot;
  getRouteTimeoutMs: typeof getRouteTimeoutMs;
  isRouteTimeoutError: typeof isRouteTimeoutError;
  withRouteTimeout: typeof withRouteTimeout;
  withRequestTelemetry: typeof withRequestTelemetry;
  jsonError: typeof jsonError;
};

const defaultPublicHealthRouteDeps: PublicHealthRouteDeps = {
  enforceGlobalApiRateLimit,
  getCachedPublicHealthSnapshot,
  getRouteTimeoutMs,
  isRouteTimeoutError,
  withRouteTimeout,
  withRequestTelemetry,
  jsonError,
};

export async function getPublicHealthRoute(
  req: NextRequest,
  deps: PublicHealthRouteDeps = defaultPublicHealthRouteDeps
) {
  const timeoutMs = deps.getRouteTimeoutMs("ROUTE_TIMEOUT_HEALTH_MS", 3_000);
  try {
    return await deps.withRequestTelemetry(
      req,
      () => deps.withRouteTimeout(
        (async () => {
        const rl = await deps.enforceGlobalApiRateLimit({
          req,
          scope: "ip:health",
          limit: Number(process.env.RATE_LIMIT_HEALTH_IP_PER_MIN || 300),
          windowSeconds: 60,
          strict: true,
        });
        if (!rl.ok) {
          return deps.jsonError("RATE_LIMIT", rl.status, {
            headers: {
              "Retry-After": String(rl.retryAfterSeconds),
              "Cache-Control": "no-store",
            },
          });
        }

        const snapshot = await deps.getCachedPublicHealthSnapshot();
        return NextResponse.json(snapshot, {
          headers: {
            "Cache-Control": `public, s-maxage=${PUBLIC_STATUS_S_MAXAGE}, stale-while-revalidate=${PUBLIC_STATUS_STALE_WHILE_REVALIDATE}`,
          },
        });
        })(),
        timeoutMs
      ),
      { routeKey: "/api/health/public" }
    );
  } catch (error: unknown) {
    if (deps.isRouteTimeoutError(error)) {
      return deps.jsonError("TIMEOUT", 504, { headers: { "Cache-Control": "no-store" } });
    }
    return deps.jsonError("SERVER_ERROR", 500, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(req: NextRequest) {
  return getPublicHealthRoute(req);
}
