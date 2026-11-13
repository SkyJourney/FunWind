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
import { sendOpsAlertMails, type OpsFailureMail } from "@/lib/ops/alert-mail";
import { notify } from "@/lib/notifications/notify";
import { getDigestHour } from "@/lib/notifications/email";
import { runDigestOnce } from "@/lib/notifications/digest";
import { nowBeijingWallTime } from "@/lib/datetime";
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
export const DIGEST_JOB_KEY = "email.digest";

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

/**
 * S7 每日汇总（M17 Step 1 接线）。此前它只有独立脚本 scripts/digest-cron.mts，靠宿主机 crontab
 * 每小时调用——而生产 crontab 从未配过该条目，所以 digest **一封都没发出去**（M17 Step 0 实测：
 * email_log 全表零 digest 记录）。接进进程内调度器后只需 SCHEDULER=on（生产已满足），不再依赖仓库外的 crontab。
 *
 * **为什么是每小时 cron 而不是固定每日 cron**：发送时刻是后台可配项（site_settings("email.digest").hour，
 * admin/settings 有表单）。固定 cron 会让该配置失效，所以保留「每小时跑 + run 内比对时刻」的既有语义。
 * **时刻必须按北京墙面时间比对**：调度器按 Asia/Shanghai 触发，而旧脚本用 new Date().getHours()
 * 读的是进程本地时区——容器 TZ=UTC 时后台配的「20 点」会错位成北京时间凌晨 4 点。
 * 同日重复运行由 runDigestOnce 的当日幂等闸兜住（命名锁只防并发，不防先后双跑）。
 */
export function digestJob(
  options: { onlyUserId?: number; force?: boolean } = {},
  overrides: Partial<JobDef> = {},
): JobDef {
  return {
    key: DIGEST_JOB_KEY,
    cron: "0 * * * *",
    timeoutMs: 10 * 60_000,
    async run(): Promise<JobResult> {
      // 手动指定用户或 force（补发/测试）时免时刻闸，与旧脚本的 --user / --force 语义一致
      if (!options.force && options.onlyUserId === undefined) {
        const configured = await getDigestHour();
        const beijingHour = Number(nowBeijingWallTime().slice(11, 13));
        if (beijingHour !== configured) {
          return { summary: `skipped: 北京 ${beijingHour} 点 != 配置 ${configured} 点` };
        }
      }
      const r = await runDigestOnce({ onlyUserId: options.onlyUserId, force: options.force });
      return {
        summary:
          `checked=${r.checked} sent=${r.sent} skippedToday=${r.skippedToday} ` +
          `skippedActive=${r.skippedActive} skippedNoEmail=${r.skippedNoEmail} failed=${r.failed}`,
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
      const mailFailures: OpsFailureMail[] = [];
      for (const run of failed) {
        if (seen.has(String(run.id))) continue;
        seen.add(String(run.id));
        const task = run.taskKey ?? run.kind;
        const error = (run.error ?? "未知原因").slice(0, 200);
        // dedupKey 必须含接收人：uq_nf_dedup 是全局唯一索引，不含 uid 时只有第一个管理员能落库，
        // 其余人被当作重放静默跳过。按 run id + uid 幂等，重扫不重复打扰。
        await notify({
          type: "ops.run.failed",
          recipients: admins,
          targetType: "ops_run",
          targetId: run.id,
          data: { task, runId: run.id, error },
          dedupKey: (uid) => `ops-failed:${run.id}:${uid}`,
        });
        notified += 1;
        mailFailures.push({ task, runId: run.id, error });
      }
      // 离站触达（M17 Step 2）：站内通知之外再发邮件——站长不打开站点也能知道故障。
      // 邮件是**附带渠道**：失败不反噬已写入的站内告警，也不把任务标记为 failed（站内才是主渠道）。
      // 防重在 sendOpsAlertMails 内按 email_log 查（每 15 分钟重扫近 7 天，无条件发信会重复打扰）。
      const mail = await sendOpsAlertMails(admins, mailFailures).catch(() => null);
      const mailSummary = mail
        ? `mail=sent:${mail.sent}/skipped:${mail.skipped}/failed:${mail.failed}`
        : "mail=error";
      return {
        summary: `failed=${failed.length} notified=${notified} admins=${admins.length} ${mailSummary}`,
      };
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
