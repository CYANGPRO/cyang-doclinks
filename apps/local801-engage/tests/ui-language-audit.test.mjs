import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../src/app", import.meta.url));
const componentRoot = fileURLToPath(new URL("../src/components", import.meta.url));

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : path.endsWith(".tsx") || path.endsWith(".ts") ? [path] : [];
  });
}

const interfaceFiles = [...filesUnder(appRoot), ...filesUnder(componentRoot)];

test("retired product and generic card language does not return", () => {
  for (const path of interfaceFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /Member 360|At a glance|Bookmarkable|Summary only/, path);
    assert.doesNotMatch(source, /title="(?:Overview|Results)"/, path);
  }
});

test("corner badges use the shared status treatment", () => {
  for (const path of interfaceFiles) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\bbadge=/g)) {
      const badgeExpression = source.slice(match.index, match.index + 250);
      assert.match(badgeExpression, /StatusBadge/, `${path}: ${badgeExpression.split(/\r?\n/)[0].trim()}`);
    }
  }
});
