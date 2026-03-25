export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { buildLivenessSummary, toExternalHealthSummary } from "@/lib/health";
import { enforceGlobalApiRateLimit } from "@/lib/securityTelemetry";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { withRequestTelemetry } from "@/lib/perfTelemetry";
import { jsonError, jsonRateLimitError } from "@/lib/apiResponses";

export async function GET(req: NextRequest) {
  const timeoutMs = getRouteTimeoutMs("ROUTE_TIMEOUT_HEALTH_MS", 3_000);
  try {
    return await withRequestTelemetry(
      req,
      () => withRouteTimeout(
        (async () => {
        const rl = await enforceGlobalApiRateLimit({
          req,
          scope: "ip:health",
          limit: Number(process.env.RATE_LIMIT_HEALTH_IP_PER_MIN || 300),
          windowSeconds: 60,
          strict: true,
        });
        if (!rl.ok) {
          return jsonRateLimitError(rl.status, rl.retryAfterSeconds);
        }

        return NextResponse.json(toExternalHealthSummary(buildLivenessSummary()));
        })(),
        timeoutMs
      ),
      { routeKey: "/api/health/live" }
    );
  } catch (error: unknown) {
    if (isRouteTimeoutError(error)) {
      return jsonError("TIMEOUT", 504);
    }
    return jsonError("SERVER_ERROR", 500);
  }
}
