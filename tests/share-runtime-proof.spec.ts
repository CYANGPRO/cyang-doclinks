import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";
import { postV1SharesRoute } from "../src/app/api/v1/shares/route";
import { verifySharePasswordCoreWithDeps } from "../src/app/s/[token]/actions";
import { verifyAliasPasswordResultWithDeps } from "../src/app/d/[alias]/unlockActions";
import { aliasTrustCookieName } from "../src/lib/deviceTrust";
import {
  createAliasPasswordHarness,
  createSharePasswordHarness,
  createShareRouteHarness,
  formData,
} from "./helpers/local-runtime/shareRuntime";

test.describe("share runtime proofs", () => {
  test("creates password-protected shares without trimming exact unicode input", async () => {
    const harness = createShareRouteHarness();
    const res = await postV1SharesRoute(
      harness.makeRequest({
        doc_id: "11111111-1111-4111-8111-111111111111",
        password: "  Paß🔐word  ",
      }),
      harness.deps
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBeTruthy();
    expect(harness.state.insertedShares).toHaveLength(1);
    const storedHash = String(harness.state.insertedShares[0].passwordHash || "");
    expect(storedHash.length).toBeGreaterThan(0);
    expect(await bcrypt.compare("  Paß🔐word  ", storedHash)).toBeTruthy();
    expect(await bcrypt.compare("Paß🔐word", storedHash)).toBeFalsy();
    expect(harness.state.audits).toHaveLength(1);
  });

  test("rejects invalid share passwords at creation time and allows empty password as no-password share", async () => {
    const invalid = createShareRouteHarness();
    const invalidRes = await postV1SharesRoute(
      invalid.makeRequest({
        doc_id: "11111111-1111-4111-8111-111111111111",
        password: "bad\tpassword",
      }),
      invalid.deps
    );
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json()).error).toBe("INVALID_PASSWORD");

    const empty = createShareRouteHarness();
    const emptyRes = await postV1SharesRoute(
      empty.makeRequest({
        doc_id: "11111111-1111-4111-8111-111111111111",
        password: "",
      }),
      empty.deps
    );
    expect(emptyRes.status).toBe(200);
    expect(empty.state.insertedShares[0].passwordHash).toBeNull();
  });

  test("grants access only to the exact share password and records failed attempts without leaking internals", async () => {
    const passwordHash = await bcrypt.hash("🔐Exact Café", 10);
    const liveMeta = {
      ok: true as const,
      token: "tok_live",
      docId: "doc-1",
      toEmail: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxViews: 5,
      viewCount: 0,
      revokedAt: null,
      hasPassword: true,
      passwordHash,
      watermarkEnabled: false,
      watermarkText: null,
      allowDownload: true,
      packId: null,
      packVersion: null,
      sharedByEmail: null,
      docStatus: "ready",
      docModerationStatus: "active",
      scanStatus: "clean",
      riskLevel: "low",
      isActive: true,
    };

    const wrong = createSharePasswordHarness({ meta: liveMeta });
    const wrongResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_live", password: "🔐Exact Cafe" }),
      wrong.deps
    );
    expect(wrongResult).toEqual({ ok: false, error: "bad_password", message: "Incorrect password." });
    expect(wrong.attempts).toHaveLength(1);
    expect(JSON.stringify(wrongResult)).not.toContain("password_hash");

    const correct = createSharePasswordHarness({ meta: liveMeta });
    const okResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_live", password: "🔐Exact Café" }),
      correct.deps
    );
    expect(okResult).toEqual({ ok: true });
    expect(correct.unlocks).toHaveLength(1);
    expect(correct.jar.get("share_unlock_tok_live")?.value).toBeTruthy();
  });

  test("requires both recipient email and password when that share policy is enabled", async () => {
    const passwordHash = await bcrypt.hash("open-sesame", 10);
    const meta = {
      ok: true as const,
      token: "tok_combo",
      docId: "doc-1",
      toEmail: "person@example.com",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxViews: null,
      viewCount: 0,
      revokedAt: null,
      hasPassword: true,
      passwordHash,
      watermarkEnabled: false,
      watermarkText: null,
      allowDownload: true,
      packId: null,
      packVersion: null,
      sharedByEmail: null,
      docStatus: "ready",
      docModerationStatus: "active",
      scanStatus: "clean",
      riskLevel: "low",
      isActive: true,
    };

    const missingEmail = createSharePasswordHarness({ meta });
    const emailResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_combo", password: "open-sesame", email: "" }),
      missingEmail.deps
    );
    expect(emailResult).toEqual({
      ok: false,
      error: "bad_password",
      message: "Enter the recipient email for this share.",
    });

    const correct = createSharePasswordHarness({ meta });
    const okResult = await verifySharePasswordCoreWithDeps(
      formData({ token: "tok_combo", password: "open-sesame", email: "person@example.com" }),
      correct.deps
    );
    expect(okResult).toEqual({ ok: true });
    expect(correct.jar.get("share_email_tok_combo")?.value).toBe("person@example.com");
  });

  test("fails safely for invalid, expired, and revoked share tokens", async () => {
    const missing = createSharePasswordHarness({ meta: { ok: false } });
    await expect(verifySharePasswordCoreWithDeps(formData({ token: "tok_missing", password: "x" }), missing.deps)).resolves.toEqual({
      ok: false,
      error: "not_found",
      message: "Share not found.",
    });

    const expired = createSharePasswordHarness({
      meta: {
        ok: true,
        token: "tok_expired",
        docId: "doc-1",
        toEmail: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        maxViews: null,
        viewCount: 0,
        revokedAt: null,
        hasPassword: false,
        passwordHash: null,
        watermarkEnabled: false,
        watermarkText: null,
        allowDownload: true,
        packId: null,
        packVersion: null,
        sharedByEmail: null,
        docStatus: "ready",
        docModerationStatus: "active",
        scanStatus: "clean",
        riskLevel: "low",
        isActive: true,
      },
    });
    await expect(verifySharePasswordCoreWithDeps(formData({ token: "tok_expired", password: "" }), expired.deps)).resolves.toEqual({
      ok: false,
      error: "expired",
      message: "This share link has expired.",
    });

    const revoked = createSharePasswordHarness({
      meta: {
        ok: true,
        token: "tok_revoked",
        docId: "doc-1",
        toEmail: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        maxViews: null,
        viewCount: 0,
        revokedAt: new Date().toISOString(),
        hasPassword: false,
        passwordHash: null,
        watermarkEnabled: false,
        watermarkText: null,
        allowDownload: true,
        packId: null,
        packVersion: null,
        sharedByEmail: null,
        docStatus: "ready",
        docModerationStatus: "active",
        scanStatus: "clean",
        riskLevel: "low",
        isActive: true,
      },
    });
    const revokedResult = await verifySharePasswordCoreWithDeps(formData({ token: "tok_revoked", password: "" }), revoked.deps);
    expect(revokedResult).toEqual({
      ok: false,
      error: "revoked",
      message: "This share was revoked.",
    });
    expect(JSON.stringify(revokedResult)).not.toContain("public.");
  });

  test("unlocks password-protected aliases and blocks revoked or expired aliases safely", async () => {
    const passwordHash = await bcrypt.hash("alias 🔑", 10);
    const live = createAliasPasswordHarness({
      aliasRow: {
        ok: true,
        docId: "doc-1",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        passwordHash,
      },
    });
    const ok = await verifyAliasPasswordResultWithDeps(
      formData({ alias: "Quarterly-Report", password: "alias 🔑" }),
      live.deps
    );
    expect(ok).toEqual({ ok: true });
    const cookieName = aliasTrustCookieName("quarterly-report");
    expect(live.jar.get(cookieName)?.value).toBeTruthy();
    expect(live.trusted).toHaveLength(1);

    const revoked = createAliasPasswordHarness({
      aliasRow: {
        ok: true,
        docId: "doc-1",
        revokedAt: new Date().toISOString(),
        expiresAt: null,
        passwordHash,
      },
    });
    await expect(
      verifyAliasPasswordResultWithDeps(formData({ alias: "Quarterly-Report", password: "alias 🔑" }), revoked.deps)
    ).resolves.toEqual({
      ok: false,
      error: "revoked",
      message: "This link has been revoked.",
    });

    const expired = createAliasPasswordHarness({
      aliasRow: {
        ok: true,
        docId: "doc-1",
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        passwordHash,
      },
    });
    const expiredResult = await verifyAliasPasswordResultWithDeps(
      formData({ alias: "Quarterly-Report", password: "alias 🔑" }),
      expired.deps
    );
    expect(expiredResult).toEqual({
      ok: false,
      error: "expired",
      message: "This link has expired.",
    });
    expect(JSON.stringify(expiredResult)).not.toContain("password_hash");
  });
});
