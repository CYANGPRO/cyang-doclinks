import { expect, test } from "@playwright/test";
import {
  assertRestoreVerificationReady,
  readRestoreVerificationSnapshot,
  recordRecoveryDrill,
} from "../scripts/lib/restore-verify.mjs";

test.describe("restore verification runtime proofs", () => {
  test("reads restore verification counts and readiness flags deterministically", async () => {
    const calls: string[] = [];
    const sql = {
      unsafe: async (query: string) => {
        calls.push(query);
        return [
          {
            docs_count: "4",
            share_tokens_count: "9",
            immutable_audit_count: "12",
            recovery_drills_ready: "public.recovery_drills",
            schema_migrations_ready: "public.schema_migrations",
          },
        ];
      },
    };

    const summary = await readRestoreVerificationSnapshot({ sql });
    expect(summary).toEqual({
      docsCount: 4,
      shareTokensCount: 9,
      immutableAuditCount: 12,
      recoveryDrillsReady: true,
      schemaMigrationsReady: true,
    });
    expect(calls).toHaveLength(1);
  });

  test("fails loudly when migrations are not current", async () => {
    await expect(
      assertRestoreVerificationReady({
        sql: {},
        requireCurrentMigrations: true,
        getMigrationStatus: async () => ({
          pending: ["0034__backup_recovery.sql"],
          drift: [],
        }),
      })
    ).rejects.toThrow("Restore verification failed because migrations are not current.");
  });

  test("records recovery drill results with actionable metadata", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const now = new Date("2026-03-25T12:00:00.000Z");
    const sql = {
      unsafe: async (query: string, values: unknown[]) => {
        writes.push({ query, values });
        return [];
      },
    };

    await recordRecoveryDrill({
      sql,
      status: "success",
      notes: "nightly restore proof",
      requireCurrentMigrations: true,
      now,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].values[0]).toBe("success");
    expect(writes[0].values[1]).toBe("nightly restore proof");
    expect(String(writes[0].values[2])).toContain(now.toISOString());
    expect(String(writes[0].values[2])).toContain('"requireCurrentMigrations":true');
  });
});
