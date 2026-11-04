import { loadRootEnv } from "@funwind/db";
import {
  DEFAULT_UNVERIFIED_TTL_DAYS,
  purgeOverdueUnverifiedAccounts,
} from "../src/lib/auth/unverified-cleanup";
import { createMysqlLocks } from "../src/lib/scheduler/lock";
import { consoleLogger, runJob } from "../src/lib/scheduler/runner";
import { unverifiedPurgeJob } from "../src/lib/scheduler/tasks";

/**
 * 超期未验证账号清理（M11.3 清账）：开放注册且要求验证的账号，超过 N 天仍未验证则清理，释放用户名与邮箱。
 *
 * 默认只报告、不删除；必须显式加 --apply 才真正清理（破坏性操作默认安全）。
 * 示例（预加载服务端 marker 兼容层，直接 tsx 运行会绕过它）：
 *   pnpm --filter @funwind/web unverified-accounts:purge                  # 只报告
 *   pnpm --filter @funwind/web unverified-accounts:purge --apply          # 真正清理
 *   pnpm --filter @funwind/web unverified-accounts:purge --apply --days=14 --limit=500
 * 默认 7 天（站长拍板），--days 必须是不小于 1 的整数；单次最多处理 --limit 个（默认 200，上限 1000）。
 *
 * 只报告是只读操作，不抢锁；--apply 与进程内调度器（SCHEDULER=on，见 docs/milestones/M11.5-scheduler.md）
 * **共用同一份任务和同一把命名锁**，调度器或另一个实例正在执行时本次被跳过，退出码 0。
 * 有账号清理失败时以退出码 1 结束，便于定时任务告警。
 */
function numberArg(name: string): number | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (raw === undefined) return undefined;
  const value = Number(raw.slice(name.length + 3));
  if (!Number.isFinite(value)) throw new RangeError(`--${name} 必须是数字`);
  return value;
}

async function main() {
  loadRootEnv();
  const apply = process.argv.includes("--apply");
  const days = numberArg("days") ?? DEFAULT_UNVERIFIED_TTL_DAYS;
  const limit = numberArg("limit");

  if (!apply) {
    const result = await purgeOverdueUnverifiedAccounts({ apply: false, days, limit });
    console.log(
      `[unverified-accounts] 只报告（未删除，加 --apply 才执行） ` +
        `days=${days} checked=${result.checked} purged=${result.purged} failed=${result.failed}`,
    );
    if (result.ids.length > 0) {
      console.log(`[unverified-accounts] 将清理账号 id：${result.ids.join(",")}`);
    }
    return;
  }

  // 参数非法（如 --days=0）由服务函数抛 RangeError，作为失败结束，不会清理任何账号
  const outcome = await runJob(unverifiedPurgeJob({ apply: true, days, limit }), {
    locks: createMysqlLocks(),
    log: consoleLogger,
  });
  if (outcome.status === "failed") process.exitCode = 1;
}

// 显式退出：getWebDb 的连接池会一直占着事件循环，只设 exitCode 进程不会结束，
// 定时任务每调用一次就会留下一个不退出的进程（实测 account-deletion:drain 同样如此）。
// 用 exitCode 而不是直接 exit(0)：保留失败时的非零退出码。
main()
  .catch((error: unknown) => {
    console.error("[unverified-accounts] worker failed");
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError");
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
