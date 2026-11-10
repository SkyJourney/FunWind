import "server-only";

// 定时任务是第三种使用模块内核的入口（前两种是 Server Action 与 Route Handler）。
// 任务可能早于任何页面请求触发，此时注册表若尚未求值，任务里发出的事件会被派发进空集合并标记完成（= 丢失），
// 积分渠道也会因不可见而失败（见 scripts/outbox-drain.ts 头注释）。
// 注意：当前两个任务（账号注销到期处理、超期未验证清理）自己**不发事件**——注销申请 / 撤销的事件在用户操作的
// Server Action 里发，那里由 defineAction 保证求值。所以这行对现有任务是防御性的，为以后新增会发事件的任务预留。
// 放在任务本体而不是调度器里：命令行脚本也直接引用本文件，脚本与服务进程行为一致。
// 现有的 modules-import-guard 只认 route.ts 与 "use server" 文件，不认定时任务入口，
// 所以这条由 src/test/scheduler-entry-guard.test.ts 单独钉住。
import { and, eq } from "drizzle-orm";
import { roles, userRoles, users } from "@funwind/db";
import { getWebDb } from "@funwind/db";
import "@/modules";
import { listFailedRuns } from "@/lib/ops/runs";
import { notify } from "@/lib/notifications/notify";
import { processDueAccountDeletions } from "@/lib/auth/account-deletion";
import {
  DEFAULT_UNVERIFIED_TTL_DAYS,
  purgeOverdueUnverifiedAccounts,
} from "@/lib/auth/unverified-cleanup";
import type { JobDef, JobResult } from "./runner";

/**
 * 定时任务本体（M11.5）。调度器与命令行脚本**共用同一份**：手动执行和定时执行永远是同一套逻辑。
 *
 * 这里只放纯粹的「做事 + 汇总」，抢锁、超时、日志在 runner。
 */

/** 单次最多处理的到期注销申请数；与历史脚本一致，可由环境变量覆盖 */
export function accountDeletionBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ACCOUNT_DELETION_BATCH_SIZE ?? 50);
  return Number.isInteger(raw) ? raw : 50;
}

export const ACCOUNT_DELETION_JOB_KEY = "account-deletion.drain";
export const UNVERIFIED_PURGE_JOB_KEY = "unverified-accounts.purge";

/** 账号注销到期处理：冷静期 30 天，没有分钟级要求，每 15 分钟一轮足够 */
export function accountDeletionJob(overrides: Partial<JobDef> = {}): JobDef {
  return {
    key: ACCOUNT_DELETION_JOB_KEY,
    cron: "*/15 * * * *",
    timeoutMs: 5 * 60_000,
    async run(): Promise<JobResult> {
      const r = await processDueAccountDeletions(accountDeletionBatchSize());
      return {
        summary: `checked=${r.checked} completed=${r.completed} failed=${r.failed}`,
        failed: r.failed,
      };
    },
    ...overrides,
  };
}

/**
 * 超期未验证账号清理。定时场景必须真正执行（只报告的定时任务没有意义），所以默认 apply；
 * 命令行脚本的「只报告」模式不走这里，直接调用服务函数。
 */
export function unverifiedPurgeJob(
  options: { apply?: boolean; days?: number; limit?: number } = {},
  overrides: Partial<JobDef> = {},
): JobDef {
  return {
    key: UNVERIFIED_PURGE_JOB_KEY,
    cron: "30 3 * * *",
    timeoutMs: 10 * 60_000,
    async run(): Promise<JobResult> {
      const r = await purgeOverdueUnverifiedAccounts({
        apply: options.apply ?? true,
        days: options.days ?? DEFAULT_UNVERIFIED_TTL_DAYS,
        limit: options.limit,
      });
      return {
        summary:
          `${r.dryRun ? "只报告 " : ""}checked=${r.checked} purged=${r.purged} failed=${r.failed}` +
          (r.ids.length > 0 ? ` ids=${r.ids.join(",")}` : ""),
        failed: r.failed,
      };
    },
    ...overrides,
  };
}

// ── 运维告警（M14 Step 5，D11）：管线任务失败 → 通知站长 ──────────────────────────

export const OPS_ALERTS_JOB_KEY = "ops.alerts";
/** 扫描窗口：只看最近 7 天的失败（更早的由告警去重自然过期） */
export const OPS_ALERTS_SCAN_HOURS = 24 * 7;
/** 单轮最多告警条数（防止管线长时间故障后恢复时告警风暴） */
export const OPS_ALERTS_LIMIT = 20;

export function opsAlertsJob(overrides: Partial<JobDef> = {}): JobDef {
  return {
    key: OPS_ALERTS_JOB_KEY,
    cron: "*/15 * * * *",
    timeoutMs: 5 * 60_000,
    async run(): Promise<JobResult> {
      const failed = await listFailedRuns(OPS_ALERTS_SCAN_HOURS, OPS_ALERTS_LIMIT);
      // 台账表不存在（管线未部署）→ 静默跳过（零告警是正确语义）
      if (failed === null) return { summary: "skipped: 台账缺失（管线未部署）" };
      const admins = await siteAdminIds();
      // 没有可接收的管理员：告警无处可去，只记汇总（与既有告警渠道缺失的语义一致）
      if (admins.length === 0) {
        return { summary: `failed=${failed.length} skipped: 无可接收告警的管理员` };
      }
      let notified = 0;
      const seen = new Set<string>();
      for (const run of failed) {
        // dedupKey 按 run id 幂等：重扫不重复打扰（唯一索引兜底）
        if (seen.has(String(run.id))) continue;
        seen.add(String(run.id));
        const task = run.taskKey ?? run.kind;
        for (const adminId of admins) {
          await notify({
            type: "ops.run.failed",
            recipients: [adminId],
            targetType: "ops_run",
            targetId: run.id,
            data: { task, runId: run.id, error: (run.error ?? "未知原因").slice(0, 200) },
            dedupKey: () => `ops-failed:${run.id}`,
          });
        }
        notified += 1;
      }
      return { summary: `failed=${failed.length} notified=${notified} admins=${admins.length}` };
    },
    ...overrides,
  };
}

/** 拥有 admin 角色的启用用户（运维告警接收人；M13 管理员治理后的语义 = 站长 + 兜底超管） */
async function siteAdminIds(): Promise<number[]> {
  const rows = await getWebDb()
    .select({ userId: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.key, userRoles.roleKey))
    .where(and(eq(roles.key, "admin"), eq(users.state, "active")));
  return rows.map((r) => r.userId);
}
