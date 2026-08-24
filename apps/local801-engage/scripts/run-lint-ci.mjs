import { ESLint } from "eslint";

function escapeWorkflowCommand(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

const eslint = new ESLint();
const results = await eslint.lintFiles(["."]);
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output) process.stdout.write(`${output}\n`);

let errors = 0;
for (const result of results) {
  for (const message of result.messages) {
    if (message.severity === 2) errors += 1;
    const level = message.severity === 2 ? "error" : "warning";
    const location = [
      `file=${escapeWorkflowCommand(result.filePath)}`,
      message.line ? `line=${message.line}` : null,
      message.column ? `col=${message.column}` : null,
      message.endLine ? `endLine=${message.endLine}` : null,
      message.endColumn ? `endColumn=${message.endColumn}` : null,
    ].filter(Boolean).join(",");
    const rule = message.ruleId ? ` [${message.ruleId}]` : "";
    console.log(`::${level} ${location}::${escapeWorkflowCommand(`${message.message}${rule}`)}`);
  }
}

if (errors > 0) process.exitCode = 1;
