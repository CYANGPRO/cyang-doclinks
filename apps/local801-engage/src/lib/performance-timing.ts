import "server-only";

type TimingKind = "database" | "server";

const operationPattern = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
const labelPattern = /\/\*\s*([a-z0-9][a-z0-9:._-]{0,79})\s*\*\//i;

function enabled(env: NodeJS.ProcessEnv = process.env) {
  return env.LOCAL801_PERFORMANCE_TIMING_ENABLED === "1"
    || (env.LOCAL801_PERFORMANCE_TIMING_ENABLED !== "0" && env.VERCEL_ENV === "production");
}

function safeOperation(value: string) {
  const normalized = value.trim().toLowerCase();
  return operationPattern.test(normalized) ? normalized : "unlabeled";
}

export function databaseOperation(statement: string) {
  return safeOperation(statement.match(labelPattern)?.[1] ?? "unlabeled");
}

export function slowQueryThreshold(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(env.LOCAL801_SLOW_QUERY_MS ?? 150);
  return Number.isFinite(configured) ? Math.min(5_000, Math.max(25, Math.round(configured))) : 150;
}

function writeTiming(kind: TimingKind, operation: string, durationMs: number, outcome: "ok" | "error", rows?: number) {
  if (!enabled()) return;
  console.info("[local801-performance]", JSON.stringify({
    kind,
    operation: safeOperation(operation),
    durationMs: Math.round(durationMs * 10) / 10,
    outcome,
    ...(typeof rows === "number" ? { rows } : {}),
  }));
}

export async function measureDatabaseQuery<T extends readonly unknown[]>(statement: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const rows = await operation();
    const durationMs = performance.now() - startedAt;
    if (durationMs >= slowQueryThreshold()) writeTiming("database", databaseOperation(statement), durationMs, "ok", rows.length);
    return rows;
  } catch (error) {
    writeTiming("database", databaseOperation(statement), performance.now() - startedAt, "error");
    throw error;
  }
}

export async function measureServerOperation<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await operation();
    writeTiming("server", operationName, performance.now() - startedAt, "ok");
    return result;
  } catch (error) {
    writeTiming("server", operationName, performance.now() - startedAt, "error");
    throw error;
  }
}

export const __testing = { enabled, safeOperation };
