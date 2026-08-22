import type { CapacitorConfig } from "@capacitor/cli";

export const LOCAL801_MOBILE_APP_ID = "io.cyang.local801engage";
export const LOCAL801_MOBILE_APP_ORIGIN = "https://cat.cyang.io";

const configuredUrl = process.env.LOCAL801_MOBILE_APP_URL?.trim() || LOCAL801_MOBILE_APP_ORIGIN;
const mobileUrl = new URL(configuredUrl);

if (
  mobileUrl.protocol !== "https:"
  || mobileUrl.origin !== LOCAL801_MOBILE_APP_ORIGIN
  || mobileUrl.pathname !== "/"
  || mobileUrl.search
  || mobileUrl.hash
) {
  throw new Error(`LOCAL801_MOBILE_APP_URL must be exactly ${LOCAL801_MOBILE_APP_ORIGIN}.`);
}

const config: CapacitorConfig = {
  appId: LOCAL801_MOBILE_APP_ID,
  appName: "Local 801 Engage",
  webDir: "native-shell",
  backgroundColor: "#ffffff",
  loggingBehavior: "debug",
  server: {
    url: mobileUrl.toString(),
    cleartext: false,
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
    allowsLinkPreview: false,
    webContentsDebuggingEnabled: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      launchShowDuration: 10000,
      backgroundColor: "#134D8C",
      showSpinner: false,
    },
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#134D8C",
      overlaysWebView: false,
    },
  },
};

export default config;
