import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function routeFiles(): string[] {
  const raw = execSync("rg --files src/app/api | rg \"route\\.ts$\"", { encoding: "utf8" });
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sourceFiles(): string[] {
  const raw = execSync("rg --files src", { encoding: "utf8" });
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function src(file: string): string {
  return readFileSync(file, "utf8");
}

function timeoutEnvKeysFromSource(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles()) {
    const code = src(file);
    const matches = code.matchAll(/getRouteTimeoutMs\("([A-Z0-9_]+)"/g);
    for (const m of matches) {
      if (m[1]) keys.add(m[1]);
    }
  }
  return Array.from(keys).sort();
}

function envKeysFromSource(pattern: RegExp): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles()) {
    const code = src(file);
    const matches = code.matchAll(pattern);
    for (const m of matches) {
      if (m[1]) keys.add(m[1]);
    }
  }
  return Array.from(keys).sort();
}

test.describe("api route guardrails", () => {
  test("admin routes are authenticated", () => {
    const files = routeFiles().filter((f) => f.includes("src/app/api/admin/"));
    const findings: string[] = [];
    const guardTokens = [
      "requireRole(",
      "requirePermission(",
      "requireOwner(",
      "requireOwnerAdmin(",
      "requireUser(",
    ];

    for (const f of files) {
      const code = src(f);
      const ok = guardTokens.some((t) => code.includes(t));
      if (!ok) findings.push(f);
    }

    expect(findings).toEqual([]);
  });

  test("cron routes enforce secret authorization", () => {
    const files = routeFiles().filter((f) => f.includes("src/app/api/cron/"));
    const findings: string[] = [];
    const allow = ["isCronAuthorized(", "function isAuthorized(", "const isAuthorized ="];

    for (const f of files) {
      const code = src(f);
      const ok = allow.some((t) => code.includes(t));
      if (!ok) findings.push(f);
    }

    expect(findings).toEqual([]);
  });

  test("public report/takedown endpoints are rate-limited", () => {
    const abuse = src("src/app/api/v1/abuse/report/route.ts");
    const takedown = src("src/app/api/v1/takedown/route.ts");
    expect(abuse.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(takedown.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
  });

  test("public unauthenticated POST endpoints include abuse throttling", () => {
    const manualSignup = src("src/app/api/auth/manual-signup/route.ts");
    const manualPasswordResetRequest = src("src/app/api/auth/manual-password-reset/request/route.ts");
    const manualPasswordResetComplete = src("src/app/api/auth/manual-password-reset/complete/route.ts");
    const signupConsent = src("src/app/api/auth/signup-consent/route.ts");
    const officePreview = src("src/app/api/viewer/office/route.ts");
    expect(manualSignup.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(manualPasswordResetRequest.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(manualPasswordResetComplete.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(signupConsent.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(officePreview.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
  });

  test("admin analytics aggregate route is rate-limited", () => {
    const code = src("src/app/api/admin/analytics/aggregate/route.ts");
    expect(code.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(code.includes("RATE_LIMIT_ADMIN_ANALYTICS_AGGREGATE_PER_MIN")).toBeTruthy();
    expect(code.includes('requireRole("admin")')).toBeTruthy();
  });

  test("sensitive admin GET routes include explicit rate limiting", () => {
    const routes = [
      "src/app/api/admin/audit/export/route.ts",
      "src/app/api/admin/billing/invoices/route.ts",
      "src/app/api/admin/billing/status/route.ts",
      "src/app/api/admin/db-index-audit/route.ts",
      "src/app/api/admin/billing/route.ts",
      "src/app/api/admin/retention/run/route.ts",
      "src/app/api/admin/security/keys/route.ts",
      "src/app/api/admin/security/freeze/route.ts",
      "src/app/api/admin/security/rbac/route.ts",
      "src/app/api/admin/security/org-access/route.ts",
      "src/app/api/admin/upload/route.ts",
    ];
    for (const route of routes) {
      const code = src(route);
      expect(code.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
      expect(code.includes("strict: true")).toBeTruthy();
    }
  });

  test("cron unauthorized responses do not include setup hints", () => {
    const files = routeFiles().filter((f) => f.includes("src/app/api/cron/"));
    const findings: string[] = [];
    for (const f of files) {
      const code = src(f);
      if (code.includes('error: "UNAUTHORIZED"') && code.includes("hint")) {
        findings.push(f);
      }
    }
    expect(findings).toEqual([]);
  });

  test("viewer office preview fetch stays scoped to raw document paths", () => {
    const code = src("src/app/api/viewer/office/route.ts");
    expect(code.includes("isAllowedRawPath")).toBeTruthy();
    expect(/\/\^\\\/s\\\/\[\^\/\]\+\\\/raw\$\/i/.test(code)).toBeTruthy();
    expect(/\/\^\\\/d\\\/\[\^\/\]\+\\\/raw\$\/i/.test(code)).toBeTruthy();
    expect(code.includes("readOfficePreviewSource(")).toBeTruthy();
    expect(code.includes("fetch(")).toBeFalsy();
  });

  test("all POST routes have an explicit security control", () => {
    const files = routeFiles();
    const findings: string[] = [];
    const allowedWithoutInlineGuard = new Set<string>(["src/app/api/auth/[...nextauth]/route.ts"]);
    const guardTokens = [
      "requireRole(",
      "requireUser(",
      "requirePermission(",
      "requireOwner(",
      "requireOwnerAdmin(",
      "enforceGlobalApiRateLimit(",
      "verifyStripeWebhookSignature(",
      "verifyApiKeyFromRequest(",
      "validateApiToken(",
      "isCronAuthorized(",
      "isAuthorized(",
    ];

    for (const f of files) {
      const code = src(f);
      if (!/export\s+async\s+function\s+POST\b|export\s+function\s+POST\b/.test(code)) continue;
      if (allowedWithoutInlineGuard.has(f)) continue;
      if (!guardTokens.some((t) => code.includes(t))) {
        findings.push(f);
      }
    }

    expect(findings).toEqual([]);
  });

  test("database metadata/debug queries require admin auth", () => {
    const files = routeFiles();
    const findings: string[] = [];
    const debugTokens = ["current_database()", "pg_catalog", "information_schema", "to_regclass("];

    for (const f of files) {
      const code = src(f);
      if (!debugTokens.some((t) => code.includes(t))) continue;
      const adminGuarded =
        code.includes('requireRole("admin")') ||
        code.includes('requireRole("owner")') ||
        code.includes('requirePermission("security.keys.read")') ||
        code.includes("requireOwner(") ||
        code.includes("requireOwnerAdmin(");
      if (!adminGuarded) findings.push(f);
    }

    expect(findings).toEqual([]);
  });

  test("api redirects avoid request-host-derived absolute URLs", () => {
    const files = routeFiles();
    const findings: string[] = [];

    for (const f of files) {
      const code = src(f);
      if (code.includes("NextResponse.redirect(new URL(") && code.includes(", req.url)")) {
        findings.push(f);
      }
    }

    expect(findings).toEqual([]);
  });

  test("high-cost metadata/debug routes use route timeout guards", () => {
    const routes = [
      "src/app/api/health/route.ts",
      "src/app/api/health/live/route.ts",
      "src/app/api/health/ready/route.ts",
      "src/app/api/health/deps/route.ts",
      "src/app/api/backup/status/route.ts",
      "src/app/api/admin/db-index-audit/route.ts",
    ];
    for (const route of routes) {
      const code = src(route);
      expect(code.includes("getRouteTimeoutMs(")).toBeTruthy();
      expect(code.includes("withRouteTimeout(")).toBeTruthy();
      expect(code.includes("isRouteTimeoutError(")).toBeTruthy();
      expect(code.includes('error: "TIMEOUT"') || code.includes('jsonError("TIMEOUT"')).toBeTruthy();
    }
  });

  test("health routes expose only external summaries on public endpoints", () => {
    const live = src("src/app/api/health/live/route.ts");
    const publicHealth = src("src/app/api/health/public/route.ts");
    expect(live.includes("toExternalHealthSummary(")).toBeTruthy();
    expect(live.includes("buildLivenessSummary()")).toBeTruthy();
    expect(live.includes("NextResponse.json(buildLivenessSummary())")).toBeFalsy();
    expect(publicHealth.includes("getCachedPublicHealthSnapshot()")).toBeTruthy();
  });

  test("admin control-plane routes use route timeout guards", () => {
    const routes = [
      "src/app/api/admin/abuse/route.ts",
      "src/app/api/admin/audit/export/route.ts",
      "src/app/api/admin/dmca/route.ts",
      "src/app/api/admin/security/rollback/route.ts",
      "src/app/api/admin/security/org-access/route.ts",
      "src/app/api/admin/security/requeue-scans/route.ts",
      "src/app/api/admin/security/tenant-freeze/route.ts",
      "src/app/api/admin/upload/abort/route.ts",
      "src/app/api/admin/upload/presign/route.ts",
    ];
    for (const route of routes) {
      const code = src(route);
      expect(code.includes("getRouteTimeoutMs(")).toBeTruthy();
      expect(code.includes("withRouteTimeout(")).toBeTruthy();
      expect(code.includes("isRouteTimeoutError(")).toBeTruthy();
    }
  });

  test("public abuse and webhook intake routes use route timeout guards", () => {
    const routes = [
      "src/app/api/v1/abuse/report/route.ts",
      "src/app/api/v1/aliases/route.ts",
      "src/app/api/v1/shares/route.ts",
      "src/app/api/v1/takedown/route.ts",
    ];
    for (const route of routes) {
      const code = src(route);
      expect(code.includes("getRouteTimeoutMs(")).toBeTruthy();
      expect(code.includes("withRouteTimeout(")).toBeTruthy();
      expect(code.includes("isRouteTimeoutError(")).toBeTruthy();
    }
  });

  test("critical cron scan route uses route timeout guards", () => {
    const code = src("src/app/api/cron/scan/route.ts");
    expect(code.includes("getRouteTimeoutMs(")).toBeTruthy();
    expect(code.includes("withRouteTimeout(")).toBeTruthy();
    expect(code.includes("isRouteTimeoutError(")).toBeTruthy();
  });

  test("stray debug and test-only routes remain removed", () => {
    const removedRoutes = [
      "src/app/api/debug/alias/[alias]/route.ts",
      "src/app/api/admin/debug/telemetry/route.ts",
      "src/app/api/admin/debug/route.ts",
      "src/app/api/admin/dbinfo/route.ts",
      "src/app/api/v1/webhooks/test/route.ts",
      "src/app/api/admin/security/migrate-legacy/route.ts",
    ];
    const files = routeFiles();
    for (const route of removedRoutes) {
      expect(files).not.toContain(route);
    }
  });

  test(".env.example includes timeout env keys used by route guards", () => {
    const keys = timeoutEnvKeysFromSource();
    const envExample = src(".env.example");
    const missing = keys.filter((k) => !new RegExp(`^${k}=`, "m").test(envExample));
    expect(missing).toEqual([]);
  });

  test(".env.example includes RATE_LIMIT env keys used in process.env", () => {
    const keys = envKeysFromSource(/process\.env\.(RATE_LIMIT_[A-Z0-9_]+)/g);
    const envExample = src(".env.example");
    const missing = keys.filter((k) => !new RegExp(`^${k}=`, "m").test(envExample));
    expect(missing).toEqual([]);
  });

  test(".env.example includes ABUSE_BLOCK env keys used in process.env", () => {
    const keys = envKeysFromSource(/process\.env\.(ABUSE_BLOCK_[A-Z0-9_]+)/g);
    const envExample = src(".env.example");
    const missing = keys.filter((k) => !new RegExp(`^${k}=`, "m").test(envExample));
    expect(missing).toEqual([]);
  });

  test("auth email start route enforces form body bounds before parsing", () => {
    const code = src("src/app/auth/email/start/route.ts");
    expect(code.includes("MAX_AUTH_EMAIL_START_FORM_BYTES")).toBeTruthy();
    expect(code.includes("parseFormBodyLength(")).toBeTruthy();
    expect(code.includes('status: 413')).toBeTruthy();
  });

  test("auth and share-download throttles are strict fail-closed", () => {
    const routes = [
      "src/app/auth/email/start/route.ts",
      "src/app/auth/email/consume/route.ts",
      "src/app/auth/google/start/route.ts",
      "src/app/auth/google/callback/route.ts",
      "src/app/org/[slug]/auth/[provider]/route.ts",
      "src/app/s/[token]/download/route.ts",
    ];
    for (const route of routes) {
      const code = src(route);
      expect(code.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
      expect(code.includes("strict: true")).toBeTruthy();
    }
  });

  test("global api rate limiter defaults to fail-closed when strict is omitted", () => {
    const code = src("src/lib/securityTelemetry.ts");
    expect(code.includes("failClosed: strict !== false")).toBeTruthy();
  });

  test("share raw per-IP and per-token rate limits fail closed", () => {
    const code = src("src/app/s/[token]/raw/route.ts");
    expect(code.includes('scope: "ip:share_preview"')).toBeTruthy();
    expect(code.includes('scope: "token:share_preview"')).toBeTruthy();
    expect(code.includes("failClosed: true")).toBeTruthy();
  });

  test("monetization soft-cap rate-limit gates fail closed", () => {
    const code = src("src/lib/monetization.ts");
    const scopes = [
      'scope: "pro:share_create:user:min"',
      'scope: "pro:share_create:user:burst"',
      'scope: "pro:view_overage:user:min"',
      'scope: "pro:view_soft_cap_alert:user:day"',
      'scope: "pro:egress_probe:user:15m"',
      'scope: "pro:egress_alert:user:day"',
    ];
    for (const scope of scopes) {
      expect(code.includes(scope)).toBeTruthy();
    }
    const failClosedCount = (code.match(/failClosed:\s*true/g) || []).length;
    expect(failClosedCount).toBeGreaterThanOrEqual(scopes.length);
  });

  test("auth entry routes set no-store cache headers", () => {
    const routes = [
      "src/app/auth/email/start/route.ts",
      "src/app/auth/email/consume/route.ts",
      "src/app/auth/google/start/route.ts",
      "src/app/auth/google/callback/route.ts",
      "src/app/org/[slug]/auth/[provider]/route.ts",
    ];
    for (const route of routes) {
      const code = src(route);
      expect(code.toLowerCase().includes("cache-control")).toBeTruthy();
      expect(code.toLowerCase().includes("no-store")).toBeTruthy();
    }
  });
});
