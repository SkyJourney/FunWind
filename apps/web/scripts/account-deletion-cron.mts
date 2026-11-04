import { loadRootEnv } from "@funwind/db";
import { processDueAccountDeletions } from "../src/lib/auth/account-deletion";

/**
 * 账号注销到期任务：由系统 cron / launchd 周期调用；每次最多处理指定数量的到期申请。
 * 示例：pnpm --filter @funwind/web account-deletion:drain（预加载服务端 marker 兼容层）
 */
async function main() {
  loadRootEnv();
  const rawLimit = Number(process.env.ACCOUNT_DELETION_BATCH_SIZE ?? 50);
  const limit = Number.isInteger(rawLimit) ? rawLimit : 50;
  const result = await processDueAccountDeletions(limit);
  console.log(
    `[account-deletion] checked=${result.checked} completed=${result.completed} failed=${result.failed}`,
  );
  if (result.failed > 0) process.exitCode = 1;
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
