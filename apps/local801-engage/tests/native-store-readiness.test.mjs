import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { androidAssetLinks, appleAppSiteAssociation } from "../src/lib/native-app-links.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("native authentication stays in an exact CAT and Entra navigation allowlist", () => {
  const capacitor = source("../capacitor.config.ts");
  const info = source("../ios/App/App/Info.plist");
  assert.match(capacitor, /allowNavigation: \[origin\.hostname, "login\.microsoftonline\.com"\]/);
  assert.doesNotMatch(capacitor, /allowNavigation:[^\n]*\*/);
  assert.match(info, /<string>cat\.cyang\.io<\/string>/);
  assert.match(info, /<string>login\.microsoftonline\.com<\/string>/);
});

test("Apple association is unavailable until a valid Team ID is configured", () => {
  assert.equal(appleAppSiteAssociation(undefined), null);
  assert.equal(appleAppSiteAssociation("invalid"), null);
  assert.equal(appleAppSiteAssociation("A1B2C3D4E5").applinks.details[0].appID, "A1B2C3D4E5.io.cyang.local801.engage");
});

test("Android association accepts only canonical SHA-256 certificate fingerprints", () => {
  assert.equal(androidAssetLinks("invalid"), null);
  const fingerprint = Array.from({ length: 32 }, () => "AB").join(":");
  const body = androidAssetLinks(fingerprint);
  assert.equal(body[0].target.package_name, "io.cyang.local801.engage");
  assert.deepEqual(body[0].target.sha256_cert_fingerprints, [fingerprint]);
});

test("native store projects declare privacy, universal links, and protected-data safeguards", () => {
  const privacy = source("../ios/App/App/PrivacyInfo.xcprivacy");
  const project = source("../ios/App/App.xcodeproj/project.pbxproj");
  const info = source("../ios/App/App/Info.plist");
  const manifest = source("../android/app/src/main/AndroidManifest.xml");
  assert.match(privacy, /NSPrivacyTracking[\s\S]*<false\/>/);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryUserDefaults/);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryFileTimestamp/);
  assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
  assert.match(project, /DEVELOPMENT_TEAM = 2U38UX2XKN;/);
  assert.match(info, /ITSAppUsesNonExemptEncryption[\s\S]*<false\/>/);
  assert.match(manifest, /android:autoVerify="true"/);
  assert.match(manifest, /android:host="cat\.cyang\.io"/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
});
