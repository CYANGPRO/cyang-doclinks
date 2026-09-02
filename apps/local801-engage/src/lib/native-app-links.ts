const APP_BUNDLE_ID = "io.cyang.local801engage";
const ANDROID_PACKAGE_NAME = "io.cyang.local801.engage";
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
const SHA256_CERT_FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function appleAppSiteAssociation(teamIdInput: string | undefined) {
  const teamId = teamIdInput?.trim() || "";
  if (!APPLE_TEAM_ID.test(teamId)) return null;
  return {
    applinks: {
      apps: [] as string[],
      details: [{ appID: `${teamId}.${APP_BUNDLE_ID}`, paths: ["/*"] }],
    },
  };
}

export function androidAssetLinks(fingerprintInput: string | undefined) {
  const fingerprints = (fingerprintInput || "")
    .split(",")
    .map((fingerprint) => fingerprint.trim().toUpperCase())
    .filter((fingerprint) => SHA256_CERT_FINGERPRINT.test(fingerprint));
  if (fingerprints.length === 0) return null;
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: ANDROID_PACKAGE_NAME,
      sha256_cert_fingerprints: [...new Set(fingerprints)],
    },
  }];
}
