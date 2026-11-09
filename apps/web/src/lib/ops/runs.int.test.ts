// @vitest-environment node
/**
 * 运行台账与触发器状态读取（M14 Step 3）：真实临时 MySQL。
 * 台账/状态表由管线自治建表，web 只读：表不存在时降级（null / ledgerMissing），其余错误照常抛出；
 * 分页带 anyRunning（不限当前页）、恢复点按类别过滤、下载链接只认备份卷相对路径。
 */
import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  backupDownloadHref,
  listOpsRunPage,
  listOpsTriggerStates,
  listSuccessfulRuns,
} from "./runs";

let tdb: TempDb;

const LEDGER_DDL = sql`
  CREATE TABLE ops_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    kind ENUM('db','storage','restore','drill','holiday') NOT NULL,
    task_key VARCHAR(64) NULL,
    trigger_source ENUM('cron','manual','once') NOT NULL,
    status ENUM('running','success','failed') NOT NULL,
    path VARCHAR(255) NULL, size_bytes BIGINT UNSIGNED NULL, detail TEXT NULL, error TEXT NULL,
    started_at DATETIME NOT NULL, finished_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const STATE_DDL = sql`
  CREATE TABLE ops_trigger_state (
    trigger_key VARCHAR(96) NOT NULL PRIMARY KEY,
    task_key VARCHAR(64) NOT NULL,
    next_fire_at DATETIME NULL,
    last_fired_at DATETIME NULL,
    last_run_id BIGINT UNSIGNED NULL,
    last_result ENUM('success','failed','skipped') NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_task (task_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/** 与管线 ledger.py 的建表语句同构的最小表（台账归管线管，这里只为读路径造数） */
async function seedLedger() {
  await getWebDb().execute(LEDGER_DDL);
  await getWebDb().execute(sql`
    INSERT INTO ops_runs (kind, task_key, trigger_source, status, path, size_bytes, started_at, finished_at) VALUES
      ('db', 'backup.db', 'cron', 'success', '/data/backups/db/a.sql.gz', 4700000, '2026-11-09 03:10:00', '2026-11-09 03:10:05'),
      ('storage', 'backup.storage', 'manual', 'running', NULL, NULL, '2026-11-09 12:00:00', NULL)
  `);
}

describe.skipIf(skipDb)("运行台账与触发器状态读取（临时库）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("表不存在（管线未部署）：分页带 ledgerMissing、状态返回 null", async () => {
    expect(await listOpsRunPage(1)).toEqual({
      rows: [],
      hasMore: false,
      anyRunning: false,
      ledgerMissing: true,
    });
    expect(await listOpsTriggerStates()).toBeNull();
    expect(await listSuccessfulRuns("db", 5)).toEqual([]);
  });

  describe("表就绪", () => {
    beforeAll(seedLedger);

    it("分页：按 id 倒序、字段归一；anyRunning 全局判定（与当前页内容无关）", async () => {
      const page1 = await listOpsRunPage(1);
      expect(page1.ledgerMissing).toBe(false);
      expect(page1.rows.map((r) => [r.id, r.status])).toEqual([
        [2, "running"],
        [1, "success"],
      ]);
      expect(page1.anyRunning).toBe(true);

      // 第 2 页：没有更多数据，但 anyRunning 仍为 true（不能依赖翻到第几页）
      const page2 = await listOpsRunPage(2);
      expect(page2.rows).toEqual([]);
      expect(page2.hasMore).toBe(false);
      expect(page2.anyRunning).toBe(true);

      await getWebDb().execute(sql`UPDATE ops_runs SET status = 'success' WHERE id = 2`);
      expect((await listOpsRunPage(2)).anyRunning).toBe(false);
    });

    it("触发器状态读取", async () => {
      await getWebDb().execute(STATE_DDL);
      await getWebDb().execute(sql`
        INSERT INTO ops_trigger_state
          (trigger_key, task_key, next_fire_at, last_fired_at, last_run_id, last_result, updated_at)
        VALUES ('t1', 'backup.db', '2026-11-10 03:10:00', '2026-11-09 03:10:00', 1, 'success', NOW()),
               ('t2', 'backup.storage', NULL, NULL, NULL, NULL, NOW())
      `);
      const states = await listOpsTriggerStates();
      expect(states).toEqual([
        {
          triggerKey: "t1",
          taskKey: "backup.db",
          nextFireAt: "2026-11-10 03:10:00",
          lastFiredAt: "2026-11-09 03:10:00",
          lastRunId: 1,
          lastResult: "success",
        },
        {
          triggerKey: "t2",
          taskKey: "backup.storage",
          nextFireAt: null,
          lastFiredAt: null,
          lastRunId: null,
          lastResult: null,
        },
      ]);
    });

    it("恢复点：只取成功的 db 备份、倒序限量", async () => {
      // 前面用例已把 id=2（storage）改为 success，这里只断言类别过滤与倒序，不假设库中只有自己的行
      await getWebDb().execute(sql`
        INSERT INTO ops_runs (kind, task_key, trigger_source, status, path, size_bytes, started_at, finished_at) VALUES
          ('db', 'backup.db', 'manual', 'success', '/data/backups/db/b.sql.gz', 4800000, '2026-11-10 03:10:00', '2026-11-10 03:10:05'),
          ('db', 'backup.db', 'manual', 'failed', '/data/backups/db/broken.sql.gz', 100, '2026-11-10 04:00:00', '2026-11-10 04:00:01'),
          ('storage', 'backup.storage', 'cron', 'success', '/data/backups/storage/s.tgz', 100, '2026-11-10 04:00:00', '2026-11-10 04:00:01')
      `);
      expect((await listSuccessfulRuns("db", 5)).map((r) => [r.id, r.sizeBytes])).toEqual([
        [3, 4800000],
        [1, 4700000],
      ]);
      const storage = await listSuccessfulRuns("storage", 5);
      expect(storage.map((r) => r.id).sort((a, b) => b - a)).toEqual([5, 2]);
      expect(storage.every((r) => r.kind === "storage" && r.status === "success")).toBe(true);
    });

    it("下载链接：只认备份卷相对路径，其余（NULL/未知形态）不给链接", () => {
      expect(backupDownloadHref("/data/backups/db/a.sql.gz")).toBe(
        "/admin/ops/download?path=db%2Fa.sql.gz",
      );
      expect(backupDownloadHref("/data/backups/storage/s.tgz")).toBe(
        "/admin/ops/download?path=storage%2Fs.tgz",
      );
      expect(backupDownloadHref(null)).toBeNull();
      expect(backupDownloadHref("/etc/passwd")).toBeNull();
      expect(backupDownloadHref("/data/backups/db/x.zip")).toBeNull();
    });

    it("表存在但结构坏了（真故障）：照常抛错，不被当成「未部署」掩盖", async () => {
      await getWebDb().execute(sql`ALTER TABLE ops_runs DROP COLUMN task_key`);
      await expect(listOpsRunPage(1)).rejects.toThrow();
    });
  });
});
