import { readFile, writeFile } from "node:fs/promises";

const packagePath = new URL("../ios/App/CapApp-SPM/Package.swift", import.meta.url);
const source = await readFile(packagePath, "utf8");
const normalized = source.replaceAll("..\\..\\..\\node_modules\\", "../../../node_modules/")
  .replaceAll("@capacitor\\", "@capacitor/");

for (const plugin of ["app", "local-notifications", "push-notifications"]) {
  if (!normalized.includes(`../../../node_modules/@capacitor/${plugin}`)) {
    throw new Error(`Capacitor Swift package is missing @capacitor/${plugin}.`);
  }
}

if (normalized !== source) await writeFile(packagePath, normalized, "utf8");
