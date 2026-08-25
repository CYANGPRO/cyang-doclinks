import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/app/api/", import.meta.url));

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? routeFiles(join(directory, entry.name))
    : entry.name === "route.ts" ? [join(directory, entry.name)] : []));
  return nested.flat();
}

const authenticationPatterns = [
  /requirePreviewUser\(/,
  /authorizeWorkspaceMutation\(/,
  /authorizeCampaignMutation\(/,
  /authorizeCatActionMutation\(/,
  /authorizeTeamMutation\(/,
  /authorizeWorkPreferenceMutation\(/,
  /authorizeMemberEmailMutation\(/,
  /verifyPreviewCsrfToken\(/,
];
const originPatterns = [
  /hasExactSameOrigin\(/,
  /authorizeWorkspaceMutation\(/,
  /authorizeCampaignMutation\(/,
  /authorizeCatActionMutation\(/,
  /authorizeTeamMutation\(/,
  /authorizeWorkPreferenceMutation\(/,
  /authorizeMemberEmailMutation\(/,
  /verifyPreviewCsrfToken\(/,
];

const failures = [];
let routeCount = 0;
let mutationCount = 0;
for (const file of await routeFiles(root)) {
  const source = await readFile(file, "utf8");
  const name = relative(root, file).replaceAll("\\", "/");
  const methods = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]);
  const nextAuthHandler = name === "auth/[...nextauth]/route.ts";
  if (methods.length === 0 && !nextAuthHandler) failures.push(`${name}: no explicit Route Handler method`);
  routeCount += 1;
  if (!nextAuthHandler && !authenticationPatterns.some((pattern) => pattern.test(source))) {
    failures.push(`${name}: missing server authentication/authorization boundary`);
  }
  if (methods.some((method) => method !== "GET")) {
    mutationCount += 1;
    if (!originPatterns.some((pattern) => pattern.test(source))) failures.push(`${name}: mutation missing same-origin/CSRF boundary`);
  }
  if (/Cache-Control[^\n]*(?:public|max-age=[1-9])/i.test(source) && !name.startsWith("auth/")) {
    failures.push(`${name}: protected route appears publicly cacheable`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`Route security audit failed: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Route security audit passed for ${routeCount} Route Handler(s), including ${mutationCount} mutation surface(s).`);
}
