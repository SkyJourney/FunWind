// @vitest-environment node
/**
 * 运维任务配置写服务（M14 Step 2）：真实临时 MySQL。
 * 覆盖：新建 / 编辑 / 乐观锁冲突 / 启停 / 删除 / 触发器增删改启停、旁路写的任务 revision+1（G-20）、
 * 审计同事务（失败不留痕）、输入校验拒绝、保留份数读写与 v1 回落、提交后热加载通知（失败不影响写入）。
 */
import { inArray, sql } from "drizzle-orm";
import { MySqlTransaction } from "drizzle-orm/mysql-core";
import { auditLog, getWebDb, opsTasks, opsTriggers, siteSettings } from "@funwind/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { writeAudit, type ConfigActor } from "@/lib/audit";
import {
  createOpsTask,
  createOpsTrigger,
  deleteOpsTask,
  deleteOpsTrigger,
  getBackupRetention,
  getManuallyTriggerableTask,
  listOpsTasks,
  recordManualTrigger,
  setBackupRetention,
  setOpsTaskEnabled,
  setOpsTriggerEnabled,
  updateOpsTask,
  updateOpsTrigger,
} from "./tasks";

// 审计透传侦听：行为不变，只记录每次写审计用的执行器（结构断言「审计必须走事务句柄」用）
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: vi.fn(actual.writeAudit) };
});

let tdb: TempDb;
const db = () => getWebDb();
const ACTOR: ConfigActor = { userId: 90004, via: "admin", ip: "127.0.0.1" };

async function opsAudits() {
  return db()
    .select({
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      before: auditLog.beforeJson,
      after: auditLog.afterJson,
    })
    .from(auditLog)
    .where(inArray(auditLog.targetType, ["ops_task", "ops_trigger"]))
    .orderBy(auditLog.id);
}

async function taskByKey(key: string) {
  const [row] = await db().select().from(opsTasks).where(eq(opsTasks.taskKey, key));
  return row;
}

/** 每个用例从同一份默认配置起步（与 bootstrap 种子同形），不留审计与 v1 设置 */
async function resetOps() {
  await db().delete(opsTriggers);
  await db().delete(opsTasks);
  await db()
    .delete(auditLog)
    .where(inArray(auditLog.targetType, ["ops_task", "ops_trigger"]));
  await db().delete(siteSettings).where(eq(siteSettings.key, "ops.backup.policy"));
  for (const [key, name, keep, cron] of [
    ["backup.db", "数据库备份", 14, "10 3 * * *"],
    ["backup.storage", "存储备份", 7, "40 3 * * *"],
  ] as const) {
    await db()
      .insert(opsTasks)
      .values({
        taskKey: key,
        name,
        executor: key,
        params: { keep },
        enabled: true,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
    await db()
      .insert(opsTriggers)
      .values([
        {
          taskKey: key,
          kind: "cron",
          expr: cron,
          enabled: true,
          revision: 1,
          createdAt: sql`NOW()`,
          updatedAt: sql`NOW()`,
        },
        {
          taskKey: key,
          kind: "manual",
          expr: null,
          enabled: true,
          revision: 1,
          createdAt: sql`NOW()`,
          updatedAt: sql`NOW()`,
        },
      ]);
  }
}

describe.skipIf(skipDb)("运维任务配置写服务（临时库）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(resetOps);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("bootstrap 种子已就位（临时库由 bootstrap 建出）；listOpsTasks 按任务带出触发器", async () => {
    const tasks = await listOpsTasks();
    expect(
      tasks.map((t) => [t.taskKey, t.params, t.triggers.map((x) => [x.kind, x.expr])]),
    ).toEqual([
      [
        "backup.db",
        { keep: 14 },
        [
          ["cron", "10 3 * * *"],
          ["manual", null],
        ],
      ],
      [
        "backup.storage",
        { keep: 7 },
        [
          ["cron", "40 3 * * *"],
          ["manual", null],
        ],
      ],
    ]);
  });

  describe("任务", () => {
    it("新建：任务 + 触发器 + 一条审计（cron 规范化）", async () => {
      const result = await createOpsTask(
        {
          taskKey: "backup.db.weekly",
          name: " 每周数据库备份 ",
          executor: "backup.db",
          params: { keep: 4 },
          triggers: [
            { kind: "cron", expr: "0  2 * * SUN" },
            { kind: "manual", expr: "ignored" },
          ],
        },
        ACTOR,
      );
      expect(result.ok).toBe(true);
      const task = (await listOpsTasks()).find((t) => t.taskKey === "backup.db.weekly")!;
      expect(task.name).toBe("每周数据库备份");
      expect(task.triggers.map((t) => [t.kind, t.expr])).toEqual([
        ["cron", "0 2 * * sun"],
        ["manual", null],
      ]);
      const audits = await opsAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "ops.task.create",
        targetType: "ops_task",
        targetId: "backup.db.weekly",
      });
      expect(audits[0]!.after).toMatchObject({ via: "admin", params: { keep: 4 } });
    });

    it.each([
      [{ taskKey: "backup.db" }, "任务键已存在"],
      [{ taskKey: "Bad Key" }, "任务键只允许"],
      [{ executor: "rm.rf" }, "未注册的执行器"],
      [{ params: { keep: 0 } }, "keep"],
      [{ name: "  " }, "任务名"],
      [{ triggers: [{ kind: "cron", expr: "0 2 * * 5" }] }, "星期字段"],
      [{ triggers: [{ kind: "once", expr: "2027-02-30 00:00:00" }] }, "单次触发时刻"],
    ])("新建拒绝 %j：bad-input、零写入、零审计", async (patch, message) => {
      const before = await listOpsTasks();
      const result = await createOpsTask(
        {
          taskKey: "new.task",
          name: "新任务",
          executor: "backup.db",
          params: {},
          triggers: [],
          ...patch,
        },
        ACTOR,
      );
      expect(result).toMatchObject({ ok: false, code: "bad-input" });
      expect(!result.ok && result.message).toContain(message);
      expect(await listOpsTasks()).toEqual(before);
      expect(await opsAudits()).toEqual([]);
    });

    it("编辑：revision 过期 → conflict 且不改不记；正确 revision → +1 并审计前后快照", async () => {
      const task = await taskByKey("backup.db");
      expect(await updateOpsTask(task!.id, 99, { params: { keep: 3 } }, ACTOR)).toEqual({
        ok: false,
        code: "conflict",
      });
      expect((await taskByKey("backup.db"))!.params).toEqual({ keep: 14 });
      expect(await opsAudits()).toEqual([]);

      expect(
        (await updateOpsTask(task!.id, 1, { name: "库备份", params: { keep: 3 } }, ACTOR)).ok,
      ).toBe(true);
      const after = await taskByKey("backup.db");
      expect([after!.name, after!.params, after!.revision]).toEqual(["库备份", { keep: 3 }, 2]);
      const [entry] = await opsAudits();
      expect(entry).toMatchObject({ action: "ops.task.update", targetId: "backup.db" });
      expect(entry!.before).toMatchObject({ params: { keep: 14 }, revision: 1 });
      expect(entry!.after).toMatchObject({ params: { keep: 3 }, revision: 2, via: "admin" });
    });

    it("编辑：参数按任务自身的执行器校验；没有变更项拒绝；不存在 → not-found", async () => {
      const task = await taskByKey("backup.storage");
      expect(await updateOpsTask(task!.id, 1, { params: { keep: 91 } }, ACTOR)).toMatchObject({
        ok: false,
        code: "bad-input",
      });
      expect(await updateOpsTask(task!.id, 1, {}, ACTOR)).toMatchObject({
        ok: false,
        code: "bad-input",
      });
      expect(await updateOpsTask(999999, 1, { name: "x" }, ACTOR)).toEqual({
        ok: false,
        code: "not-found",
      });
    });

    it("启停是旁路写：revision+1、审计；重复设同一状态不产生写入", async () => {
      const task = await taskByKey("backup.db");
      expect((await setOpsTaskEnabled(task!.id, false, ACTOR)).ok).toBe(true);
      expect(await taskByKey("backup.db")).toMatchObject({ enabled: false, revision: 2 });
      expect((await setOpsTaskEnabled(task!.id, false, ACTOR)).ok).toBe(true);
      expect((await taskByKey("backup.db"))!.revision).toBe(2);
      expect((await opsAudits()).map((a) => a.action)).toEqual(["ops.task.toggle"]);
    });

    it("删除：连触发器一起删，审计前快照带上触发器", async () => {
      const task = await taskByKey("backup.storage");
      expect((await deleteOpsTask(task!.id, ACTOR)).ok).toBe(true);
      expect(await taskByKey("backup.storage")).toBeUndefined();
      expect(
        await db().select().from(opsTriggers).where(eq(opsTriggers.taskKey, "backup.storage")),
      ).toEqual([]);
      const [entry] = await opsAudits();
      expect(entry).toMatchObject({
        action: "ops.task.delete",
        targetId: "backup.storage",
        after: null,
      });
      expect((entry!.before as { triggers: unknown[] }).triggers).toHaveLength(2);
    });
  });

  describe("触发器（每次写都让所属任务 revision+1，G-20）", () => {
    it("新增：数字星期被拒并给出错位说明；名称写法入库，任务 revision+1", async () => {
      const rejected = await createOpsTrigger(
        "backup.db",
        { kind: "cron", expr: "0 2 * * 5" },
        ACTOR,
      );
      expect(rejected).toMatchObject({ ok: false, code: "bad-input" });
      expect(!rejected.ok && rejected.message).toContain("错位一天");

      const created = await createOpsTrigger(
        "backup.db",
        { kind: "cron", expr: "0 2 * * fri" },
        ACTOR,
      );
      expect(created.ok).toBe(true);
      expect((await taskByKey("backup.db"))!.revision).toBe(2);
      expect(await createOpsTrigger("nope", { kind: "manual", expr: null }, ACTOR)).toEqual({
        ok: false,
        code: "not-found",
      });
      expect((await opsAudits()).map((a) => a.action)).toEqual(["ops.trigger.create"]);
    });

    it("编辑：过期 revision → conflict；成功后触发器与任务 revision 各 +1", async () => {
      const [cron] = await db()
        .select()
        .from(opsTriggers)
        .where(sql`${opsTriggers.taskKey} = 'backup.db' AND ${opsTriggers.kind} = 'cron'`);
      expect(
        await updateOpsTrigger(cron!.id, 7, { kind: "cron", expr: "0 4 * * *" }, ACTOR),
      ).toEqual({
        ok: false,
        code: "conflict",
      });
      expect(
        (await updateOpsTrigger(cron!.id, 1, { kind: "cron", expr: "0 4 * * *" }, ACTOR)).ok,
      ).toBe(true);
      const [after] = await db().select().from(opsTriggers).where(eq(opsTriggers.id, cron!.id));
      expect([after!.expr, after!.revision]).toEqual(["0 4 * * *", 2]);
      expect((await taskByKey("backup.db"))!.revision).toBe(2);
    });

    it("启停与删除同样让任务 revision+1，各写审计", async () => {
      const triggers = await db()
        .select()
        .from(opsTriggers)
        .where(eq(opsTriggers.taskKey, "backup.storage"));
      expect((await setOpsTriggerEnabled(triggers[0]!.id, false, ACTOR)).ok).toBe(true);
      expect((await deleteOpsTrigger(triggers[1]!.id, ACTOR)).ok).toBe(true);
      expect((await taskByKey("backup.storage"))!.revision).toBe(3);
      expect((await opsAudits()).map((a) => a.action)).toEqual([
        "ops.trigger.toggle",
        "ops.trigger.delete",
      ]);
      expect(await deleteOpsTrigger(triggers[1]!.id, ACTOR)).toEqual({
        ok: false,
        code: "not-found",
      });
    });
  });

  describe("备份保留份数（任务参数 keep）", () => {
    it("读取：任务参数优先；参数缺 keep 时回落 v1 保留策略，再回落默认", async () => {
      expect(await getBackupRetention()).toEqual({ keepDb: 14, keepStorage: 7 });
      await db().update(opsTasks).set({ params: {} }).where(eq(opsTasks.taskKey, "backup.db"));
      await db()
        .insert(siteSettings)
        .values({
          key: "ops.backup.policy",
          value: { keepDb: 9, keepStorage: 3 },
          updatedAt: sql`NOW()`,
        });
      expect(await getBackupRetention()).toEqual({ keepDb: 9, keepStorage: 7 });
      await db().delete(siteSettings).where(eq(siteSettings.key, "ops.backup.policy"));
      expect(await getBackupRetention()).toEqual({ keepDb: 14, keepStorage: 7 });
    });

    it("保存：两条任务同事务改写（保留其余参数）、各 revision+1、各一条审计", async () => {
      expect(await setBackupRetention({ keepDb: 20, keepStorage: 5 }, ACTOR)).toEqual({
        ok: true,
        value: { keepDb: 20, keepStorage: 5 },
      });
      expect(await getBackupRetention()).toEqual({ keepDb: 20, keepStorage: 5 });
      expect((await taskByKey("backup.storage"))!.revision).toBe(2);
      expect((await opsAudits()).map((a) => [a.action, a.targetId])).toEqual([
        ["ops.task.update", "backup.db"],
        ["ops.task.update", "backup.storage"],
      ]);
    });

    it("保存拒绝：越界不写；备份任务被删 → not-found 且整笔回滚（另一条也不改、不留审计）", async () => {
      expect(await setBackupRetention({ keepDb: 0, keepStorage: 5 }, ACTOR)).toMatchObject({
        ok: false,
        code: "bad-input",
      });
      await db().delete(opsTasks).where(eq(opsTasks.taskKey, "backup.storage"));
      expect(await setBackupRetention({ keepDb: 30, keepStorage: 5 }, ACTOR)).toMatchObject({
        ok: false,
        code: "not-found",
      });
      expect((await taskByKey("backup.db"))!.params).toEqual({ keep: 14 });
      expect(await opsAudits()).toEqual([]);
    });
  });

  it("手动触发的审计：记任务键与运行编号", async () => {
    await recordManualTrigger("backup.db", 42, ACTOR);
    expect(await opsAudits()).toEqual([
      {
        action: "ops.task.run",
        targetType: "ops_task",
        targetId: "backup.db",
        before: null,
        after: { runId: 42, via: "admin" },
      },
    ]);
  });

  it("全部配置写路径的审计都走事务句柄（动作回滚则审计一并回滚；事务内不借第二条连接）", async () => {
    const spy = vi.mocked(writeAudit);
    spy.mockClear();
    const dbTask = await taskByKey("backup.db");
    const [cron] = await db()
      .select()
      .from(opsTriggers)
      .where(sql`${opsTriggers.taskKey} = 'backup.storage' AND ${opsTriggers.kind} = 'cron'`);
    await createOpsTask(
      { taskKey: "t.audit", name: "审计探针", executor: "backup.db", params: {}, triggers: [] },
      ACTOR,
    );
    await updateOpsTask(dbTask!.id, 1, { name: "库备份" }, ACTOR);
    await setOpsTaskEnabled(dbTask!.id, false, ACTOR);
    const created = await createOpsTrigger("backup.db", { kind: "manual", expr: null }, ACTOR);
    await updateOpsTrigger(cron!.id, 1, { kind: "cron", expr: "0 5 * * *" }, ACTOR);
    await setOpsTriggerEnabled(cron!.id, false, ACTOR);
    if (created.ok) await deleteOpsTrigger(created.value.id, ACTOR);
    await setBackupRetention({ keepDb: 9, keepStorage: 4 }, ACTOR);
    const probe = await taskByKey("t.audit");
    await deleteOpsTask(probe!.id, ACTOR);

    const actions = spy.mock.calls.map(([, entry]) => entry.action);
    expect(actions).toEqual([
      "ops.task.create",
      "ops.task.update",
      "ops.task.toggle",
      "ops.trigger.create",
      "ops.trigger.update",
      "ops.trigger.toggle",
      "ops.trigger.delete",
      "ops.task.update",
      "ops.task.update",
      "ops.task.delete",
    ]);
    // getWebDb() 每次都新建包装对象（单例的是连接池），不能按对象身份比较——按类型判定事务句柄
    for (const [executor] of spy.mock.calls) expect(executor).toBeInstanceOf(MySqlTransaction);
  });

  describe("getManuallyTriggerableTask（手动触发资格）", () => {
    it("启用 + 有启用中的手动触发器 → 通过并带回任务视图", async () => {
      const check = await getManuallyTriggerableTask("backup.db");
      expect(check.ok).toBe(true);
      if (check.ok) {
        expect(check.task.taskKey).toBe("backup.db");
        expect(check.task.triggers.some((t) => t.kind === "manual" && t.enabled)).toBe(true);
      }
    });

    it.each([
      ["ghost", "not-found"] as const, // 不存在
    ])("不存在 → not-found", async (key, code) => {
      expect(await getManuallyTriggerableTask(key)).toEqual({ ok: false, code });
    });

    it("任务停用 → disabled（有手动触发器也不行）", async () => {
      const task = await taskByKey("backup.db");
      await setOpsTaskEnabled(task!.id, false, ACTOR);
      expect(await getManuallyTriggerableTask("backup.db")).toEqual({
        ok: false,
        code: "disabled",
      });
    });

    it("手动触发器被停用 → no-manual-trigger", async () => {
      await db()
        .update(opsTriggers)
        .set({ enabled: false })
        .where(sql`${opsTriggers.taskKey} = 'backup.db' AND ${opsTriggers.kind} = 'manual'`);
      expect(await getManuallyTriggerableTask("backup.db")).toEqual({
        ok: false,
        code: "no-manual-trigger",
      });
    });
  });

  describe("提交后的热加载通知", () => {
    beforeEach(() => {
      vi.stubEnv("OPS_SERVICE_URL", "http://funwind-ops:8000");
      vi.stubEnv("OPS_API_TOKEN", "t0ken");
    });

    it("写成功才通知；被拒（冲突）不通知", async () => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const task = await taskByKey("backup.db");
      await updateOpsTask(task!.id, 99, { params: { keep: 3 } }, ACTOR);
      expect(fetchMock).not.toHaveBeenCalled();
      await updateOpsTask(task!.id, 1, { params: { keep: 3 } }, ACTOR);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
        "http://funwind-ops:8000/config/reload",
      );
    });

    it("管线不可达不影响写入结果（周期对账兜底）", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
      );
      const task = await taskByKey("backup.db");
      expect((await setOpsTaskEnabled(task!.id, false, ACTOR)).ok).toBe(true);
      expect((await taskByKey("backup.db"))!.enabled).toBe(false);
    });
  });
});
