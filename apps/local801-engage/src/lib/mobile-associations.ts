export const LOCAL801_MOBILE_APP_ID = "io.cyang.local801engage";
export const LOCAL801_MOBILE_ORIGIN = "https://cat.cyang.io";

const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
const ANDROID_CERTIFICATE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function appleAppSiteAssociation(env: NodeJS.ProcessEnv = process.env) {
  const appIdPrefix = env.LOCAL801_APPLE_APP_ID_PREFIX?.trim().toUpperCase();
  const details = appIdPrefix && APPLE_TEAM_ID.test(appIdPrefix)
    ? [{ appIDs: [`${appIdPrefix}.${LOCAL801_MOBILE_APP_ID}`], components: [{ "/": "/*" }] }]
    : [];

  return { applinks: { apps: [], details } };
}

export function androidAssetLinks(env: NodeJS.ProcessEnv = process.env) {
  const certificates = (env.LOCAL801_ANDROID_APP_LINK_SHA256 || "")
    .split(",")
    .map((certificate) => certificate.trim().toUpperCase())
    .filter((certificate) => ANDROID_CERTIFICATE.test(certificate));

  if (certificates.length === 0) return [];

  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: LOCAL801_MOBILE_APP_ID,
      sha256_cert_fingerprints: certificates,
    },
  }];
}
