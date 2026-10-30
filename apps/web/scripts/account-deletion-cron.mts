import { loadRootEnv } from "@funwind/db";
import { processDueAccountDeletions } from "../src/lib/auth/account-deletion";

/**
 * 账号注销到期任务：由系统 cron / launchd 周期调用；每次最多处理指定数量的到期申请。
 * 示例：cd apps/web && pnpm exec tsx scripts/account-deletion-cron.mts
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

main().catch((error: unknown) => {
  console.error("[account-deletion] worker failed");
  console.error(error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
});
