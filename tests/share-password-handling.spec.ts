import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.describe("share password handling", () => {
  test("share password create and unlock paths use exact-input password normalization", () => {
    const shareApi = readFileSync("src/app/api/v1/shares/route.ts", "utf8");
    const shareUnlock = readFileSync("src/app/s/[token]/actions.ts", "utf8");
    const aliasUnlock = readFileSync("src/app/d/[alias]/unlockActions.ts", "utf8");
    const aliasCreate = readFileSync("src/app/d/[alias]/actions.ts", "utf8");
    const adminActions = readFileSync("src/app/admin/actions.ts", "utf8");

    expect(shareApi.includes("parseOptionalExactPasswordInput(")).toBeTruthy();
    expect(shareUnlock.includes("normalizeExactPasswordInput(")).toBeTruthy();
    expect(aliasUnlock.includes("normalizeExactPasswordInput(")).toBeTruthy();
    expect(aliasCreate.includes("normalizeExactPasswordInput(")).toBeTruthy();
    expect(adminActions.includes("normalizeExactPasswordInput(")).toBeTruthy();

    expect(shareApi.includes("const pwd = raw.trim()")).toBeFalsy();
    expect(aliasCreate.includes("const password = passwordRaw.trim()")).toBeFalsy();
  });
});
