/**
 * 运维任务管线的内置默认任务（M14 Step 2）：bootstrap 种子，与管线的内置回落
 * （services/backup/app/tasks.py 的 default_tasks）同口径——键、名称、执行器、cron 两处同步。
 *
 * 写入语义 = **按任务键首次写入**（同基线授权「仅首次写入」）：已写过的键记在
 * site_settings(`ops.tasks.seeded`)，之后无论站长改了还是删了，重跑 bootstrap 都不再碰它——
 * 删掉的默认任务不会复活；以后新增的默认任务（新键）仍能补进存量库。
 * 同键任务若已由站长手工建好，只记账、不覆盖。
 *
 * 保留份数从 v1 后台设置 site_settings(`ops.backup.policy`)（{keepDb, keepStorage}）迁入任务参数 `keep`；
 * 无记录或值非法时用默认 14 / 7（与管线 BACKUP_KEEP_* 默认一致）。
 */

export const OPS_SEEDED_SETTING_KEY = "ops.tasks.seeded";
export const LEGACY_BACKUP_POLICY_KEY = "ops.backup.policy";

export type OpsTriggerKind = "cron" | "once" | "manual";

export interface OpsTaskSeed {
  taskKey: string;
  name: string;
  executor: string;
  /** 由 v1 保留策略（可能缺失）推导任务参数 */
  params: (legacyPolicy: unknown) => Record<string, unknown>;
  triggers: readonly { kind: OpsTriggerKind; expr: string | null }[];
  /** 默认停用（节日装扮）：启用是站长的显式动作——避免自动生成排期方案改变站点外观 */
  enabled?: boolean;
}

/** 读 v1 保留策略里的某一项；缺失或越界（1–90 之外）回落默认 */
export function legacyKeep(
  policy: unknown,
  field: "keepDb" | "keepStorage",
  fallback: number,
): number {
  if (typeof policy !== "object" || policy === null) return fallback;
  const value = (policy as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 90
    ? value
    : fallback;
}

export const OPS_TASK_SEEDS: readonly OpsTaskSeed[] = [
  {
    taskKey: "backup.db",
    name: "数据库备份",
    executor: "backup.db",
    params: (policy) => ({ keep: legacyKeep(policy, "keepDb", 14) }),
    triggers: [
      { kind: "cron", expr: "10 3 * * *" },
      { kind: "manual", expr: null },
    ],
  },
  {
    taskKey: "backup.storage",
    name: "存储备份",
    executor: "backup.storage",
    params: (policy) => ({ keep: legacyKeep(policy, "keepStorage", 7) }),
    triggers: [
      { kind: "cron", expr: "40 3 * * *" },
      { kind: "manual", expr: null },
    ],
  },
  {
    // 节日装扮：默认停用 + 每日 09:00 自检（确保当前或下一年窗口的排期方案存在）。
    // 默认规则 = 春节（农历正月初一，连 7 天）装扮 qy2010 情怀包；站长在 /admin/ops 改规则并启用。
    taskKey: "campaign.holiday",
    name: "节日装扮",
    executor: "campaign.holiday",
    params: () => ({
      calendar: "lunar",
      month: 1,
      day: 1,
      beforeDays: 0,
      durationDays: 7,
      items: [{ effect: "theme.pack", target: "qy2010" }],
    }),
    triggers: [
      { kind: "cron", expr: "0 9 * * *" },
      { kind: "manual", expr: null },
    ],
    enabled: false,
  },
  {
    // 恢复演练：默认启用（每周五 02:00）——备份必须演练过才算数（BACKUP.md §4），
    // 同实例临时库导入 + 表对账后清理，不触碰生产数据（详见管线 app/drill.py）。
    taskKey: "drill.restore",
    name: "恢复演练",
    executor: "drill.restore",
    params: () => ({}),
    triggers: [
      { kind: "cron", expr: "0 2 * * fri" },
      { kind: "manual", expr: null },
    ],
  },
];

/** 记账值（JSON 数组）→ 已写过的任务键集合；形态不符视为空 */
export function seededKeysOf(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
  );
}
