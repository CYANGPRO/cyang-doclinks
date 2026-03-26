#!/usr/bin/env node

import { assertProofCliEntrypointsWork, assertProofToolingInstalled } from "./lib/proof-install.mjs";

try {
  assertProofToolingInstalled();
  assertProofCliEntrypointsWork();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Proof install verification failed: ${message}`);
  process.exit(1);
}
