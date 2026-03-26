import { expect, test } from "@playwright/test";
import { getPlaywrightInstallInvocation } from "../scripts/lib/playwright-runtime.mjs";

test.describe("proof Playwright runtime install", () => {
  test("uses the repo-local tool runner without Linux dependency bootstrapping by default", () => {
    const invocation = getPlaywrightInstallInvocation({});

    expect(invocation.command).toBe("repo-tool");
    expect(invocation.args).toEqual(["playwright", "install", "chromium"]);
    expect(invocation.scope).toContain("Chromium browser runtime");
  });

  test("adds Linux dependency bootstrapping when Docker proof requests it", () => {
    const invocation = getPlaywrightInstallInvocation({
      PROOF_PLAYWRIGHT_INSTALL_WITH_DEPS: "1",
    });

    expect(invocation.args).toEqual(["playwright", "install", "--with-deps", "chromium"]);
    expect(invocation.scope).toContain("Linux OS dependencies");
  });
});
