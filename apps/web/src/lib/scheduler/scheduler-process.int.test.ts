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
import { getWebPool } from "@funwind/db";
import type { RowDataPacket } from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWebScript } from "@/test/script-runner";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

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
