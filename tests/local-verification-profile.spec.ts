import { expect, test } from "@playwright/test";
import {
  getLocalVerificationAdapterSummary,
  getRuntimeDependencyMode,
  isLocalVerificationRuntime,
} from "../src/lib/localVerificationProfile";

test.describe("local verification profile", () => {
  test("stays production-shaped unless the dedicated verification flag is enabled", () => {
    const env = { NODE_ENV: "test", VERIFY_LOCAL_RUNTIME: "0" } as NodeJS.ProcessEnv;
    expect(isLocalVerificationRuntime(env)).toBeFalsy();
    expect(getRuntimeDependencyMode(env)).toBe("production");
  });

  test("describes the deterministic adapters used in local verification mode", () => {
    const summary = getLocalVerificationAdapterSummary({ NODE_ENV: "test", VERIFY_LOCAL_RUNTIME: "1" } as NodeJS.ProcessEnv);
    expect(summary.enabled).toBeTruthy();
    expect(summary.mode).toBe("local-verify");
    expect(summary.adapters.database).toContain("deterministic");
    expect(summary.adapters.objectStorage).toContain("in-memory");
    expect(summary.adapters.malwareScanner).toContain("deterministic");
    expect(summary.adapters.billingWebhook).toContain("signed");
  });
});
