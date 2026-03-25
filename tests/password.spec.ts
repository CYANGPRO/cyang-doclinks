import { expect, test } from "@playwright/test";
import { hashPassword, normalizeExactPasswordInput, parseOptionalExactPasswordInput, verifyPassword } from "../src/lib/password";

test.describe("password helpers", () => {
  test("hashes password with scrypt format and verifies correct secret", () => {
    const password = "CorrectHorseBatteryStaple!2026";
    const hash = hashPassword(password);
    expect(hash.startsWith("scrypt$")).toBeTruthy();
    expect(verifyPassword(password, hash)).toBeTruthy();
  });

  test("rejects wrong password for a valid hash", () => {
    const hash = hashPassword("secret-1");
    expect(verifyPassword("secret-2", hash)).toBeFalsy();
  });

  test("produces unique hashes for same password due to per-hash salt", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBeTruthy();
    expect(verifyPassword("same-password", b)).toBeTruthy();
  });

  test("fails closed on malformed stored hash", () => {
    expect(verifyPassword("x", "")).toBeFalsy();
    expect(verifyPassword("x", "sha256$abc$def")).toBeFalsy();
    expect(verifyPassword("x", "scrypt$missing")).toBeFalsy();
    expect(verifyPassword("x", "scrypt$bad###$stillbad###")).toBeFalsy();
  });

  test("rejects oversized or null-byte password inputs", () => {
    expect(() => hashPassword("x".repeat(4097))).toThrow("INVALID_PASSWORD");
    expect(() => hashPassword("abc\0def")).toThrow("INVALID_PASSWORD");
    expect(() => hashPassword("abc\tdef")).toThrow("INVALID_PASSWORD");
    expect(verifyPassword("x".repeat(4097), hashPassword("valid-pass-123!"))).toBeFalsy();
    expect(verifyPassword("abc\0def", hashPassword("valid-pass-123!"))).toBeFalsy();
    expect(verifyPassword("abc\rdef", hashPassword("valid-pass-123!"))).toBeFalsy();
  });

  test("supports unicode-rich passwords and preserves exact byte-for-byte comparison", () => {
    const password = "  Strong🔒Пароль漢字123!  ";
    const hash = hashPassword(password);
    expect(verifyPassword(password, hash)).toBeTruthy();
    expect(verifyPassword(password.trim(), hash)).toBeFalsy();
  });

  test("does not normalize canonically equivalent unicode forms", () => {
    const nfc = "Caf\u00e9🔒StrongPass123!";
    const nfd = "Cafe\u0301🔒StrongPass123!";
    const hash = hashPassword(nfc);
    expect(verifyPassword(nfc, hash)).toBeTruthy();
    expect(verifyPassword(nfd, hash)).toBeFalsy();
  });

  test("normalizes exact password input without trimming or unicode folding", () => {
    expect(normalizeExactPasswordInput("  Pa\u00df🔒word123!  ", 64)).toBe("  Pa\u00df🔒word123!  ");
    expect(normalizeExactPasswordInput("Pass\u0000word", 64)).toBeNull();
    expect(normalizeExactPasswordInput("x".repeat(65), 64)).toBeNull();
  });

  test("parses optional exact password input consistently for share-style passwords", () => {
    expect(parseOptionalExactPasswordInput(undefined, 32)).toBeNull();
    expect(parseOptionalExactPasswordInput("", 32)).toBeNull();
    expect(parseOptionalExactPasswordInput("   ", 32)).toBe("   ");
    expect(parseOptionalExactPasswordInput("🔐AccéntedПароль", 32)).toBe("🔐AccéntedПароль");
    expect(parseOptionalExactPasswordInput("bad\tpassword", 32)).toBe("INVALID");
    expect(parseOptionalExactPasswordInput("x".repeat(33), 32)).toBe("INVALID");
  });
});
