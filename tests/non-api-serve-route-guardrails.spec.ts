import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

function src(path: string): string {
  return readFileSync(path, "utf8");
}

test.describe("non-api serving route guardrails", () => {
  test("/serve/[docId] enforces abuse and plan controls", () => {
    const code = src("src/app/serve/[docId]/route.ts");
    expect(code.includes("enforceIpAbuseBlock(")).toBeTruthy();
    expect(code.includes("rateLimit(")).toBeTruthy();
    expect(code.includes("assertCanServeView(")).toBeTruthy();
    expect(
      code.includes('if (!u || !roleAtLeast(u.role, "admin"))') ||
        code.includes('if (!u || !deps.roleAtLeast(u.role, "admin"))')
    ).toBeTruthy();
  });

  test("/s/[token]/raw enforces token consumption, unlock checks, and rate limits", () => {
    const code = src("src/app/s/[token]/raw/route.ts");
    expect(code.includes("consumeShareTokenView(")).toBeTruthy();
    expect(code.includes("isUnlocked(")).toBeTruthy();
    expect(code.includes("rateLimit(")).toBeTruthy();
    expect(code.includes("assertCanServeView(")).toBeTruthy();
    expect(code.includes("geoDecisionForRequest(")).toBeTruthy();
  });

  test("/d/[alias]/raw enforces alias trust and rate limits", () => {
    const code = src("src/app/d/[alias]/raw/route.ts");
    expect(code.includes("isAliasTrusted(")).toBeTruthy();
    expect(code.includes("rateLimit(")).toBeTruthy();
    expect(code.includes("assertCanServeView(")).toBeTruthy();
  });

  test("/t/[ticketId] consumes ticket and enforces ticket/IP controls", () => {
    const code = src("src/app/t/[ticketId]/route.ts");
    expect(code.includes("UUID_RE")).toBeTruthy();
    expect(code.includes("if (!isUuid(ticketId))")).toBeTruthy();
    expect(code.includes("consumeAccessTicket(")).toBeTruthy();
    expect(code.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(code.includes("allowUnencryptedServing(")).toBeTruthy();
    expect(code.includes("scanStatus !== \"clean\"")).toBeTruthy();
  });

  test("/s/[token]/download is rate-limited before metadata lookups", () => {
    const code = src("src/app/s/[token]/download/route.ts");
    expect(code.includes("enforceGlobalApiRateLimit(")).toBeTruthy();
    expect(code.includes("RATE_LIMIT_SHARE_DOWNLOAD_IP_PER_MIN")).toBeTruthy();
  });

  test("/s/[token]/view download action uses a plain anchor (no prefetch)", () => {
    const code = src("src/app/s/[token]/view/page.tsx");
    expect(code.includes('href={`/s/${encodeURIComponent(t)}/download`}')).toBeTruthy();
    expect(code.includes("<a")).toBeTruthy();
    expect(code.includes("<Link href={`/s/${encodeURIComponent(t)}/download`}")).toBeFalsy();
  });
});
