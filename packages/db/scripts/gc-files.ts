/**
 * db:gc-files —— 孤儿文件巡检（只报告，不删除）。
 * 用法：
 *   tsx scripts/gc-files.ts --dry-run     列出无引用且超过 24 小时的文件（当前唯一支持的模式）
 * 同时报告两类：库里无引用的文件（findOrphanFiles），以及磁盘上有、库里没有的文件（findDiskOrphans，
 * 事务失败或崩溃会留下这类文件）。存储目录同 Web 端：STORAGE_DIR，缺省为仓库根下的 storage/。
 * 本脚本没有删除路径：物理删除留待 M13 前的运维决定。连接目标由 NEW_DB_NAME 决定（默认 qysub_next）。
 * 逻辑在 src/orphan-files.ts。
 */
import path from "node:path";
import { createPool } from "../src/client.js";
import { newDbConfig, repoRoot } from "../src/env.js";
import { findDiskOrphans, findOrphanFiles, ORPHAN_GRACE_HOURS } from "../src/orphan-files.js";

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
    const storageDir = process.env.STORAGE_DIR
      ? path.resolve(process.env.STORAGE_DIR)
      : path.resolve(repoRoot, "storage");
    const disk = await findDiskOrphans(storageDir, pool);
    console.log(`  磁盘孤儿（磁盘有、库里无，${storageDir}）：${disk.length} 个`);
    for (const f of disk) {
      console.log(
        `  - ${f.storageKey}（${f.sizeBytes} 字节，修改于 ${new Date(f.mtimeMs).toISOString()}）`,
      );
    }
  } finally {
    await pool.end();
  }
}
