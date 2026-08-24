import "server-only";

import postgres from "postgres";
import { getDatabaseConfig } from "./config.ts";
import {
  augmentPiiDualWriteTransactionStatements,
  preparePiiDualWriteDirectQuery,
} from "./pii-dual-write.ts";
import { rewriteProtectedImportWorkerStatements } from "./pii-protected-import-worker.ts";
import { preparePiiProtectedLookupQuery } from "./pii-protected-query.ts";
import {
  augmentPiiProtectedTransactionStatements,
  preparePiiProtectedDirectQuery,
} from "./pii-protected-write.ts";

export type DatabaseRow = Record<string, unknown>;
export type DatabaseQuery = <T extends DatabaseRow>(
  query: string,
  parameters?: readonly unknown[],
) => Promise<T[]>;
export type DatabaseStatement = { sql: string; parameters?: readonly unknown[] };

const globalForDb = globalThis as unknown as { local801Sql?: ReturnType<typeof postgres> };
let queryOverride: DatabaseQuery | null = null;

export function getLocal801DatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  return getDatabaseConfig(env).LOCAL801_DATABASE_URL;
}

function sqlParameters(parameters: readonly unknown[]) {
  return [...parameters] as never[];
}

function getSql() {
  if (!globalForDb.local801Sql) {
    globalForDb.local801Sql = postgres(getLocal801DatabaseUrl(), {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
    });
  }
  return globalForDb.local801Sql;
}

const defaultQueryLocal801: DatabaseQuery = async <T extends DatabaseRow>(
  query: string,
  parameters: readonly unknown[] = [],
) => {
  const protectedLookup = preparePiiProtectedLookupQuery(query, parameters);
  const protectedPrepared = protectedLookup ? null : preparePiiProtectedDirectQuery(query, parameters);
  const dualWritePrepared = protectedLookup || protectedPrepared ? null : preparePiiDualWriteDirectQuery(query, parameters);
  const prepared = protectedLookup ?? protectedPrepared ?? dualWritePrepared;
  const sql = getSql();
  const rows = prepared
    ? await sql.unsafe(prepared.sql, sqlParameters(prepared.parameters))
    : await sql.unsafe(query, sqlParameters(parameters));
  return rows as unknown as T[];
};

/** Test seam. Runtime code always uses the dedicated Local 801 database implementation. */
export function setLocal801QueryForTests(query: DatabaseQuery | null) {
  queryOverride = query;
}

export const queryLocal801: DatabaseQuery = <T extends DatabaseRow>(
  query: string,
  parameters: readonly unknown[] = [],
) => (queryOverride ?? defaultQueryLocal801)<T>(query, parameters);

function transactionStage(sql: string) {
  if (/\/\*\s*pii-protected-write:gate\s*\*\//i.test(sql)) return "PII_PROTECTED_WRITE_GATE";
  if (/\/\*\s*pii-protected-write:user-companion\s*\*\//i.test(sql)) return "PII_PROTECTED_USER_COMPANION";
  if (/\/\*\s*pii-protected-write:import-row-companions\s*\*\//i.test(sql)) return "PII_PROTECTED_IMPORT_ROW_COMPANION";
  if (/\/\*\s*pii-protected-write:exact-indexes\s*\*\//i.test(sql)) return "PII_PROTECTED_EXACT_INDEX";
  if (/\/\*\s*pii-protected-import-worker:validate-authoritative-identity\s*\*\//i.test(sql)) return "PII_PROTECTED_IMPORT_VALIDATE_IDENTITY";
  if (/\/\*\s*pii-protected-import-worker:validate-work-email\s*\*\//i.test(sql)) return "PII_PROTECTED_IMPORT_VALIDATE_EMAIL";
  if (/\/\*\s*pii-protected-import-worker:validate-duplicate-identity\s*\*\//i.test(sql)) return "PII_PROTECTED_IMPORT_VALIDATE_DUPLICATE";
  if (/\/\*\s*pii-protected-import-worker:match-identities\s*\*\//i.test(sql)) return "PII_PROTECTED_IMPORT_MATCH";
  if (/\/\*\s*pii-dual-write:gate\s*\*\//i.test(sql)) return "PII_DUAL_WRITE_GATE";
  if (/\/\*\s*pii-dual-write:user\s*\*\//i.test(sql)) return "PII_USER_COMPANION";
  if (/\/\*\s*pii-dual-write:exact-indexes\s*\*\//i.test(sql)) return "PII_EXACT_INDEX";
  if (/insert\s+into\s+local801\.import_sheets/i.test(sql)) return "IMPORT_SHEET_INSERT";
  if (/insert\s+into\s+local801\.import_mappings/i.test(sql)) return "IMPORT_MAPPING_INSERT";
  if (/insert\s+into\s+local801\.import_rows/i.test(sql)) return "IMPORT_ROW_INSERT";
  if (/insert\s+into\s+local801\.import_match_candidates/i.test(sql)) return "IMPORT_MATCH_INSERT";
  if (/insert\s+into\s+local801\.import_errors/i.test(sql)) return "IMPORT_ERROR_INSERT";
  if (/update\s+local801\.import_rows/i.test(sql)) return "IMPORT_ROW_UPDATE";
  if (/update\s+local801\.import_batches/i.test(sql)) return "IMPORT_BATCH_UPDATE";
  if (/insert\s+into\s+local801\.audit_events/i.test(sql)) return "AUDIT_INSERT";
  if (/insert\s+into\s+local801\.users/i.test(sql)) return "USER_PROVISION";
  return "TRANSACTION_STATEMENT";
}

function safeTransactionFailure(error: unknown, stage: string) {
  const wrapped = new Error("Local 801 transaction statement failed.");
  wrapped.name = `Local801TransactionError:${stage}`;
  if (error && typeof error === "object") {
    const source = error as Record<string, unknown>;
    const target = wrapped as Error & Record<string, unknown>;
    for (const key of ["code", "constraint", "constraint_name", "table", "table_name"] as const) {
      if (typeof source[key] === "string") target[key] = source[key];
    }
  }
  return wrapped;
}

/** Executes a bounded group of Local 801 writes atomically. */
export async function runLocal801Transaction(statements: readonly DatabaseStatement[]) {
  if (statements.length === 0) return;
  const protectedWorkerStatements = rewriteProtectedImportWorkerStatements(statements);
  const protectedStatements = augmentPiiProtectedTransactionStatements(protectedWorkerStatements);
  const guardedStatements = protectedStatements === protectedWorkerStatements
    ? augmentPiiDualWriteTransactionStatements(protectedWorkerStatements)
    : protectedStatements;
  const sql = getSql();
  await sql.begin(async (transaction) => {
    for (const statement of guardedStatements) {
      try {
        await transaction.unsafe(statement.sql, sqlParameters(statement.parameters ?? []));
      } catch (error) {
        throw safeTransactionFailure(error, transactionStage(statement.sql));
      }
    }
  });
}

/**
 * Transaction callback for reviewed SQL that does not need the PII mutation rewriters.
 * PII writes must use runLocal801Transaction so companion/index writes stay atomic.
 */
export async function withLocal801Transaction<T>(callback: (query: DatabaseQuery) => Promise<T>) {
  const sql = getSql();
  return sql.begin(async (transaction) => {
    const query: DatabaseQuery = async <R extends DatabaseRow>(
      statement: string,
      parameters: readonly unknown[] = [],
    ) => {
      const rows = await transaction.unsafe(statement, sqlParameters(parameters));
      return rows as unknown as R[];
    };
    return callback(query);
  }) as Promise<T>;
}

export type DatabaseReadiness = { database: "ok" | "error" };

export async function checkDatabaseReadiness(query: DatabaseQuery = queryLocal801): Promise<DatabaseReadiness> {
  try {
    const [result] = await query<{
      connected: boolean;
      has_local801: boolean;
      has_reporting: boolean;
      has_core_tables: boolean;
    }>(`
      SELECT
        true AS connected,
        to_regnamespace('local801') IS NOT NULL AS has_local801,
        to_regnamespace('reporting') IS NOT NULL AS has_reporting,
        to_regclass('local801.organizations') IS NOT NULL
          AND to_regclass('local801.users') IS NOT NULL
          AND to_regclass('local801.people') IS NOT NULL
          AND to_regclass('local801.membership_snapshots') IS NOT NULL
          AND to_regclass('local801.outreach_campaigns') IS NOT NULL
          AND to_regclass('local801.engagement_assignments') IS NOT NULL
          AND to_regclass('local801.import_files') IS NOT NULL
          AND to_regclass('local801.generated_reports') IS NOT NULL
          AND to_regclass('local801.documents') IS NOT NULL
          AS has_core_tables
    `);
    return result?.connected && result.has_local801 && result.has_reporting && result.has_core_tables
      ? { database: "ok" }
      : { database: "error" };
  } catch {
    return { database: "error" };
  }
}

export async function checkDatabaseConnection() {
  return (await checkDatabaseReadiness()).database === "ok";
}

export async function closeDatabaseForTests() {
  if (process.env.NODE_ENV === "production") return;
  const sql = globalForDb.local801Sql;
  if (sql) {
    await sql.end({ timeout: 1 });
    globalForDb.local801Sql = undefined;
  }
}