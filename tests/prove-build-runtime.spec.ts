import { expect, test } from "@playwright/test";
import { evaluateProofRuntime, satisfiesVersionRange } from "../scripts/lib/proof-baseline.mjs";

test.describe("prove build runtime policy", () => {
  test("accepts engine-compatible versions even when they do not match the pinned baseline exactly", () => {
    const result = evaluateProofRuntime({
      actualNodeVersion: "24.22.1",
      actualNpmVersion: "10.9.2",
      requiredNodeVersion: "22.23.4",
      requiredNpmVersion: "10.9.2",
      nodeEngineRange: ">=22.23.4 <23 || >=24.22.1 <25",
      npmEngineRange: ">=10.9.2 <12",
    });

    expect(result.engineCompatible).toBeTruthy();
    expect(result.exactPinned).toBeFalsy();
    expect(result.nodeAllowed).toBeTruthy();
  });

  test("rejects versions outside the declared engine range", () => {
    const nodeRange = ">=22.23.4 <23 || >=24.22.1 <25";
    for (const version of ["22.23.4", "22.23.5", "24.22.1", "24.22.2"]) {
      expect(satisfiesVersionRange(version, nodeRange), version).toBeTruthy();
    }
    for (const version of ["22.19.0", "22.23.3", "23.0.0", "24.22.0", "25.0.0"]) {
      expect(satisfiesVersionRange(version, nodeRange), version).toBeFalsy();
    }
    expect(satisfiesVersionRange("10.8.9", ">=10.9.2 <12")).toBeFalsy();
    expect(satisfiesVersionRange("12.0.0", ">=10.9.2 <12")).toBeFalsy();
  });

  test("rejects malformed or empty version alternatives", () => {
    for (const range of ["", ">=22.23.4 unexpected", ">=22.23.4 ||", "|| >=24.22.1", ">=22.23.4 || invalid"]) {
      expect(satisfiesVersionRange("22.23.4", range), range).toBeFalsy();
    }
  });
});
