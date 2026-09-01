import { expect, test } from "@playwright/test";
import { evaluateProofRuntime, satisfiesVersionRange } from "../scripts/lib/proof-baseline.mjs";

test.describe("prove build runtime policy", () => {
  test("accepts engine-compatible versions even when they do not match the pinned baseline exactly", () => {
    const result = evaluateProofRuntime({
      actualNodeVersion: "24.13.0",
      actualNpmVersion: "10.9.2",
      requiredNodeVersion: "22.19.0",
      requiredNpmVersion: "10.9.2",
      nodeEngineRange: ">=22.19.0 <25",
      npmEngineRange: ">=10.9.2 <12",
    });

    expect(result.engineCompatible).toBeTruthy();
    expect(result.exactPinned).toBeFalsy();
    expect(result.nodeAllowed).toBeTruthy();
  });

  test("rejects versions outside the declared engine range", () => {
    expect(satisfiesVersionRange("25.0.0", ">=22.19.0 <25")).toBeFalsy();
    expect(satisfiesVersionRange("10.8.9", ">=10.9.2 <12")).toBeFalsy();
    expect(satisfiesVersionRange("12.0.0", ">=10.9.2 <12")).toBeFalsy();
  });
});
