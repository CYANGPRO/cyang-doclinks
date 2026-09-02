import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMobileReleaseState } from "./lib/mobile-release-policy.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformArgument = process.argv.find((argument) => argument.startsWith("--platform="));
const platform = platformArgument?.slice("--platform=".length) || "all";
const state = getMobileReleaseState(process.env, platform);
const requiredFiles = [
  "resources/icon.png",
  "resources/splash.png",
];

if (platform !== "ios") requiredFiles.push(
  "android/app/build.gradle",
  "android/app/src/main/AndroidManifest.xml",
);
if (platform !== "android") requiredFiles.push(
  "ios/App/App.xcodeproj/project.pbxproj",
  "ios/App/App/App.entitlements",
  "ios/App/App/PrivacyInfo.xcprivacy",
);

for (const relativePath of requiredFiles) {
  if (!existsSync(path.join(appRoot, relativePath))) state.blockers.push(`MISSING_${relativePath.replaceAll(/[\\/.\-]/g, "_").toUpperCase()}`);
}

state.ready = state.blockers.length === 0;
if (!state.ready) {
  console.error(`Local 801 mobile release blocked: ${state.blockers.join(", ")}`);
  process.exit(1);
}

console.log(`Local 801 ${platform} mobile release gate passed.`);
