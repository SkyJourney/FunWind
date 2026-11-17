import { loadRootEnv } from "@funwind/db";
import { createMysqlLocks } from "../src/lib/scheduler/lock";
import { consoleLogger, runJob } from "../src/lib/scheduler/runner";
import { apiTokensCleanupJob } from "../src/lib/scheduler/tasks";

/**
 * 凭据卫生清扫（M20 Step 6）：admin_api_tokens 过期/吊销超保留期、sessions 过期行、
 * email_tokens 已用/过期行的物理删除（三类各至多 1000 行/批）。
 * 与进程内调度器（SCHEDULER=on）共用同一份任务和同一把命名锁，手动跑与调度互斥、幂等安全。
 * 示例：pnpm --filter @funwind/web api-tokens:cleanup
 */
async function main() {
  loadRootEnv();
  const outcome = await runJob(apiTokensCleanupJob(), {
    locks: createMysqlLocks(),
    log: consoleLogger,
  });
  if (outcome.status === "failed") process.exitCode = 1;
}

// 显式退出：getWebDb 的连接池会一直占着事件循环（同 unverified-accounts-cron.mts 的实测教训）
main()
  .catch((error: unknown) => {
    console.error("[api-tokens] worker failed");
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError");
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
