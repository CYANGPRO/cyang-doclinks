export type PublicFunnelAction =
  | "cta_click"
  | "procurement_request"
  | "contact_request"
  | "pricing_interest"
  | "trust_doc_open"
  | "demo_interaction";

const ATTR_STORAGE_KEY = "cy_public_attr_v1";
const MAX_TEXT_LEN = 180;

type Attribution = {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  referrerDomain?: string | null;
  firstPath?: string | null;
};

function normText(value: string | null | undefined, maxLen = MAX_TEXT_LEN): string | null {
  const v = String(value || "").trim();
  if (!v || v.length > maxLen || /[\r\n\0]/.test(v)) return null;
  return v;
}

function normPath(value: string | null | undefined): string | null {
  const v = normText(value, 220);
  if (!v) return null;
  if (!v.startsWith("/") && !v.startsWith("http")) return null;
  return v;
}

function readStoredAttribution(): Attribution | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(ATTR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Attribution;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function sameOrigin(value: string | null | undefined): boolean {
  const href = String(value || "").trim();
  if (!href) return false;
  if (href.startsWith("/")) return true;
  try {
    const parsed = new URL(href, window.location.origin);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

function safeSend(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/api/v1/public/funnel", blob);
      return;
    }
  } catch {
    // fall through
  }

  void fetch("/api/v1/public/funnel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  });
}

export function trackPublicFunnelEvent(args: {
  action: PublicFunnelAction;
  label: string;
  pagePath?: string | null;
  target?: string | null;
  tier?: "primary" | "secondary" | "tertiary" | "utility" | null;
  location?: string | null;
}) {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  if (navigator.doNotTrack === "1") return;

  const pagePath = normPath(args.pagePath || window.location.pathname) || "/";
  const target = normPath(args.target) || null;

  safeSend({
    action: args.action,
    label: normText(args.label, 120) || args.action,
    pagePath,
    target,
    tier: args.tier || "utility",
    location: normText(args.location, 24) || "page",
    attribution: readStoredAttribution(),
    ts: Date.now(),
    sameOrigin: sameOrigin(target),
  });
}
