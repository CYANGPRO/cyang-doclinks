import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { getR2BucketEnv } from "./src/lib/envConfig";

const isProd = process.env.NODE_ENV === "production";

// NOTE: This project serves untrusted viewer traffic.
// We set conservative, production-safe security headers globally.
// If you later embed docs in iframes, you'll need to relax frame-ancestors / X-Frame-Options.

function cspValue(frameAncestors: string) {
  const connectSources = new Set(["'self'"]);

  const keywordSources = new Set([
    "self",
    "none",
    "unsafe-inline",
    "unsafe-eval",
    "strict-dynamic",
    "report-sample",
    "unsafe-hashes",
    "wasm-unsafe-eval",
  ]);

  const schemeSources = new Set(["https:", "http:", "wss:", "ws:", "data:", "blob:"]);

  const schemeHostSourcePattern =
    /^(https?|wss?):\/\/(\*\.)?([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
  const hostSourcePattern = /^(\*\.)?([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

  function normalizeConnectSourceToken(raw: string): string | null {
    const token = raw.trim();
    if (!token) return null;

    const dequoted = token.replace(/^['"]|['"]$/g, "");
    if (!dequoted) return null;

    // Prevent CSP directive/source-list injection via env tokens.
    // The split already strips spaces/commas, but semicolons and quotes can still break directives.
    if (/['"`;]/.test(dequoted)) return null;

    const lower = dequoted.toLowerCase();
    if (keywordSources.has(lower)) return `'${lower}'`;
    if (schemeSources.has(lower)) return lower;

    if (schemeHostSourcePattern.test(lower)) return lower;
    if (hostSourcePattern.test(lower)) return lower;

    // Allow full URLs but normalize to origin only.
    try {
      const u = new URL(dequoted);
      if (!["https:", "http:", "wss:", "ws:"].includes(u.protocol)) return null;
      if (u.username || u.password) return null;
      return u.origin;
    } catch {
      return null;
    }
  }

  for (const rawToken of String(process.env.CSP_CONNECT_SRC || "").split(/[\s,]+/)) {
    const normalized = normalizeConnectSourceToken(rawToken);
    if (!normalized) continue;
    connectSources.add(normalized);
  }

  const r2Endpoint = String(process.env.R2_ENDPOINT || "").trim();
  if (r2Endpoint) {
    try {
      const endpointUrl = new URL(r2Endpoint);
      connectSources.add(endpointUrl.origin);

      const bucket = getR2BucketEnv() || "";
      if (
        bucket &&
        endpointUrl.hostname.endsWith(".r2.cloudflarestorage.com") &&
        !endpointUrl.hostname.startsWith(`${bucket}.`)
      ) {
        connectSources.add(`${endpointUrl.protocol}//${bucket}.${endpointUrl.hostname}`);
      }
    } catch {
      // Ignore malformed endpoint in CSP assembly; runtime env validation handles required format.
    }
  }

  const connectSrc = `connect-src ${Array.from(connectSources).join(" ")}`;

  // Keep this CSP compatible with Next.js + PDF rendering.
  // Keep script/style sources tight and add explicit hosts via CSP_CONNECT_SRC when needed.
  const scriptSrc = "script-src 'self' 'unsafe-inline'";
  const parts = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "font-src 'self' data: https:",
    connectSrc,
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
  ];

  // Do not add upgrade-insecure-requests in dev/local.
  if (isProd) parts.push("upgrade-insecure-requests");

  return parts.join("; ");
}

const nextConfig: NextConfig = {
  async headers() {
    const strictHeaders: Array<{ key: string; value: string }> = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
      { key: "Content-Security-Policy", value: cspValue("'none'") },
    ];

    // The doc viewer embeds /serve/* in an iframe on first-party pages.
    // Also, some first-party/admin UX may iframe /d/* (preview panes, etc.).
    // Allow SAMEORIGIN framing for viewer surfaces only.
    const serveHeaders: Array<{ key: string; value: string }> = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
      { key: "Content-Security-Policy", value: cspValue("'self'") },
    ];

    if (isProd) {
      // 2 years, preload-ready.
      strictHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
      serveHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
}

    return [
      {
        // Brand assets are versioned by filename changes, so they can be cached
        // aggressively at the edge without risking stale dynamic content.
        source: "/branding/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/serve/:path*",
        headers: serveHeaders,
      },
      {
        // Share viewer page (contains iframe -> /serve/*). Must be allowed to be framed by first-party.
        // This prevents Firefox from blocking when /d/* is shown inside an iframe (admin previews, etc.).
        source: "/d/:path*",
        headers: serveHeaders,
      },
      {
        // Access ticket exchange/stream endpoints may be opened in embedded contexts (e.g., in-app previews).
        // Keep them SAMEORIGIN-framable.
        source: "/t/:path*",
        headers: serveHeaders,
      },
      {
        // Everything else is locked down against framing.
        source: "/((?!serve|d|t).*)",
        headers: strictHeaders,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
