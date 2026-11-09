// @vitest-environment node
/**
 * 运行台账读取（M14 Step 2）：真实临时 MySQL。
 * 台账表由管线自治建表，web 只读：表不存在时返回 null（零表韧性，F12），其余错误照常抛出。
 */
import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { listOpsRuns } from "./runs";

let tdb: TempDb;

describe.skipIf(skipDb)("运行台账读取（临时库）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("台账表不存在（管线未部署）：返回 null 而不是抛错", async () => {
    expect(await listOpsRuns()).toBeNull();
  });

  it("台账表存在：按 id 倒序取最近 N 条，字段归一", async () => {
    // 与管线 ledger.py 的 LEDGER_DDL 同构的最小表（台账归管线管，这里只为读路径造数）
    await getWebDb().execute(sql`
      CREATE TABLE ops_runs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        kind ENUM('db','storage','restore','drill','holiday') NOT NULL,
        task_key VARCHAR(64) NULL,
        trigger_source ENUM('cron','manual','once') NOT NULL,
        status ENUM('running','success','failed') NOT NULL,
        path VARCHAR(255) NULL, size_bytes BIGINT UNSIGNED NULL, detail TEXT NULL, error TEXT NULL,
        started_at DATETIME NOT NULL, finished_at DATETIME NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await getWebDb().execute(sql`
      INSERT INTO ops_runs (kind, task_key, trigger_source, status, path, size_bytes, started_at, finished_at) VALUES
        ('db', 'backup.db', 'cron', 'success', '/data/backups/db/a.sql.gz', 4700000, '2026-11-09 03:10:00', '2026-11-09 03:10:05'),
        ('storage', 'backup.storage', 'manual', 'running', NULL, NULL, '2026-11-09 12:00:00', NULL)
    `);
    const runs = await listOpsRuns(1);
    expect(runs).toEqual([
      {
        id: 2,
        kind: "storage",
        taskKey: "backup.storage",
        trigger: "manual",
        status: "running",
        path: null,
        sizeBytes: null,
        detail: null,
        error: null,
        startedAt: "2026-11-09 12:00:00",
        finishedAt: null,
      },
    ]);
    expect((await listOpsRuns(5))?.map((r) => [r.id, r.sizeBytes, r.finishedAt])).toEqual([
      [2, null, null],
      [1, 4700000, "2026-11-09 03:10:05"],
    ]);
  });

  it("表存在但结构坏了（真故障）：照常抛错，不被当成「未部署」掩盖", async () => {
    await getWebDb().execute(sql`ALTER TABLE ops_runs DROP COLUMN task_key`);
    await expect(listOpsRuns()).rejects.toThrow();
  });
});
