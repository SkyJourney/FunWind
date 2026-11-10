// @vitest-environment node
/**
 * ops.alerts 告警任务（M14 Step 5，D11）：真实临时库——台账注入失败行 + admin 角色接收人，
 * 断言通知生成（category=system、dedup 幂等）与降级语义（台账缺失 / 无管理员时静默）。
 */
import { eq } from "drizzle-orm";
import { getWebDb, notifications, roles, userRoles, users } from "@funwind/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { opsAlertsJob } from "./tasks";

let tdb: TempDb;
const ADMIN_ID = 98001;
const SECOND_ADMIN_ID = 98002;
const db = () => getWebDb();

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

async function seedAdmin() {
  // 演示种子自带 admin 授予（DEMO.admin）：先清成确定性单管理员，再补最小用户行 + admin 角色
  await db().delete(userRoles).where(eq(userRoles.roleKey, "admin"));
  await db().delete(users).where(eq(users.id, ADMIN_ID));
  await db()
    .insert(users)
    .values({
      id: ADMIN_ID,
      username: "ops_alert_admin",
      usernameKey: "ops_alert_admin",
      state: "active",
      createdAt: sql`NOW()`,
    });
  await db()
    .insert(userRoles)
    .values({ userId: ADMIN_ID, roleKey: "admin", grantedAt: sql`NOW()` });
}

async function seedFailedRun(id: number, taskKey = "backup.db") {
  await db().execute(sql`
    INSERT INTO ops_runs (id, kind, task_key, trigger_source, status, error, started_at, finished_at)
    VALUES (${id}, 'db', ${taskKey}, 'cron', 'failed', 'E2E 注入的失败原因', NOW(), NOW())
  `);
}

async function alertTexts() {
  const rows = await db()
    .select({
      userId: notifications.userId,
      data: notifications.data,
      dedupKey: notifications.dedupKey,
    })
    .from(notifications)
    .where(eq(notifications.type, "ops.run.failed"));
  return rows;
}

beforeAll(async () => {
  tdb = await setupTempDb();
  await db().execute(LEDGER_DDL);
  await seedAdmin();
});
afterAll(async () => {
  await tdb?.teardown();
});
afterEach(async () => {
  await db().execute(sql`DELETE FROM notifications WHERE 1 = 1`);
  await db().execute(sql`DELETE FROM ops_runs WHERE 1 = 1`);
});

describe.skipIf(skipDb)("ops.alerts 告警任务（临时库）", () => {
  it("台账缺失（管线未部署）：静默跳过不抛错", async () => {
    await db().execute(sql`DROP TABLE ops_runs`);
    const job = opsAlertsJob();
    await expect(job.run()).resolves.toMatchObject({ summary: expect.stringContaining("skipped") });
    // 恢复表给后续用例
    await db().execute(LEDGER_DDL);
  });

  it("失败运行 → 管理员收到 system 类告警；dedup 幂等（重扫不重复）", async () => {
    await seedFailedRun(101);
    const job = opsAlertsJob();
    const first = await job.run();
    expect(first.summary).toContain("notified=1");
    const rows = await alertTexts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ADMIN_ID, dedupKey: `ops-failed:101:${ADMIN_ID}` });
    const data = rows[0]!.data as { task: string; runId: number; error: string };
    expect(data).toMatchObject({ task: "backup.db", runId: 101, error: "E2E 注入的失败原因" });

    // 重扫（dedup 兜底，不重复打扰）
    const second = await job.run();
    expect(second.summary).toContain("notified=1");
    expect((await alertTexts()).length).toBe(1);
  });

  it("多个管理员：每人各收一条（uq_nf_dedup 是全局唯一索引，dedupKey 须含接收人）", async () => {
    await db().delete(users).where(eq(users.id, SECOND_ADMIN_ID));
    await db()
      .insert(users)
      .values({
        id: SECOND_ADMIN_ID,
        username: "ops_alert_admin2",
        usernameKey: "ops_alert_admin2",
        state: "active",
        createdAt: sql`NOW()`,
      });
    await db()
      .insert(userRoles)
      .values({ userId: SECOND_ADMIN_ID, roleKey: "admin", grantedAt: sql`NOW()` });
    try {
      await seedFailedRun(111);
      const job = opsAlertsJob();
      expect((await job.run()).summary).toContain("admins=2");
      const recipients = (await alertTexts()).map((row) => row.userId).sort((a, b) => a - b);
      expect(recipients).toEqual([ADMIN_ID, SECOND_ADMIN_ID]);

      // 重扫：两人都不重复
      await job.run();
      expect((await alertTexts()).length).toBe(2);
    } finally {
      await db().delete(userRoles).where(eq(userRoles.userId, SECOND_ADMIN_ID));
      await db().delete(users).where(eq(users.id, SECOND_ADMIN_ID));
    }
  });

  it("成功与执行中的运行不告警；无管理员时静默跳过", async () => {
    await db().execute(sql`
      INSERT INTO ops_runs (id, kind, task_key, trigger_source, status, started_at, finished_at) VALUES
        (201, 'db', 'backup.db', 'cron', 'success', NOW(), NOW()),
        (202, 'db', 'backup.db', 'cron', 'running', NOW(), NULL)
    `);
    const job = opsAlertsJob();
    const r = await job.run();
    expect(r.summary).toContain("failed=0");
    expect((await alertTexts()).length).toBe(0);

    // 摘掉 admin 角色：无可接收人 → skipped
    const [grant] = await db()
      .select({ id: userRoles.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.key, userRoles.roleKey))
      .where(eq(userRoles.userId, ADMIN_ID))
      .limit(1);
    await db().delete(userRoles).where(eq(userRoles.id, grant!.id));
    await seedFailedRun(203);
    const after = await job.run();
    expect(after.summary).toContain("无可接收告警的管理员");
    await db()
      .insert(userRoles)
      .values({ userId: ADMIN_ID, roleKey: "admin", grantedAt: sql`NOW()` });
  });

  it("通知类型已注册且强制送达（category=system，偏好不可关）", async () => {
    const { getNotificationTypeDecls } = await import("@/modules/kernel/registry");
    const decls = getNotificationTypeDecls().filter((d) => d.def.key === "ops.run.failed");
    expect(decls).toHaveLength(1);
    expect(decls[0]!.def).toMatchObject({ category: "system", mandatory: true });
  });
});
