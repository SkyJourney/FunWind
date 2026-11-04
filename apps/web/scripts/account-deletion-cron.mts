import { loadRootEnv } from "@funwind/db";
import { createMysqlLocks } from "../src/lib/scheduler/lock";
import { consoleLogger, runJob } from "../src/lib/scheduler/runner";
import { accountDeletionJob } from "../src/lib/scheduler/tasks";

/**
 * 账号注销到期任务：手动执行或由系统 cron / launchd 周期调用。
 * 示例：pnpm --filter @funwind/web account-deletion:drain（预加载服务端 marker 兼容层）
 *
 * 与进程内调度器（SCHEDULER=on，见 docs/milestones/M11.5-scheduler.md）**共用同一份任务和同一把命名锁**：
 * 调度器或另一个实例正在执行时，本次会被跳过并以退出码 0 结束（对周期调用来说被跳过是正常的）。
 * 每次最多处理 ACCOUNT_DELETION_BATCH_SIZE 个到期申请（默认 50）。有申请处理失败时退出码为 1。
 */
async function main() {
  loadRootEnv();
  const outcome = await runJob(accountDeletionJob(), {
    locks: createMysqlLocks(),
    log: consoleLogger,
  });
  if (outcome.status === "failed") process.exitCode = 1;
}

// 显式退出：getWebDb 的连接池会一直占着事件循环，只设 exitCode 进程不会结束，
// 定时任务每调用一次就会留下一个不退出的进程（实测确认，见 account-deletion-script.int.test.ts）。
// 用 exitCode 而不是直接 exit(0)：保留失败时的非零退出码。
main()
  .catch((error: unknown) => {
    console.error("[account-deletion] worker failed");
    console.error(error instanceof Error ? error.name : "UnknownError");
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
