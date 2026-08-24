import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../src/lib/pii-protected-directory.ts", import.meta.url),
  "utf8",
);

test("protected Directory forces stringified JSON through text before jsonb", () => {
  assert.match(
    source,
    /jsonb_to_recordset\(\$11::text::jsonb\)/,
  );

  assert.match(
    source,
    /jsonb_array_length\(\$11::text::jsonb\)/,
  );

  assert.match(
    source,
    /jsonb_to_recordset\(\$3::text::jsonb\)/,
  );

  assert.doesNotMatch(source, /\$11::jsonb/);
  assert.doesNotMatch(source, /\$3::jsonb/);
});

test("protected Directory uses exact matching for the dedicated classification filter", () => {
  assert.match(
    source,
    /lower\(btrim\(person\.classification\)\) = lower\(btrim\(\$6::text\)\)/,
  );
  assert.doesNotMatch(source, /person\.classification ILIKE \$6::text/);
  assert.match(source, /normalized\.classification \|\| null/);
  assert.match(source, /person\.classification ILIKE \$8::text/);
});
