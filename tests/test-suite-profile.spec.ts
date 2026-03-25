import { expect, test } from "@playwright/test";
import { LIVE_ISH_TEST_FILES, listLocalSafeSpecFiles, listSuiteFiles } from "../scripts/lib/test-suites.mjs";

test.describe("test suite profile routing", () => {
  test("local-safe suite excludes env-gated live-ish files", () => {
    const localSafe = new Set(listLocalSafeSpecFiles());
    for (const file of LIVE_ISH_TEST_FILES) {
      expect(localSafe.has(file)).toBeFalsy();
    }
  });

  test("live-ish suite returns exactly the env-gated smoke files", () => {
    expect(listSuiteFiles("live-ish")).toEqual(LIVE_ISH_TEST_FILES);
  });
});
