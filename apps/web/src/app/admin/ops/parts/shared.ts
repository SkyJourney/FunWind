import { nowBeijingWallTime } from "@/lib/datetime";

/** 运维任务中心的展示常量与小组手（page.tsx 拆分，M14 Step 3；行数软限 400）。 */

function fmtSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const KIND_LABEL = {
  db: "数据库",
  storage: "存储",
  restore: "恢复",
  drill: "恢复演练",
  holiday: "节日装扮",
} as const;

const TRIGGER_LABEL = { cron: "定时", once: "单次", manual: "手动" } as const;

// 渲染期"距现在几小时"的当前时刻：nowBeijingWallTime 收敛了 impure 调用点（react-hooks/purity），
// 本页 dynamic 渲染（force-dynamic），每次请求都重算，不存在过期快照问题
const NOW_MS = Date.parse(`${nowBeijingWallTime()}+08:00`);

const STATUS_BADGE = {
  running: { label: "执行中", cls: "bg-warning/10 text-warning" },
  success: { label: "成功", cls: "bg-success/10 text-success" },
  failed: { label: "失败", cls: "bg-destructive/10 text-destructive" },
} as const;

const RESULT_TEXT = { success: "成功", failed: "失败", skipped: "跳过（同组忙碌）" } as const;

/** 恢复命令模板（D5：后台只预览 + 复制，真实恢复走 CLI --yes 双确认） */
const restoreCommand = (runId: number, targetDb: string) =>
  `docker exec funwind-backup python cli.py restore ${runId} --target-db ${targetDb} --dry-run   # 预演\n` +
  `docker exec funwind-backup python cli.py restore ${runId} --target-db ${targetDb} --yes        # 真实恢复（覆盖目标库！）`;

/**
 * 运维任务中心（M14 Step 3）：任务清单（触发器/下次运行/手动触发/启停）+ 备份速览 + 保留策略 +
 * 恢复预览（D5）+ 运行台账（分页，执行中自动刷新）。执行全部在运维任务管线，本页只是管理入口。
 */

export { fmtSize, KIND_LABEL, TRIGGER_LABEL, STATUS_BADGE, RESULT_TEXT, restoreCommand, NOW_MS };
