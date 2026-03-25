import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.describe("server action input guardrails", () => {
  test("admin actions bound bulk and text form inputs", () => {
    const code = readFileSync("src/app/admin/actions.ts", "utf8");
    expect(code.includes("MAX_BULK_JSON_CHARS")).toBeTruthy();
    expect(code.includes("MAX_BULK_ITEMS")).toBeTruthy();
    expect(code.includes("readFormText(")).toBeTruthy();
    expect(code.includes("parseStringArrayFormField(")).toBeTruthy();
  });

  test("share creation actions bound token/password/email input lengths", () => {
    const createShareCode = readFileSync("src/app/d/[alias]/actions.ts", "utf8");
    const shareGateCode = readFileSync("src/app/s/[token]/actions.ts", "utf8");
    expect(
      createShareCode.includes("MAX_PASSWORD_LEN") ||
        createShareCode.includes("MAX_SHARE_PASSWORD_LEN")
    ).toBeTruthy();
    expect(createShareCode.includes("readFormText(")).toBeTruthy();
    expect(shareGateCode.includes("MAX_TOKEN_LEN")).toBeTruthy();
    expect(shareGateCode.includes("MAX_PASSWORD_LEN")).toBeTruthy();
    expect(shareGateCode.includes("cleanText(")).toBeTruthy();
  });

  test("mfa, billing, and webhook actions bound form field sizes", () => {
    const mfaCode = readFileSync("src/app/mfa/actions.ts", "utf8");
    const billingCode = readFileSync("src/app/admin/(owner)/billing/actions.ts", "utf8");
    const webhookCode = readFileSync("src/app/admin/(owner)/webhooks/actions.ts", "utf8");
    expect(mfaCode.includes("MAX_MFA_CODE_LEN")).toBeTruthy();
    expect(mfaCode.includes("readFormText(")).toBeTruthy();
    expect(billingCode.includes("MAX_CHECKBOX_LEN")).toBeTruthy();
    expect(billingCode.includes("readCheckboxValue(")).toBeTruthy();
    expect(webhookCode.includes("MAX_WEBHOOK_SECRET_LEN")).toBeTruthy();
    expect(webhookCode.includes("MAX_WEBHOOK_EVENTS")).toBeTruthy();
  });
});
