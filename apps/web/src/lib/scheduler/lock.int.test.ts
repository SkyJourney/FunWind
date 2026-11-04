// @vitest-environment node
/**
 * 命名锁 · 真实 MySQL 集成测试（临时库）。
 * 调度器的跨实例互斥完全建立在 GET_LOCK 的语义上：锁绑在连接上、没抢到立即返回、连接断开自动释放。
 * 这些必须用真实数据库验证，对假锁的单测证明不了。
 */
import { getWebPool } from "@funwind/db";
import type { RowDataPacket } from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { createMysqlLocks, lockNameOf } from "./lock";
import { runJob, type JobDef, type Logger } from "./runner";

let tdb: TempDb;
const log = (): Logger => ({ info: () => {}, warn: () => {}, error: () => {} });
const locks = createMysqlLocks();

/** 直接问 MySQL：这把锁现在有没有人持有（IS_USED_LOCK 返回持有者连接 id，没人持有返回 NULL） */
async function holderOf(name: string): Promise<number | null> {
  const [rows] = await getWebPool().query<RowDataPacket[]>("SELECT IS_USED_LOCK(?) AS holder", [
    name,
  ]);
  const holder = rows[0]?.holder;
  return holder === null || holder === undefined ? null : Number(holder);
}

describe.skipIf(skipDb)("MySQL 命名锁 · 真实库", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("抢到后别人抢不到，释放后可以再抢", async () => {
    const first = await locks.tryAcquire("it.basic");
    expect(first).not.toBeNull();
    expect(await locks.tryAcquire("it.basic"), "持有期间第二个抢锁者必须被拒").toBeNull();
    await first!.release();
    const again = await locks.tryAcquire("it.basic");
    expect(again, "释放后应能重新抢到").not.toBeNull();
    await again!.release();
  });

  it("没抢到时立即返回（不阻塞等待），并且把借出的连接还回了池里", async () => {
    const holder = await locks.tryAcquire("it.nowait");
    // 抢 20 次都被拒：如果每次被拒不还连接，8 条的池会被占满，第 9 次就会卡死
    const started = Date.now();
    for (let i = 0; i < 20; i++) expect(await locks.tryAcquire("it.nowait")).toBeNull();
    expect(Date.now() - started, "被拒应当立即返回，不能等锁").toBeLessThan(5_000);
    await holder!.release();
  });

  it("锁名带库名：库名不同的同一任务键互不影响", async () => {
    const mine = await locks.tryAcquire("it.namespaced");
    // 用另一个库名算出的锁名，直接在另一条连接上抢：应当能抢到，因为锁名不同
    const otherName = lockNameOf("some_other_database", "it.namespaced");
    const conn = await getWebPool().getConnection();
    try {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS got", [otherName]);
      expect(Number(rows[0]?.got)).toBe(1);
      await conn.query("SELECT RELEASE_LOCK(?)", [otherName]);
    } finally {
      conn.release();
    }
    await mine!.release();
  });

  it("释放后连接干净地回到池里：同一把锁不再有人持有", async () => {
    const handle = await locks.tryAcquire("it.clean");
    const name = lockNameOf(tdb.name, "it.clean");
    expect(await holderOf(name), "持有期间应有持有者").not.toBeNull();
    await handle!.release();
    expect(await holderOf(name), "释放后不应再有持有者（连接带锁回池是严重缺陷）").toBeNull();
  });

  it("持有者的连接被强行断开时，MySQL 自动释放锁（进程崩溃的场景）", async () => {
    const name = lockNameOf(tdb.name, "it.crash");
    const conn = await getWebPool().getConnection();
    const [rows] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS got", [name]);
    expect(Number(rows[0]?.got)).toBe(1);
    expect(await locks.tryAcquire("it.crash")).toBeNull();
    conn.destroy(); // 模拟进程崩溃：连接直接消失，没有机会 RELEASE_LOCK

    // 服务器侧感知断开需要一点时间，短轮询而不是固定 sleep
    let acquired = null;
    for (let i = 0; i < 50 && !acquired; i++) {
      acquired = await locks.tryAcquire("it.crash");
      if (!acquired) await new Promise((r) => setTimeout(r, 100));
    }
    expect(acquired, "连接断开后锁应被服务器自动释放").not.toBeNull();
    await acquired!.release();
  });

  describe("runJob 与真实锁配合", () => {
    const job = (key: string, run: JobDef["run"]): JobDef => ({
      key,
      cron: "* * * * *",
      timeoutMs: 60_000,
      run,
    });

    it("两个执行者同时触发同一任务：只有一个真正执行，另一个 skipped", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let runs = 0;
      const slow = job("it.race", async () => {
        runs += 1;
        await gate;
        return { summary: "done" };
      });
      const deps = { locks, log: log() };
      const a = runJob(slow, deps);
      // 等 A 真的拿到锁并开始执行，再让 B 触发
      for (let i = 0; i < 100 && runs === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(runs).toBe(1);
      const b = await runJob(slow, deps);
      expect(b.status, "A 持锁期间 B 必须被跳过").toBe("skipped");
      release();
      expect((await a).status).toBe("ok");
      expect(runs, "同一任务不能被并发执行两次").toBe(1);
    });

    it("任务抛异常后锁照样释放：下一轮能正常抢到并执行", async () => {
      const failing = job("it.fail-release", async () => Promise.reject(new Error("boom")));
      expect((await runJob(failing, { locks, log: log() })).status).toBe("failed");
      const ok = await runJob(
        job("it.fail-release", async () => ({ summary: "recovered" })),
        { locks, log: log() },
      );
      expect(ok.status, "上一轮失败不能让锁留在池里的连接上").toBe("ok");
    });
  });
});
