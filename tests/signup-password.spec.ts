import { expect, test } from "@playwright/test";
import { validatePasswordComplexity } from "../src/lib/signup";

test.describe("signup password complexity", () => {
  test("rejects too-short passwords", () => {
    expect(validatePasswordComplexity("Ab1!short")).toBe("Password must be at least 12 characters.");
  });

  test("rejects when required character classes are missing", () => {
    expect(validatePasswordComplexity("ABCDEFGHIJK1!")).toBe("Password must include a lowercase letter.");
    expect(validatePasswordComplexity("abcdefghijk1!")).toBe("Password must include an uppercase letter.");
    expect(validatePasswordComplexity("Abcdefghijk!")).toBe("Password must include a number.");
    expect(validatePasswordComplexity("Abcdefghijk1")).toBe("Password must include a symbol.");
  });

  test("accepts strong password", () => {
    expect(validatePasswordComplexity("StrongPass123!")).toBeNull();
  });

  test("accepts unicode-rich passwords without mutating them", () => {
    expect(validatePasswordComplexity("Strong🔒Пароль漢字123!")).toBeNull();
    expect(validatePasswordComplexity("  Strong🔒Pass123!  ")).toBeNull();
  });

  test("treats canonically equivalent unicode forms as distinct but valid inputs", () => {
    expect(validatePasswordComplexity("Caf\u00e9🔒StrongPass123!")).toBeNull();
    expect(validatePasswordComplexity("Cafe\u0301🔒StrongPass123!")).toBeNull();
  });

  test("rejects oversized and unsafe control-character passwords", () => {
    expect(validatePasswordComplexity("A".repeat(1025))).toBe("Password is too long.");
    expect(validatePasswordComplexity("Strong\0Pass123!")).toBe("Password contains unsupported characters.");
    expect(validatePasswordComplexity("StrongPass123!\n")).toBe("Password contains unsupported characters.");
    expect(validatePasswordComplexity("StrongPass123!\t")).toBe("Password contains unsupported characters.");
  });
});
