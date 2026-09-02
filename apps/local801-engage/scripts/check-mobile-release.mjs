import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMobileReleaseState } from "./lib/mobile-release-policy.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = getMobileReleaseState();
const requiredFiles = [
  "android/app/build.gradle",
  "android/app/src/main/AndroidManifest.xml",
  "ios/App/App.xcodeproj/project.pbxproj",
  "ios/App/App/App.entitlements",
  "resources/icon.png",
  "resources/splash.png",
];

for (const relativePath of requiredFiles) {
  if (!existsSync(path.join(appRoot, relativePath))) state.blockers.push(`MISSING_${relativePath.replaceAll(/[\\/.\-]/g, "_").toUpperCase()}`);
}

state.ready = state.blockers.length === 0;
if (!state.ready) {
  console.error(`Local 801 mobile release blocked: ${state.blockers.join(", ")}`);
  process.exit(1);
}

console.log("Local 801 mobile release gate passed.");
