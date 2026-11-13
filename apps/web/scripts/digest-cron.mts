import { loadRootEnv } from "@funwind/db";
import { createMysqlLocks } from "../src/lib/scheduler/lock";
import { consoleLogger, runJob } from "../src/lib/scheduler/runner";
import { digestJob } from "../src/lib/scheduler/tasks";

/**
 * S7 每日汇总：手动执行入口（M17 Step 1 起不再是唯一的驱动方式）。
 * 示例：pnpm --filter @funwind/web digest:run（预加载服务端 marker 兼容层）
 *
 * **生产已由进程内调度器驱动**（SCHEDULER=on，任务键 email.digest，每小时整点比对后台配置时刻）。
 * 此前本脚本是唯一入口、靠宿主机 crontab 每小时调用，而生产 crontab 从未配过该条目——
 * 所以 digest 一封都没发出去（M17 Step 0 实测：email_log 全表零 digest 记录）。
 *
 * 与调度器**共用同一份任务和同一把命名锁**（照 account-deletion-cron.mts）：调度器或另一实例
 * 正在执行时本次被跳过并以退出码 0 结束。时刻闸门与当日幂等都在任务/服务里，脚本不再自己判时刻——
 * 旧脚本用 new Date().getHours() 读进程本地时区，容器 TZ=UTC 时后台配的「20 点」会错位成北京凌晨 4 点。
 *
 * 参数：--user <id> 只跑单个用户（免时刻闸）；--force 免时刻闸与当日幂等（手动补发/测试用）。
 * 有发送失败时退出码为 1。
 */
const argv = process.argv.slice(2);
const userIdx = argv.indexOf("--user");
const onlyUserId = userIdx >= 0 ? Number(argv[userIdx + 1]) : undefined;
const force = argv.includes("--force");

async function main() {
  loadRootEnv();
  const outcome = await runJob(digestJob({ onlyUserId, force }), {
    locks: createMysqlLocks(),
    log: consoleLogger,
  });
  if (outcome.status === "failed") process.exitCode = 1;
}

// 显式退出：getWebDb 的连接池会一直占着事件循环，只设 exitCode 进程不会结束（实测确认，
// 见 account-deletion-script.int.test.ts）。用 exitCode 而非直接 exit(0)：保留失败时的非零退出码。
main()
  .catch((error: unknown) => {
    console.error("[digest] worker failed");
    console.error(error instanceof Error ? error.name : "UnknownError");
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
