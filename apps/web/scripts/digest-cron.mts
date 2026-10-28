import { runDigestOnce } from "../src/lib/notifications/digest";
import { eq } from "drizzle-orm";
import { getWebDb, loadRootEnv, siteSettings } from "@funwind/db";

/**
 * S7 每日汇总定时任务（docs/EMAIL-SCENARIOS.md 第三期）：
 * 系统 crontab / launchd 每天在后台配置的时刻调用（默认建议 20:00）：
 *   cd apps/web && pnpm exec tsx scripts/digest-cron.mts
 * 参数：--user <id> 只跑单个用户（测试）；--force 免 24h 活跃跳过（测试用）。
 */
const argv = process.argv.slice(2);
const userIdx = argv.indexOf("--user");
const onlyUserId = userIdx >= 0 ? Number(argv[userIdx + 1]) : undefined;
const force = argv.includes("--force");

async function main() {
  // 时刻闸门：系统 cron 每小时整点调用本脚本，当前小时 != 后台配置时刻（site_settings("email.digest").hour，默认 20）则空转
  if (!force && onlyUserId === undefined) {
    loadRootEnv();
    const [row] = await getWebDb()
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, "email.digest"))
      .limit(1);
    const hour = (row?.value as { hour?: number } | undefined)?.hour ?? 20;
    if (new Date().getHours() !== hour) {
      console.log(`[digest] 当前 ${new Date().getHours()} 点 != 配置 ${hour} 点，空转`);
      process.exit(0);
    }
  }
  const r = await runDigestOnce({ onlyUserId });
  console.log(
    `[digest] checked=${r.checked} sent=${r.sent} skippedActive=${r.skippedActive} skippedNoEmail=${r.skippedNoEmail}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[digest] 失败：", e);
  process.exit(1);
});
