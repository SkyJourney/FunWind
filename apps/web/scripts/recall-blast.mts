#!/usr/bin/env node
/**
 * 社区重启召回发送器（M13 Step 4，D4）：S8 手动变体——全量分批限速 + email_log 场景防重
 * （重跑/中断续跑不会重复打扰已发用户）+ 失败重试 + 白名单过滤（注销/无邮箱/全局封禁生效中）。
 *
 * 用法（必须由 package script 预加载 server-only-register.mjs，CLAUDE.md 运维脚本纪律）：
 *   pnpm recall-blast            # dry-run：只统计与抽样（邮箱打码），不发送
 *   pnpm recall-blast --apply    # 真发（批 50 封、批间 10s；≈300 封/分钟，1.07 万约 36 分钟）
 * 可调（env）：RECALL_BATCH_SIZE（默认 50）、RECALL_BATCH_INTERVAL_MS（默认 10000）、RECALL_RETRIES（默认 1）。
 * 发送每封都进 email_log（sent/failed + messageId），后台 /admin 邮件记录按 scene=recall-relaunch 可查。
 */
import { recallPlan, runRecallBlast, maskEmail } from "../src/lib/mail/recall";
import "../src/modules"; // 模块注册表先求值（邮件品牌/预加载钩子纪律）

const apply = process.argv.includes("--apply");
const batchSize = Number(process.env.RECALL_BATCH_SIZE ?? 50);
const batchIntervalMs = Number(process.env.RECALL_BATCH_INTERVAL_MS ?? 10_000);
const retries = Number(process.env.RECALL_RETRIES ?? 1);

const plan = await recallPlan(10);
console.log("== 社区重启召回 ==");
console.log(
  `收件人总量：${plan.eligible} 可发 / ${plan.alreadySent} 已发过（防重跳过）/ ${plan.filtered} 被过滤（注销/无邮箱/封禁）`,
);
console.log(
  plan.samples.length > 0
    ? `抽样前 ${plan.samples.length}：\n${plan.samples
        .map(
          (s) => `  #${s.id} ${s.username} <${maskEmail(s.email)}>${s.claimed ? "" : "（未认领）"}`,
        )
        .join("\n")}`
    : "抽样：无",
);
if (!apply) {
  console.log("\n[dry-run] 未发送任何邮件。确认无误后追加 --apply 真发。");
  process.exit(0);
}

console.log(
  `\n开始发送：每批 ${batchSize} 封、批间 ${batchIntervalMs}ms、单封重试 ${retries} 次……`,
);
const started = Date.now();
const result = await runRecallBlast({
  apply: true,
  batchSize,
  batchIntervalMs,
  retries,
  onProgress: (done, total, failed) => {
    if (done % batchSize === 0 || done === total) {
      console.log(`  进度 ${done}/${total}（失败 ${failed}）`);
    }
  },
});
console.log(
  `✔ 完成：成功 ${result.sent} / 失败 ${result.failed}（明细见 email_log scene=recall-relaunch 的 failed 行），耗时 ${Math.round((Date.now() - started) / 1000)}s`,
);
// 显式退出：nodemailer 的 SMTP 连接池会让事件循环保持活跃，脚本不能自然结束（与 digest-cron 同款处理）
process.exit(result.failed > 0 ? 1 : 0);
