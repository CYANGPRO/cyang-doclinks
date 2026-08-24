import type { CapacitorConfig } from "@capacitor/cli";

const canonicalUrl = process.env.LOCAL801_NATIVE_SERVER_URL?.trim() || "https://cat.cyang.io";
const origin = new URL(canonicalUrl);
if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("LOCAL801_NATIVE_SERVER_URL must be a canonical HTTPS origin.");
}

const config: CapacitorConfig = {
  appId: "io.cyang.local801.engage",
  appName: "Engaging Local 801",
  webDir: "native-shell",
  server: {
    url: origin.origin,
    cleartext: false,
    // Keep Microsoft Entra inside the application WebView so the OIDC callback
    // returns to the same cookie jar. Do not broaden this list to wildcards.
    allowNavigation: [origin.hostname, "login.microsoftonline.com"],
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: "automatic",
    limitsNavigationsToAppBoundDomains: true,
    preferredContentMode: "mobile",
  },
};

export default config;
