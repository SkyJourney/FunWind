/**
 * db:gc-files —— 孤儿文件巡检（只报告，不删除）。
 * 用法：
 *   tsx scripts/gc-files.ts --dry-run     列出无引用且超过 24 小时的文件（当前唯一支持的模式）
 * 本脚本没有删除路径：物理删除留待 M13 前的运维决定。连接目标由 NEW_DB_NAME 决定（默认 qysub_next）。
 * 逻辑在 src/orphan-files.ts。
 */
import { createPool } from "../src/client.js";
import { newDbConfig } from "../src/env.js";
import { findOrphanFiles, ORPHAN_GRACE_HOURS } from "../src/orphan-files.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const unknown = args.filter((a) => a !== "--dry-run");
if (unknown.length > 0 || !args.includes("--dry-run")) {
  console.error(
    `用法：db:gc-files --dry-run（本脚本只报告，不删除；未知参数：${unknown.join(" ") || "无"}）`,
  );
  process.exitCode = 2;
} else {
  const config = newDbConfig();
  console.log(`→ 孤儿文件巡检（只读）：${config.database} @ ${config.host}:${config.port}`);
  const pool = createPool(config);
  try {
    const orphans = await findOrphanFiles(pool);
    console.log(`  宽限期：${ORPHAN_GRACE_HOURS} 小时；无引用的文件 ${orphans.length} 个`);
    for (const f of orphans) {
      console.log(`  - #${f.id} ${f.storageKey}（${f.sizeBytes} 字节，创建于 ${f.createdAt}）`);
    }
  } finally {
    await pool.end();
  }
}
