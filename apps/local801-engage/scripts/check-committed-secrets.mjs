import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const detectors = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["github-token", /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/],
  ["stripe-live-secret", /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

const findings = [];
for (const file of files) {
  let source;
  try { source = await readFile(file, "utf8"); }
  catch { continue; }
  if (source.includes("\0")) continue;
  for (const [name, pattern] of detectors) {
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) findings.push({ file, line: index + 1, detector: name });
    }
  }
}

if (findings.length) {
  for (const finding of findings) {
    console.error(`Potential committed secret: ${finding.file}:${finding.line} (${finding.detector})`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${files.length} tracked file(s).`);
}
