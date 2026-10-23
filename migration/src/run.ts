import { join } from "node:path";
import { AS_OF, config, toDatetime } from "./config.js";
import { assertNoLiveData, closePools, newQuery, upsert } from "./db.js";
import { Report } from "./lib/report.js";
import { loadSchemaOnce } from "./schema-init.js";
import { STEPS } from "./pipeline.js";
import { assertSystemSeeded, newCtx } from "./step-types.js";

/**
 * 迁移入口：phpwind 9 → qysub_next（schema v2）。
 * 用法：pnpm migrate [step …]；不带参数运行全部步骤。全部步骤幂等，可重跑。
 */
const only = process.argv.slice(2);
const list = only.length > 0 ? STEPS.filter((s) => only.includes(s.name)) : STEPS;
if (list.length === 0) {
  console.error(`未找到步骤: ${only.join(",")}。可选: ${STEPS.map((s) => s.name).join(" ")}`);
  process.exit(1);
}

await loadSchemaOnce();
await assertSystemSeeded();

await assertNoLiveData(AS_OF);

// 并发锁：GET_LOCK 会话级互斥，双开即拒；进程退出（连接关闭）自动释放
const lockRows = await newQuery<{ got: number }>(
  "SELECT GET_LOCK('qysub_migration_run', 0) AS got",
);
if (Number(lockRows[0]?.got) !== 1) {
  console.error("✘ 已有迁移进程在运行（GET_LOCK 'qysub_migration_run' 被占用），拒绝并发执行。");
  await closePools();
  process.exit(1);
}

const report = new Report("迁移 v2 导入报告", [
  `基准时间（过期判断用，保证重跑一致）：${AS_OF}`,
  "本报告由迁移程序自动生成，内容确定性（不含运行时间戳）；连跑两次应得到逐字节相同的文件。",
  "标有「待站长处理」的小节需要人工复核。",
]);
const privateReport = new Report("迁移 v2 待办清单（含个人信息，勿提交）", [
  "本文件含完整邮箱等个人信息，位于已被 .gitignore 的 migration/reports/，**不得入库、不得外传**。",
]);
const ctx = newCtx(report, privateReport);

let failed = 0;
for (const step of list) {
  const t0 = Date.now();
  try {
    const { rows, note } = await step.run(ctx);
    const ms = Date.now() - t0;
    await upsert(
      "migration_state",
      ["entity", "rows_written", "duration_ms", "finished_at", "note"],
      [
        {
          entity: step.name,
          rows_written: rows,
          duration_ms: ms,
          finished_at: toDatetime(Math.floor(Date.now() / 1000)),
          note: note ?? "",
        },
      ],
      ["entity"],
    );
    console.log(`✔ ${step.name.padEnd(16)} ${String(rows).padStart(7)} 行  ${ms}ms  ${note ?? ""}`);
  } catch (e) {
    failed++;
    console.error(`✘ ${step.name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  }
}

// 只有完整运行才覆盖报告，避免局部重跑把报告写残
if (only.length === 0 && failed === 0) {
  report.save(join(config.reportDir, "migration-v2-import.md"));
  console.log(`✔ 报告已写入 docs/reports/migration-v2-import.md`);
  privateReport.save(join(config.privateReportDir, "migration-v2-todo-pii.md"));
  console.log("✔ 含个人信息的待办清单已写入 migration/reports/（gitignore，不入库）");
}

await closePools();
if (failed > 0) {
  console.error(`\n${failed} 个步骤失败，已完成的步骤状态保留，修复后可重跑（幂等）。`);
  process.exit(1);
}
console.log(`\n全部完成：${list.length} 个步骤。重跑安全（自然键 UPSERT / 替换式加载）。`);
