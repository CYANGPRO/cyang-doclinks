export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { clientIpKey, enforceGlobalApiRateLimit, logSecurityEvent } from "@/lib/securityTelemetry";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { reportException } from "@/lib/observability";
import { withRequestTelemetry } from "@/lib/perfTelemetry";

type FunnelEventBody = {
  action?: unknown;
  label?: unknown;
  pagePath?: unknown;
  target?: unknown;
  tier?: unknown;
  location?: unknown;
  attribution?: unknown;
  ts?: unknown;
};

type Attribution = {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  referrerDomain?: string | null;
  firstPath?: string | null;
};

const MAX_BODY_BYTES = 10 * 1024;
const MAX_TEXT_LEN = 180;
const MAX_PATH_LEN = 220;
const MAX_ACTION_LEN = 64;
const SAFE_ACTIONS = new Set([
  "cta_click",
  "procurement_request",
  "contact_request",
  "pricing_interest",
  "trust_doc_open",
  "demo_interaction",
]);
const SAFE_TIER = new Set(["primary", "secondary", "tertiary", "utility"]);
const SAFE_LOCATION = new Set(["header", "hero", "section", "footer", "legal", "trust", "page", "pricing", "contact", "procurement", "demo"]);

function parseJsonBodyLength(req: NextRequest): number {
  const raw = String(req.headers.get("content-length") || "").trim();
  const out = Number(raw);
  return Number.isFinite(out) ? Math.max(0, Math.floor(out)) : 0;
}

function normText(value: unknown, maxLen: number): string | null {
  const v = String(value || "").trim();
  if (!v || v.length > maxLen || /[\r\n\0]/.test(v)) return null;
  return v;
}

function normPath(value: unknown): string | null {
  const v = normText(value, MAX_PATH_LEN);
  if (!v) return null;
  if (!v.startsWith("/") && !v.startsWith("http")) return null;
  return v;
}

function parseAttribution(input: unknown): Attribution | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: Attribution = {
    utmSource: normText(raw.utmSource, MAX_TEXT_LEN),
    utmMedium: normText(raw.utmMedium, MAX_TEXT_LEN),
    utmCampaign: normText(raw.utmCampaign, MAX_TEXT_LEN),
    utmTerm: normText(raw.utmTerm, MAX_TEXT_LEN),
    utmContent: normText(raw.utmContent, MAX_TEXT_LEN),
    referrerDomain: normText(raw.referrerDomain, MAX_TEXT_LEN),
    firstPath: normPath(raw.firstPath),
  };
  if (Object.values(out).every((value) => !value)) return null;
  return out;
}

function parseEventBody(body: FunnelEventBody) {
  const actionRaw = normText(body.action, MAX_ACTION_LEN)?.toLowerCase() || "";
  const action = SAFE_ACTIONS.has(actionRaw) ? actionRaw : null;
  const pagePath = normPath(body.pagePath);
  const target = normPath(body.target);
  const label = normText(body.label, MAX_TEXT_LEN);
  const tierRaw = normText(body.tier, 24)?.toLowerCase() || "";
  const locationRaw = normText(body.location, 24)?.toLowerCase() || "";
  const tier = SAFE_TIER.has(tierRaw) ? tierRaw : null;
  const location = SAFE_LOCATION.has(locationRaw) ? locationRaw : null;
  const attribution = parseAttribution(body.attribution);
  const clientTs = Number.isFinite(Number(body.ts))
    ? Math.max(0, Math.min(9_999_999_999_999, Math.floor(Number(body.ts))))
    : null;

  if (!action || !pagePath) return null;
  return {
    action,
    label,
    pagePath,
    target,
    tier,
    location,
    attribution,
    clientTs,
  };
}

export async function POST(req: NextRequest) {
  const timeoutMs = getRouteTimeoutMs("ROUTE_TIMEOUT_PUBLIC_FUNNEL_MS", 7_500);
  try {
    return await withRequestTelemetry(
      req,
      () => withRouteTimeout(
        (async () => {
        const rl = await enforceGlobalApiRateLimit({
          req,
          scope: "ip:public_funnel_event",
          limit: Number(process.env.RATE_LIMIT_PUBLIC_FUNNEL_PER_MIN || 120),
          windowSeconds: 60,
          strict: false,
        });
        if (!rl.ok) {
          return NextResponse.json(
            { ok: false, error: "RATE_LIMIT", message: "Too many tracking requests." },
            { status: rl.status, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
          );
        }

        if (parseJsonBodyLength(req) > MAX_BODY_BYTES) {
          return NextResponse.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
        }

        let body: FunnelEventBody | null;
        try {
          const parsed = await req.json();
          body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FunnelEventBody) : null;
        } catch {
          return NextResponse.json({ ok: false, error: "BAD_JSON", message: "Invalid JSON body." }, { status: 400 });
        }
        if (!body) {
          return NextResponse.json({ ok: false, error: "BAD_JSON", message: "Invalid JSON body." }, { status: 400 });
        }

        const event = parseEventBody(body);
        if (!event) {
          return NextResponse.json({ ok: false, error: "INVALID_EVENT", message: "Invalid event payload." }, { status: 400 });
        }

        const { ip } = clientIpKey(req);
        await logSecurityEvent({
          type: "public_funnel_event",
          severity: "low",
          ip,
          scope: `public:${event.action}`,
          message: event.label || event.action,
          meta: {
            action: event.action,
            pagePath: event.pagePath,
            target: event.target,
            tier: event.tier,
            location: event.location,
            attribution: event.attribution,
            clientTs: event.clientTs,
            route: "/api/v1/public/funnel",
          },
        });

        return NextResponse.json({ ok: true });
        })(),
        timeoutMs
      ),
      { routeKey: "/api/v1/public/funnel" }
    );
  } catch (error: unknown) {
    if (isRouteTimeoutError(error)) {
      return NextResponse.json({ ok: false, error: "TIMEOUT", message: "Request timed out." }, { status: 504 });
    }
    await reportException({
      error,
      event: "public_funnel_route_error",
      context: { route: "/api/v1/public/funnel" },
    });
    return NextResponse.json({ ok: false, error: "SERVER_ERROR", message: "Unable to track event." }, { status: 500 });
  }
}
