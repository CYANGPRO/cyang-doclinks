"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type Attribution = {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  referrerDomain?: string | null;
  firstPath?: string | null;
};

const ATTR_STORAGE_KEY = "cy_public_attr_v1";
const LAST_EVENT_STORAGE_KEY = "cy_public_funnel_last_v1";
const MAX_TEXT_LEN = 180;

function normText(value: string | null | undefined, maxLen = MAX_TEXT_LEN): string | null {
  const v = String(value || "").trim();
  if (!v || v.length > maxLen || /[\r\n\0]/.test(v)) return null;
  return v;
}

function parseReferrerDomain(): string | null {
  if (typeof document === "undefined") return null;
  const ref = normText(document.referrer, 1024);
  if (!ref) return null;
  try {
    const parsed = new URL(ref);
    return normText(parsed.hostname, 120);
  } catch {
    return null;
  }
}

function currentAttribution(pathname: string, searchParams: { get(name: string): string | null }): Attribution {
  return {
    utmSource: normText(searchParams.get("utm_source")),
    utmMedium: normText(searchParams.get("utm_medium")),
    utmCampaign: normText(searchParams.get("utm_campaign")),
    utmTerm: normText(searchParams.get("utm_term")),
    utmContent: normText(searchParams.get("utm_content")),
    referrerDomain: parseReferrerDomain(),
    firstPath: normText(pathname, 220),
  };
}

function hasAttributionValue(attr: Attribution): boolean {
  return Boolean(
    attr.utmSource ||
      attr.utmMedium ||
      attr.utmCampaign ||
      attr.utmTerm ||
      attr.utmContent ||
      attr.referrerDomain ||
      attr.firstPath
  );
}

function readStoredAttribution(): Attribution | null {
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

function writeStoredAttribution(attr: Attribution) {
  try {
    if (!hasAttributionValue(attr)) return;
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify(attr));
  } catch {
    // no-op
  }
}

function isSameOriginHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("/")) return true;
  try {
    const target = new URL(href, window.location.origin);
    return target.origin === window.location.origin;
  } catch {
    return false;
  }
}

function toPathOrHref(href: string): string {
  if (!href) return "/";
  try {
    const target = new URL(href, window.location.origin);
    if (target.origin === window.location.origin) {
      return `${target.pathname}${target.search || ""}`;
    }
    return target.toString().slice(0, 220);
  } catch {
    return href.slice(0, 220);
  }
}

function inferTier(anchor: HTMLAnchorElement): "primary" | "secondary" | "utility" {
  const className = String(anchor.className || "");
  if (className.includes("btn-primary")) return "primary";
  if (className.includes("btn-secondary")) return "secondary";
  return "utility";
}

function inferLocation(anchor: HTMLAnchorElement): "header" | "footer" | "page" {
  if (anchor.closest("header")) return "header";
  if (anchor.closest("footer")) return "footer";
  return "page";
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

export default function PublicFunnelTracker() {
  const pathname = usePathname();
  const attrRef = useRef<Attribution | null>(null);
  const dntEnabled = typeof navigator !== "undefined" && navigator.doNotTrack === "1";

  useEffect(() => {
    if (dntEnabled) return;
    const next = currentAttribution(pathname || "/", new URLSearchParams(window.location.search));
    const existing = readStoredAttribution();
    if (!existing) {
      writeStoredAttribution(next);
      attrRef.current = next;
      return;
    }

    const merged: Attribution = {
      utmSource: existing.utmSource || next.utmSource,
      utmMedium: existing.utmMedium || next.utmMedium,
      utmCampaign: existing.utmCampaign || next.utmCampaign,
      utmTerm: existing.utmTerm || next.utmTerm,
      utmContent: existing.utmContent || next.utmContent,
      referrerDomain: existing.referrerDomain || next.referrerDomain,
      firstPath: existing.firstPath || next.firstPath,
    };

    writeStoredAttribution(merged);
    attrRef.current = merged;
  }, [dntEnabled, pathname]);

  useEffect(() => {
    if (dntEnabled) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;

      const action = normText(anchor.dataset.funnelAction, 64) || "cta_click";
      if (!["cta_click", "procurement_request", "pricing_interest", "trust_doc_open"].includes(action)) return;

      const className = String(anchor.className || "");
      const explicit = Boolean(anchor.dataset.funnelAction);
      const candidate = explicit || className.includes("btn-base") || className.includes("btn-primary");
      if (!candidate) return;

      const href = normText(anchor.getAttribute("href"), 1024);
      if (!href) return;
      const targetPath = toPathOrHref(href);

      const label =
        normText(anchor.dataset.funnelLabel) ||
        normText(anchor.textContent?.replace(/\s+/g, " "), 120) ||
        action;
      const location =
        normText(anchor.dataset.funnelLocation, 24) ||
        inferLocation(anchor);
      const tier =
        normText(anchor.dataset.funnelTier, 24) ||
        inferTier(anchor);

      const signature = `${action}|${pathname}|${targetPath}|${label}`;
      const now = Date.now();
      try {
        const raw = sessionStorage.getItem(LAST_EVENT_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { signature?: string; at?: number };
          if (parsed.signature === signature && Number(parsed.at) + 1000 > now) return;
        }
        sessionStorage.setItem(LAST_EVENT_STORAGE_KEY, JSON.stringify({ signature, at: now }));
      } catch {
        // no-op
      }

      safeSend({
        action,
        label,
        pagePath: normText(pathname || "/", 220) || "/",
        target: targetPath,
        tier,
        location,
        attribution: attrRef.current,
        ts: now,
        sameOrigin: isSameOriginHref(href),
      });
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dntEnabled, pathname]);

  return null;
}
