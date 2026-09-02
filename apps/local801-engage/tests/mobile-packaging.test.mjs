import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { androidAssetLinks, appleAppSiteAssociation, LOCAL801_MOBILE_APP_ID } from "../src/lib/mobile-associations.ts";
import { getMobileReleaseState } from "../scripts/lib/mobile-release-policy.mjs";

const certificate = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join(":").toUpperCase();

function readyEnv(overrides = {}) {
  return {
    LOCAL801_MOBILE_APP_STORE_RELEASE_ENABLED: "1",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "1",
    LOCAL801_PRODUCTION_AUTH_ENABLED: "1",
    MFA_ENFORCE_ALL: "1",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
    LOCAL801_BACKUP_RESTORE_VERIFIED: "1",
    LOCAL801_SECURITY_REVIEW_APPROVED: "1",
    LOCAL801_PREVIEW_AUTH_ENABLED: "0",
    LOCAL801_MOBILE_REMOTE_WEBVIEW_REVIEW_APPROVED: "1",
    LOCAL801_MOBILE_OIDC_PKCE_VERIFIED: "1",
    LOCAL801_MOBILE_UNIVERSAL_LINKS_VERIFIED: "1",
    LOCAL801_MOBILE_REAL_DEVICE_VERIFIED: "1",
    LOCAL801_MOBILE_PRIVACY_DISCLOSURES_APPROVED: "1",
    LOCAL801_MOBILE_STORE_REVIEW_ACCOUNT_READY: "1",
    LOCAL801_MOBILE_APP_URL: "https://cat.cyang.io",
    LOCAL801_APPLE_TEAM_ID: "A1B2C3D4E5",
    LOCAL801_APPLE_APP_ID_PREFIX: "A1B2C3D4E5",
    LOCAL801_ANDROID_APP_LINK_SHA256: certificate,
    ...overrides,
  };
}

test("mobile store release remains fail-closed until every acceptance gate passes", () => {
  const state = getMobileReleaseState({});
  assert.equal(state.ready, false);
  for (const blocker of [
    "MOBILE_STORE_RELEASE_NOT_APPROVED",
    "REMOTE_WEBVIEW_REVIEW_NOT_APPROVED",
    "MOBILE_OIDC_PKCE_NOT_VERIFIED",
    "MOBILE_REAL_DEVICE_NOT_VERIFIED",
    "MOBILE_PRIVACY_NOT_APPROVED",
    "APPLE_TEAM_ID_INVALID",
    "APPLE_APP_ID_PREFIX_INVALID",
    "ANDROID_APP_LINK_CERTIFICATE_INVALID",
  ]) assert.equal(state.blockers.includes(blocker), true, blocker);
});

test("a complete mobile acceptance record can pass", () => {
  assert.deepEqual(getMobileReleaseState(readyEnv()), { ready: true, blockers: [] });
});

test("mobile release accepts only the canonical HTTPS app origin", () => {
  for (const value of ["http://cat.cyang.io", "https://preview.cyang.io", "https://cat.cyang.io/preview", "not-a-url"]) {
    const state = getMobileReleaseState(readyEnv({ LOCAL801_MOBILE_APP_URL: value }));
    assert.equal(state.ready, false);
    assert.equal(state.blockers.includes("MOBILE_APP_URL_INVALID"), true);
  }
});

test("Apple and Android domain associations are empty until valid public identifiers exist", () => {
  assert.deepEqual(appleAppSiteAssociation({}), { applinks: { apps: [], details: [] } });
  assert.deepEqual(androidAssetLinks({}), []);

  assert.deepEqual(appleAppSiteAssociation({ LOCAL801_APPLE_APP_ID_PREFIX: "a1b2c3d4e5" }), {
    applinks: {
      apps: [],
      details: [{ appIDs: [`A1B2C3D4E5.${LOCAL801_MOBILE_APP_ID}`], components: [{ "/": "/*" }] }],
    },
  });
  assert.deepEqual(androidAssetLinks({ LOCAL801_ANDROID_APP_LINK_SHA256: certificate }), [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: LOCAL801_MOBILE_APP_ID,
      sha256_cert_fingerprints: [certificate],
    },
  }]);
});

test("native projects use the same identifier, verified links, and locked device backup settings", async () => {
  const [capacitor, androidBuild, androidManifest, androidActivity, xcodeProject, entitlements, sceneDelegate] = await Promise.all([
    readFile(new URL("../capacitor.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../android/app/build.gradle", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/io/cyang/local801/engage/MainActivity.java", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/App.entitlements", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/SceneDelegate.swift", import.meta.url), "utf8"),
  ]);

  for (const source of [capacitor, androidBuild, xcodeProject]) assert.match(source, /io\.cyang\.local801\.engage/);
  assert.match(androidManifest, /android:allowBackup="false"/);
  assert.match(androidManifest, /android:usesCleartextTraffic="false"/);
  assert.match(androidManifest, /android:autoVerify="true"/);
  assert.match(androidActivity, /WindowManager\.LayoutParams\.FLAG_SECURE/);
  assert.match(entitlements, /applinks:cat\.cyang\.io/);
  assert.match(sceneDelegate, /sceneWillResignActive/);
  assert.match(sceneDelegate, /privacyCover/);
  assert.doesNotMatch(capacitor, /SECRET|CLIENT_SECRET|ENCRYPTION|DATABASE_URL|R2_/);
});

test("required PWA and native source artwork is generated", async () => {
  const assets = [
    "../public/icons/local801-192.png",
    "../public/icons/local801-512.png",
    "../public/icons/local801-maskable-512.png",
    "../public/icons/apple-touch-icon.png",
    "../resources/icon.png",
    "../resources/splash.png",
  ];
  await Promise.all(assets.map((asset) => access(new URL(asset, import.meta.url))));
});
