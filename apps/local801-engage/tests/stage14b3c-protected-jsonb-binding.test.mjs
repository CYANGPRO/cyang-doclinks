import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

test("protected runtime JSON parameters are not cast directly to jsonb", async () => {
  const names = (await readdir(new URL("../src/lib/", import.meta.url)))
    .filter((name) => name.startsWith("pii-") && name.endsWith(".ts"));

  const unsafePatterns = [
    /jsonb_to_recordset\(\$\d+::jsonb\)/g,
    /jsonb_array_length\(\$\d+::jsonb\)/g,
    /jsonb_array_elements_text\(\$\d+::jsonb\)/g,
  ];

  for (const name of names) {
    const source = await readFile(
      new URL(`../src/lib/${name}`, import.meta.url),
      "utf8",
    );

    for (const pattern of unsafePatterns) {
      assert.doesNotMatch(
        source,
        pattern,
        `${name} has an unsafe direct JSONB parameter binding`,
      );
    }
  }
});
