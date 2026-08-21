import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationDir = new URL("../db/migrations/", import.meta.url);
const migrationPath = fileURLToPath(migrationDir);
const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();

if (files.length === 0) {
  throw new Error("No Local 801 Engage migrations found.");
}

files.forEach((file, index) => {
  const expected = String(index + 1).padStart(4, "0");
  if (!file.startsWith(`${expected}__`)) {
    throw new Error(`Migration ${file} is out of order; expected prefix ${expected}__.`);
  }
});

for (const file of files) {
  const sql = await readFile(join(migrationPath, file), "utf8");
  if (/public\.documents|public\.shares|stripe|billing|share_token/i.test(sql)) {
    throw new Error(`${file} appears to reference DocLinks-only tables or billing concepts.`);
  }
  if (!/organization_id/i.test(sql)) {
    throw new Error(`${file} does not include organization scoping.`);
  }
}

console.log(`Verified ${files.length} Local 801 Engage migration(s).`);
