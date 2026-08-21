import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `tests/${name}`);

for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--experimental-strip-types", "--test", file],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const lines = combined.split(/\r?\n/);
    const failure = lines.find((line) => /AssertionError|ERR_ASSERTION|error:|not ok\b/.test(line)) ?? "Node test failed";
    const message = failure.replace(/\s+/g, " ").slice(0, 1200).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log(`::error file=${file},line=1,col=1::${message}`);
    process.exit(result.status ?? 1);
  }
}
