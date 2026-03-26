import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const REPO_TOOL_DEFINITIONS = {
  eslint: { packageName: "eslint", binName: "eslint" },
  tsc: { packageName: "typescript", binName: "tsc" },
  next: { packageName: "next", binName: "next" },
  playwright: { packageName: "playwright", binName: "playwright" },
  "start-server-and-test": { packageName: "start-server-and-test", binName: "start-server-and-test" },
};

function getPackageJsonPath(packageName) {
  return join(REPO_ROOT, "node_modules", ...packageName.split("/"), "package.json");
}

function getPackageJson(packageName) {
  return JSON.parse(readFileSync(getPackageJsonPath(packageName), "utf8"));
}

function getBinShimPath(binName) {
  return join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? `${binName}.cmd` : binName);
}

function quoteWindowsArg(arg) {
  if (!/[ \t"&()^<>|]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export function getRepoToolStatus(toolName) {
  const definition = REPO_TOOL_DEFINITIONS[toolName];
  if (!definition) {
    throw new Error(`Unknown repo-local tool: ${toolName}`);
  }

  const packageJsonPath = getPackageJsonPath(definition.packageName);
  if (!existsSync(packageJsonPath)) {
    return {
      toolName,
      packageName: definition.packageName,
      binName: definition.binName,
      installed: false,
      executablePath: null,
    };
  }

  const pkg = getPackageJson(definition.packageName);
  const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  const packageBinRelativePath = bins[definition.binName];
  const packageBinPath = packageBinRelativePath
    ? join(REPO_ROOT, "node_modules", ...definition.packageName.split("/"), packageBinRelativePath)
    : null;
  const executablePath = getBinShimPath(definition.binName);

  return {
    toolName,
    packageName: definition.packageName,
    binName: definition.binName,
    installed: Boolean(executablePath && existsSync(executablePath)),
    executablePath,
    packageBinPath,
  };
}

export function spawnRepoTool(toolName, args = [], options = {}) {
  const status = getRepoToolStatus(toolName);
  if (!status.installed || !status.executablePath) {
    throw new Error(
      `Repo-local tool "${toolName}" is not installed under ${status.packageName}. ` +
        "Run `npm ci` and ensure proof devDependencies are present."
    );
  }

  if (toolName === "start-server-and-test" && status.packageBinPath) {
    return spawnSync(process.execPath, [status.packageBinPath, ...args], {
      shell: false,
      ...options,
    });
  }

  if (process.platform === "win32") {
    const commandLine = [quoteWindowsArg(status.executablePath), ...args.map(quoteWindowsArg)].join(" ");
    return spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
      shell: false,
      ...options,
    });
  }

  return spawnSync(status.executablePath, args, {
    shell: false,
    ...options,
  });
}
