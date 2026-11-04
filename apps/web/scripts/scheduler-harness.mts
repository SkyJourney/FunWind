import { sql } from "drizzle-orm";
import { getWebDb, getWebPool, loadRootEnv } from "@funwind/db";
import { startScheduler, stopScheduler } from "../src/lib/scheduler";
import type { JobDef } from "../src/lib/scheduler/runner";

/**
 * 【仅供进程级测试使用，不是运维入口】调度器 harness（M11.5）。
 *
 * 起真实的调度器（真 croner、真 MySQL 命名锁），只把任务清单换成一个每秒触发的测试任务，
 * 用来在进程外验证：定时器真的会触发、同一进程不叠跑、跨进程互斥、停止后进程能自行退出。
 * 测试任务每次开始/结束都往 NEW_DB_NAME 库的 scheduler_probe 表记一行，供测试进程数次数、查重叠。
 *
 * 环境变量：HARNESS_RUN_MS 运行时长；HARNESS_HOLD_MS 单次任务耗时；HARNESS_ID 标识本进程；
 * HARNESS_NO_STOP=1 收尾时**不**调用 stopScheduler()，只关连接池——模拟「进程要退出了、调度器没来得及停」，
 * 这时只有定时器的 unref 能保证进程退出（stop() 会清掉定时器，会掩盖 unref 是否生效）。
 * 关于退出：本脚本**不调用 process.exit**。收尾时先 stopScheduler()，再关闭连接池——连接池的 socket 也会占着事件循环，
 * 必须先关掉它，才能单独观察「调度器的定时器本身是否还拖着进程」：croner 的定时器若没有 unref，
 * 池关了进程依旧不退出，测试里的 hung 断言就会抓到。
 */
async function main() {
  loadRootEnv();
  const runMs = Number(process.env.HARNESS_RUN_MS ?? 4000);
  const holdMs = Number(process.env.HARNESS_HOLD_MS ?? 0);
  const id = process.env.HARNESS_ID ?? "h";
  const db = getWebDb();
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS scheduler_probe (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      harness VARCHAR(32) NOT NULL,
      phase VARCHAR(8) NOT NULL,
      at_ms BIGINT NOT NULL
    )`,
  );
  const probe = (phase: "start" | "end") =>
    db.execute(
      sql`INSERT INTO scheduler_probe (harness, phase, at_ms) VALUES (${id}, ${phase}, ${Date.now()})`,
    );

  const job: JobDef = {
    key: "harness.probe",
    cron: "* * * * * *", // 6 段：每秒
    timeoutMs: 60_000,
    async run() {
      await probe("start");
      if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
      await probe("end");
      return { summary: `harness=${id}` };
    },
  };

  const handle = startScheduler({ env: { ...process.env, SCHEDULER: "on" }, jobs: [job] });
  console.log(`[harness ${id}] started=${handle !== null}`);
  await new Promise((resolve) => setTimeout(resolve, runMs));
  if (process.env.HARNESS_NO_STOP !== "1") stopScheduler();
  console.log(`[harness ${id}] stopped`);
  await getWebPool().end();
}

main().catch((error: unknown) => {
  console.error(`[harness] failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
});
