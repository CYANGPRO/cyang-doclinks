import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../scripts/backfill-pii-preview-v2.mjs", import.meta.url), "utf8");

test("backfill recordsets force stringified JSON through text before jsonb", () => {
  const recordsets = source.match(/jsonb_to_recordset\([^\n]+/g) ?? [];
  assert.ok(recordsets.length >= 7, "expected all protected bulk-write recordsets to be present");
  for (const recordset of recordsets) {
    assert.match(recordset, /::text::jsonb\)/, `unsafe JSONB binding found: ${recordset}`);
  }
  assert.doesNotMatch(source, /JSON\.stringify\(group\)\}::jsonb/);
  assert.doesNotMatch(source, /\$1::jsonb\)/);
});
