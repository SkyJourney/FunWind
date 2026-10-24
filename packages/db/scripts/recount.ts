/**
 * db:recount —— 全量重算缓存计数（幂等）。
 * 用法：
 *   tsx scripts/recount.ts          真实执行：按明细修正全部缓存计数，再跑一次零修正
 *   tsx scripts/recount.ts --check  只读检查：比对后回滚，有漂移则非零退出（可接入 CI / 巡检）
 * 连接目标由 NEW_DB_NAME 等环境变量决定（默认 qysub_next）；逻辑在 src/recount.ts。
 */
import { createPool } from "../src/client.js";
import { newDbConfig } from "../src/env.js";
import { formatRecountReport, recountAll, recountExitCode } from "../src/recount.js";

// pnpm 透传的分隔符 `--` 不是参数，忽略
const args = process.argv.slice(2).filter((a) => a !== "--");
const unknown = args.filter((a) => a !== "--check");
if (unknown.length > 0) {
  console.error(`未知参数：${unknown.join(" ")}。用法：db:recount [--check]`);
  process.exitCode = 2;
} else {
  const check = args.includes("--check");
  const config = newDbConfig();
  console.log(
    `→ 计数${check ? "检查" : "重算"}：${config.database} @ ${config.host}:${config.port}`,
  );
  if (!check) console.log("  提示：请在无并发写入时执行；有并发写入时结果只反映快照时刻。");
  const pool = createPool(config);
  try {
    const report = await recountAll(pool, { dryRun: check });
    for (const line of formatRecountReport(report)) console.log(line);
    process.exitCode = recountExitCode(report);
  } finally {
    await pool.end();
  }
}
