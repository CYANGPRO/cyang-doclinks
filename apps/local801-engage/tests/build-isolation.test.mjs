import assert from "node:assert/strict";
import test from "node:test";

test("CAT owns an explicit PostCSS configuration and does not inherit DocLinks plugins", async () => {
  const { default: config } = await import("../postcss.config.mjs");
  assert.deepEqual(config, { plugins: {} });
});
