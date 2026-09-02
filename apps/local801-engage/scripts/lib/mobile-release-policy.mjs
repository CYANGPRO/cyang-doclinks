const APP_ORIGIN = "https://cat.cyang.io";
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
const ANDROID_CERTIFICATE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function enabled(env, key) {
  return env[key] === "1";
}

export function getMobileReleaseState(env = process.env, platform = "all") {
  if (!["all", "ios", "android"].includes(platform)) {
    throw new Error(`Unsupported mobile release platform: ${platform}`);
  }
  const blockers = [];
  const requireEnabled = (key, blocker) => {
    if (!enabled(env, key)) blockers.push(blocker);
  };

  requireEnabled("LOCAL801_MOBILE_APP_STORE_RELEASE_ENABLED", "MOBILE_STORE_RELEASE_NOT_APPROVED");
  requireEnabled("LOCAL801_PRODUCTION_LAUNCH_ENABLED", "PRODUCTION_LAUNCH_NOT_APPROVED");
  requireEnabled("LOCAL801_PRODUCTION_AUTH_ENABLED", "PRODUCTION_AUTH_DISABLED");
  requireEnabled("MFA_ENFORCE_ALL", "MFA_NOT_ENFORCED");
  requireEnabled("LOCAL801_DATABASE_PII_PROTECTION_ENABLED", "PII_PROTECTION_NOT_VERIFIED");
  requireEnabled("LOCAL801_BACKUP_RESTORE_VERIFIED", "BACKUP_RESTORE_NOT_VERIFIED");
  requireEnabled("LOCAL801_SECURITY_REVIEW_APPROVED", "SECURITY_REVIEW_NOT_APPROVED");
  requireEnabled("LOCAL801_MOBILE_REMOTE_WEBVIEW_REVIEW_APPROVED", "REMOTE_WEBVIEW_REVIEW_NOT_APPROVED");
  requireEnabled("LOCAL801_MOBILE_OIDC_PKCE_VERIFIED", "MOBILE_OIDC_PKCE_NOT_VERIFIED");
  requireEnabled("LOCAL801_MOBILE_UNIVERSAL_LINKS_VERIFIED", "MOBILE_LINKS_NOT_VERIFIED");
  requireEnabled("LOCAL801_MOBILE_REAL_DEVICE_VERIFIED", "MOBILE_REAL_DEVICE_NOT_VERIFIED");
  requireEnabled("LOCAL801_MOBILE_PRIVACY_DISCLOSURES_APPROVED", "MOBILE_PRIVACY_NOT_APPROVED");
  requireEnabled("LOCAL801_MOBILE_STORE_REVIEW_ACCOUNT_READY", "STORE_REVIEW_ACCOUNT_NOT_READY");

  if (env.LOCAL801_PREVIEW_AUTH_ENABLED === "1") blockers.push("PREVIEW_AUTH_ENABLED");

  try {
    const appUrl = new URL(env.LOCAL801_MOBILE_APP_URL || "");
    if (
      appUrl.origin !== APP_ORIGIN
      || appUrl.protocol !== "https:"
      || appUrl.pathname !== "/"
      || appUrl.search
      || appUrl.hash
    ) blockers.push("MOBILE_APP_URL_INVALID");
  } catch {
    blockers.push("MOBILE_APP_URL_INVALID");
  }

  if (platform !== "android") {
    const teamId = env.LOCAL801_APPLE_TEAM_ID?.trim().toUpperCase() || "";
    if (!APPLE_TEAM_ID.test(teamId)) blockers.push("APPLE_TEAM_ID_INVALID");
    const appIdPrefix = env.LOCAL801_APPLE_APP_ID_PREFIX?.trim().toUpperCase() || "";
    if (!APPLE_TEAM_ID.test(appIdPrefix)) blockers.push("APPLE_APP_ID_PREFIX_INVALID");
  }

  if (platform !== "ios") {
    const certificates = (env.LOCAL801_ANDROID_APP_LINK_SHA256 || "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    if (certificates.length === 0 || certificates.some((value) => !ANDROID_CERTIFICATE.test(value))) {
      blockers.push("ANDROID_APP_LINK_CERTIFICATE_INVALID");
    }
  }

  return { ready: blockers.length === 0, blockers };
}
