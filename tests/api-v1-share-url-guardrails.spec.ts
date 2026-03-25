import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.describe("api v1 share URL guardrails", () => {
  test("share creation route uses trusted base-url resolver", () => {
    const code = readFileSync("src/app/api/v1/shares/route.ts", "utf8");
    expect(code.includes("resolvePublicAppBaseUrl(req.url)")).toBeTruthy();
    expect(code.includes("http://localhost:3000")).toBeFalsy();
    expect(code.includes("ENV_MISCONFIGURED")).toBeTruthy();
    expect(code.includes("INVALID_DOC_ID")).toBeTruthy();
  });

  test("share creation route enforces payload and input guardrails", () => {
    const code = readFileSync("src/app/api/v1/shares/route.ts", "utf8");
    expect(code.includes("MAX_SHARE_BODY_BYTES")).toBeTruthy();
    expect(code.includes("INVALID_TO_EMAIL")).toBeTruthy();
    expect(code.includes("INVALID_PASSWORD")).toBeTruthy();
    expect(code.includes("MAX_COUNTRY_ITEMS")).toBeTruthy();
    expect(code.includes("parseOptionalExactPasswordInput(")).toBeTruthy();
    expect(code.includes("const pwd = raw.trim()")).toBeFalsy();
  });
});
