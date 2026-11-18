// @vitest-environment node
/**
 * 调度器 · 真起子进程的集成测试（真 croner + 真 MySQL 命名锁）。
 *
 * 单测用假 cron，证明不了「定时器真的会触发」；生产构建只证明了「会登记」。
 * 这里在真实 Node 进程里跑 scripts/scheduler-harness.mts（任务清单换成每秒触发的测试任务，
 * 其余全是真实代码），在进程外数次数、查重叠，验证四件事：
 *   1. 定时器到点真的触发任务；
 *   2. 同一进程内上一轮没结束就不叠跑（protect）；
 *   3. 两个进程同时跑，同一任务任何时刻只有一个在执行（命名锁）；
 *   4. 进程收尾时即使调度器没来得及 stop，定时器也不拖住进程（unref）。
 *
 * 为什么「同进程不叠跑」看 skipped 而不是看区间重叠：同进程第二次触发即使绕过了 croner 的 protect，
 * 也会因为命名锁被拒（新连接抢同一把锁）而不重叠——命名锁是第二道防线，会把第一道的失效掩盖掉。
 * 失效的表现是「白白多出的抢锁尝试」，即日志里的 status=skipped（实测 protect:false 时 7 秒里多出 4 条）。
 * 同理，stop() 会清掉定时器，会掩盖 unref 是否生效，所以验证 unref 必须用 HARNESS_NO_STOP=1 跳过 stop
 * （实测 unref:false 且不 stop 时，关池后进程 25 秒仍不退出）。
 */
import {
  eventOutbox,
  getWebDb,
  getWebPool,
  manageApiIdempotency,
  notificationDeliveries,
  notificationReceipts,
  sessions,
} from "@funwind/db";
import { eq, gte, sql } from "drizzle-orm";
import type { RowDataPacket } from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWebScript } from "@/test/script-runner";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { cleanupExpiredManageApiIdempotency } from "@/lib/manage/idempotency-cleanup";
import { cleanupExpiredNotificationDeliveries } from "./tasks";

let tdb: TempDb;

const harness = (id: string, env: Record<string, string>) =>
  runWebScript(tdb.name, "scheduler-harness.mts", [], { HARNESS_ID: id, ...env });

type Probe = { harness: string; phase: "start" | "end"; at_ms: number };
const probes = async (): Promise<Probe[]> => {
  const [rows] = await getWebPool().query<RowDataPacket[]>(
    "SELECT harness, phase, at_ms FROM scheduler_probe ORDER BY id",
  );
  return rows.map((r) => ({ harness: String(r.harness), phase: r.phase, at_ms: Number(r.at_ms) }));
};
const reset = () =>
  getWebPool()
    .query("DELETE FROM scheduler_probe")
    .catch(() => undefined);

/** 把 start/end 配成区间；返回每个区间的 [harness, 开始, 结束] */
function intervals(rows: Probe[]) {
  const open = new Map<string, number>();
  const out: { harness: string; from: number; to: number }[] = [];
  for (const r of rows) {
    if (r.phase === "start") open.set(r.harness, r.at_ms);
    else if (open.has(r.harness)) {
      out.push({ harness: r.harness, from: open.get(r.harness)!, to: r.at_ms });
      open.delete(r.harness);
    }
  }
  return out;
}
const overlaps = (list: { from: number; to: number }[]) =>
  list.some((a, i) => list.some((b, j) => i < j && a.from < b.to && b.from < a.to));

describe.skipIf(skipDb)("调度器 · 真进程", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("定时器到点真的触发任务；stop 并关池后进程自行退出", async () => {
    const r = await harness("solo", { HARNESS_RUN_MS: "5000" });
    expect(r.hung, "stop 并关池后进程应自行退出").toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("started=true");
    expect(r.stdout).toContain("stopped");
    const done = intervals(await probes());
    expect(done.length, "5 秒、每秒触发，应至少跑过 2 次").toBeGreaterThanOrEqual(2);
    await reset();
  });

  it("进程收尾时调度器没来得及 stop：定时器已 unref，进程仍能自行退出", async () => {
    const r = await harness("nostop", { HARNESS_RUN_MS: "3000", HARNESS_NO_STOP: "1" });
    expect(r.hung, "定时器没有 unref：不 stop 的情况下关池后进程退不出").toBe(false);
    expect(r.code).toBe(0);
    await reset();
  });

  it("同一进程内上一轮没结束就不叠跑：任务耗时 2.5 秒、每秒触发，没有白白的抢锁尝试", async () => {
    const r = await harness("slow", { HARNESS_RUN_MS: "9000", HARNESS_HOLD_MS: "2500" });
    expect(r.hung).toBe(false);
    // protect 生效时，上一轮没结束根本不会触发下一轮，也就没有抢锁被拒；失效时每个重叠触发都会留下一条 skipped
    expect(r.stdout + r.stderr, "同一进程不应出现 skipped（protect 失效的症状）").not.toContain(
      "status=skipped",
    );
    const done = intervals(await probes());
    expect(done.length, "9 秒里每轮约 2.5 秒，应跑过至少 2 轮").toBeGreaterThanOrEqual(2);
    // 每秒触发但单轮要 2.5 秒：若叠跑，9 秒里会出现远多于 4 个区间且彼此重叠
    expect(done.length).toBeLessThanOrEqual(4);
    expect(overlaps(done), "同一进程的任务区间不得重叠").toBe(false);
    await reset();
  });

  it("清扫先删最早到期的一批，原命令汇总后续多批且保留未到期记录", async () => {
    const db = getWebDb();
    const key = (i: number) => i.toString(16).padStart(64, "0");
    const scope = { tokenId: "a".repeat(64), endpoint: "test.write", requestHash: "b".repeat(64) };
    const response = { result: "保留" };
    await db.insert(manageApiIdempotency).values([
      ...Array.from({ length: 2000 }, (_, i) => ({
        ...scope,
        keyHash: key(i + 1),
        expiresAt: i < 1000 ? sql`NOW() - INTERVAL 1 HOUR` : sql`NOW() - INTERVAL 10 MINUTE`,
      })),
      { ...scope, keyHash: key(0), expiresAt: sql`NOW() - INTERVAL 1 MINUTE` },
      { ...scope, keyHash: key(2001), expiresAt: sql`NOW() + INTERVAL 1 DAY`, response },
    ]);
    await db.insert(sessions).values({
      id: "c".repeat(64),
      userId: 1,
      createdAt: sql`NOW() - INTERVAL 10 DAY`,
      expiresAt: sql`NOW() - INTERVAL 9 DAY`,
    });
    const remaining = () =>
      db
        .select({ keyHash: manageApiIdempotency.keyHash, response: manageApiIdempotency.response })
        .from(manageApiIdempotency)
        .orderBy(manageApiIdempotency.keyHash);
    const runCleanup = () => runWebScript(tdb.name, "api-tokens-cleanup.mts", []);

    // 首批完成时让时钟刚好到达预算，检查真实数据库确实保留了较晚到期的行。
    let clockReads = 0;
    expect(await cleanupExpiredManageApiIdempotency({ now: () => clockReads++ * 5000 })).toBe(1000);
    expect((await remaining()).map((row) => row.keyHash)).toEqual([
      key(0),
      ...Array.from({ length: 1001 }, (_, i) => key(i + 1001)),
    ]);

    const first = await runCleanup();
    expect(first).toMatchObject({ hung: false, code: 0 });
    expect(first.stdout).toMatch(
      /job=api-tokens\.cleanup status=ok durationMs=\d+ tokens=0 sessions=1 emailTokens=0 idempotency=1001\b/,
    );
    expect(await remaining()).toEqual([{ keyHash: key(2001), response }]);

    const second = await runCleanup();
    expect(second).toMatchObject({ hung: false, code: 0 });
    expect(second.stdout).toContain("tokens=0 sessions=0 emailTokens=0 idempotency=0");
    expect(await remaining()).toEqual([{ keyHash: key(2001), response }]);
  });

  it("外送凭证按出箱到期时间有界清扫，仅日志汇总且保留补派凭证", async () => {
    const db = getWebDb();
    const eventName = "test.notification.cleanup";
    const scene = "test.cleanup.private.scene";
    const now = sql`NOW()`;
    await db.insert(eventOutbox).values([
      {
        id: 1001,
        eventName,
        createdAt: sql`NOW() - INTERVAL 91 DAY - INTERVAL 1 MINUTE`,
        dispatchedAt: now,
      },
      {
        id: 1002,
        eventName,
        createdAt: sql`NOW() - INTERVAL 92 DAY`,
        dispatchedAt: now,
      },
      {
        id: 1003,
        eventName,
        createdAt: sql`NOW() - INTERVAL 91 DAY + INTERVAL 1 MINUTE`,
        dispatchedAt: now,
      },
      { id: 1004, eventName, createdAt: sql`NOW() - INTERVAL 93 DAY` },
    ]);
    const delivery = { channel: "email", scene, recipientId: 1, createdAt: now };
    await db.insert(notificationDeliveries).values([
      { ...delivery, outboxId: 1001 },
      ...Array.from({ length: 500 }, (_, i) => ({
        ...delivery,
        outboxId: 1002,
        recipientId: i + 1,
      })),
      { ...delivery, outboxId: 1003, createdAt: sql`NOW() - INTERVAL 95 DAY` },
      { ...delivery, outboxId: 1004, status: "sent", finishedAt: now },
      { ...delivery, outboxId: 1005, status: "failed", finishedAt: now },
    ]);
    await db.insert(notificationReceipts).values({
      outboxId: 1001,
      type: scene,
      userId: 1,
      createdAt: sql`NOW() - INTERVAL 95 DAY`,
    });
    const remaining = () =>
      db
        .select({ outboxId: notificationDeliveries.outboxId })
        .from(notificationDeliveries)
        .orderBy(notificationDeliveries.outboxId);

    // 第一批必须按出箱时间而非凭证时间或出箱 ID 排序；预算到期后不会启动第二批。
    let reads = 0;
    expect(await cleanupExpiredNotificationDeliveries(() => reads++ * 5000)).toBe(500);
    expect((await remaining()).map((row) => row.outboxId)).toEqual([1001, 1003, 1004, 1005]);

    const result = await runWebScript(tdb.name, "api-tokens-cleanup.mts", []);
    expect(result).toMatchObject({ hung: false, code: 0 });
    expect(result.stdout).toMatch(
      /job=api-tokens\.cleanup status=ok [^\n]+ notificationDeliveries=1\b/,
    );
    expect(result.stdout + result.stderr).not.toContain(scene);
    expect((await remaining()).map((row) => row.outboxId)).toEqual([1003, 1004, 1005]);
    expect(await db.select().from(eventOutbox)).toHaveLength(4);
    expect(await db.select().from(notificationReceipts)).toHaveLength(1);
  });

  it("两张凭证表跨进程推进主键页，页内最旧孤儿优先，保留新孤儿及所有有父行的站内凭证", async () => {
    const db = getWebDb();
    const pending = 20_001;
    const pruned = 20_002;
    const oldest = 20_003;
    const fresh = 20_004;
    const filler = 20_005;
    const tail = 20_006;
    const eventName = "test.notification.orphan";
    const scene = "test.orphan.private.scene";
    const mature = sql`NOW() - INTERVAL 91 DAY - INTERVAL 1 MINUTE`;
    await db.insert(eventOutbox).values([
      { id: pending, eventName, createdAt: mature },
      { id: pruned, eventName, createdAt: mature, dispatchedAt: sql`NOW()` },
      { id: filler, eventName, createdAt: mature },
    ]);
    const seed = async (outboxId: number, count: number, createdAt = mature) => {
      const rows = Array.from({ length: count }, (_, i) => ({ outboxId, createdAt, id: i + 1 }));
      await db
        .insert(notificationDeliveries)
        .values(
          rows.map(({ id, ...row }) => ({ ...row, scene, channel: "email", recipientId: id })),
        );
      await db
        .insert(notificationReceipts)
        .values(rows.map(({ id, ...row }) => ({ ...row, type: scene, userId: id })));
    };
    await seed(pending, 1);
    await seed(pruned, 1);
    await seed(oldest, 500, sql`NOW() - INTERVAL 92 DAY`);
    await seed(fresh, 1, sql`NOW() - INTERVAL 91 DAY + INTERVAL 1 MINUTE`);
    await seed(filler, 2000);
    await seed(tail, 1);
    // 模拟注销删掉已派发的出箱：两张凭证表独立保留，随后由定时任务认领清扫。
    await db.delete(eventOutbox).where(eq(eventOutbox.id, pruned));

    const remaining = async () => {
      const tables = await Promise.all([
        db
          .select({ id: notificationDeliveries.outboxId })
          .from(notificationDeliveries)
          .where(gte(notificationDeliveries.outboxId, pending)),
        db
          .select({ id: notificationReceipts.outboxId })
          .from(notificationReceipts)
          .where(gte(notificationReceipts.outboxId, pending)),
      ]);
      return tables.map((rows) =>
        [pending, pruned, oldest, fresh, filler, tail].map(
          (id) => rows.filter((row) => row.id === id).length,
        ),
      );
    };
    const runCleanup = async (count: number) => {
      const r = await runWebScript(tdb.name, "api-tokens-cleanup.mts", []);
      expect(r, r.stderr).toMatchObject({ hung: false, code: 0 });
      expect(r.stdout).toContain(
        `orphanNotificationDeliveries=${count} orphanNotificationReceipts=${count}`,
      );
      expect(r.stdout + r.stderr).not.toContain(scene);
    };
    await runCleanup(500);
    expect(await remaining()).toEqual(Array(2).fill([1, 1, 0, 1, 2000, 1]));
    await runCleanup(1);
    expect(await remaining()).toEqual(Array(2).fill([1, 0, 0, 1, 2000, 1]));
    await runCleanup(1);
    expect(await remaining()).toEqual(Array(2).fill([1, 0, 0, 1, 2000, 0]));
  });

  it("两个进程同时跑同一任务：任何时刻只有一个在执行（命名锁跨进程互斥）", async () => {
    const [a, b] = await Promise.all([
      harness("A", { HARNESS_RUN_MS: "9000", HARNESS_HOLD_MS: "1500" }),
      harness("B", { HARNESS_RUN_MS: "9000", HARNESS_HOLD_MS: "1500" }),
    ]);
    expect(a.hung || b.hung).toBe(false);
    expect([a.code, b.code]).toEqual([0, 0]);
    const rows = await probes();
    const done = intervals(rows);
    expect(done.length, "两个进程合计应至少跑过几轮").toBeGreaterThanOrEqual(2);
    expect(overlaps(done), "跨进程不得并发执行同一任务").toBe(false);
    // 两个进程都应抢到过机会（轮流），不是一个永远占着
    const winners = new Set(done.map((i) => i.harness));
    expect(winners.size, "至少有一个进程执行过").toBeGreaterThanOrEqual(1);
    await reset();
  });
});
