import "server-only";

// 定时任务是第三种使用模块内核的入口（前两种是 Server Action 与 Route Handler）。
// 任务可能早于任何页面请求触发，此时注册表若尚未求值，任务里发出的事件会被派发进空集合并标记完成（= 丢失），
// 积分渠道也会因不可见而失败（见 scripts/outbox-drain.ts 头注释）。
// 注意：当前任务均自己**不发事件**——注销申请 / 撤销的事件在用户操作的 Server Action 里发，
// 那里由 defineAction 保证求值。所以这行对现有任务是防御性的，为以后新增会发事件的任务预留。
// 放在任务本体而不是调度器里：命令行脚本也直接引用本文件，脚本与服务进程行为一致。
// 现有的 modules-import-guard 只认 route.ts 与 "use server" 文件，不认定时任务入口，
// 所以这条由 src/test/scheduler-entry-guard.test.ts 单独钉住。
import { and, eq, sql } from "drizzle-orm";
import { affectedRowsOf, getWebDb, roles, siteSettings, userRoles, users } from "@funwind/db";
import "@/modules";
import { listFailedRuns } from "@/lib/ops/runs";
import { sendOpsAlertMails, type OpsFailureMail } from "@/lib/ops/alert-mail";
import { notify } from "@/lib/notifications/notify";
import { getDigestHour } from "@/lib/notifications/email";
import { runDigestOnce } from "@/lib/notifications/digest";
import { cleanupStalePushSubscriptions } from "@/lib/push/subscriptions";
import { cleanupExpiredManageApiIdempotency } from "@/lib/manage/idempotency-cleanup";
import { cleanupStaleCredentialRows } from "@/lib/manage/tokens";
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

// ── Web Push 订阅卫生清扫（M18 Step 6）：定期清除超期未重建的失效订阅 ──────────────────────────

export const PUSH_CLEANUP_JOB_KEY = "push.cleanup";

export function pushCleanupJob(overrides: Partial<JobDef> = {}): JobDef {
  return {
    key: PUSH_CLEANUP_JOB_KEY,
    cron: "40 3 * * *",
    timeoutMs: 60_000,
    async run(): Promise<JobResult> {
      const removed = await cleanupStalePushSubscriptions();
      return { summary: `removed=${removed}` };
    },
    ...overrides,
  };
}

// ── 凭据、管理 API 幂等记录和通知凭证清扫，共用原任务与命名锁 ──

const DELIVERY_BATCH_SIZE = 500;
const DELIVERY_MAX_BATCHES = 20;
const DELIVERY_BUDGET_MS = 5000;

/** 按出箱事件最早到期顺序删除一批；派发未结清或无匹配出箱的凭证不能证明安全到期。 */
async function deleteExpiredNotificationDeliveryBatch(): Promise<number> {
  // 以数据库北京时间比较出箱创建时间：90 天外送界限外再留 1 天缓冲；站内凭证不参与清扫。
  // 先从凭证反查出箱，避免遍历完整出箱历史；LIMIT 使派生表物化，外层只按主键删除入选行。
  const result = await getWebDb().execute(sql`
    DELETE delivery
    FROM (
      SELECT candidate.outbox_id, candidate.channel, candidate.scene, candidate.recipient_id
      FROM notification_deliveries AS candidate
      STRAIGHT_JOIN event_outbox AS outbox ON outbox.id = candidate.outbox_id
      WHERE outbox.dispatched_at IS NOT NULL AND outbox.created_at < NOW() - INTERVAL 91 DAY
      ORDER BY outbox.created_at, candidate.outbox_id, candidate.channel, candidate.scene, candidate.recipient_id
      LIMIT ${DELIVERY_BATCH_SIZE}
    ) AS due
    STRAIGHT_JOIN notification_deliveries AS delivery
      ON delivery.outbox_id = due.outbox_id AND delivery.channel = due.channel
      AND delivery.scene = due.scene AND delivery.recipient_id = due.recipient_id
  `);
  return affectedRowsOf(result);
}

/** 汇总实际删除的凭证数；预算到期后不再发起新批次。 */
export async function cleanupExpiredNotificationDeliveries(now = () => performance.now()) {
  const deadline = now() + DELIVERY_BUDGET_MS;
  let total = 0;
  for (let batch = 0; batch < DELIVERY_MAX_BATCHES; batch++) {
    if (batch > 0 && now() >= deadline) break;
    const removed = await deleteExpiredNotificationDeliveryBatch();
    total += removed;
    if (removed < DELIVERY_BATCH_SIZE) break;
  }
  return total;
}

const ORPHAN_SCAN_SIZE = 2000;
const ORPHAN_DELETE_SIZE = 500;
const ORPHAN_LEDGERS = {
  notification_deliveries: ["outbox_id", "channel", "scene", "recipient_id"],
  notification_receipts: ["outbox_id", "type", "user_id"],
} as const;

/** 每表扫描一个主键页，只删页内最旧的成熟孤儿；游标跨进程持久化，到表尾回绕。 */
async function cleanupOrphanedNotificationLedger(ledger: keyof typeof ORPHAN_LEDGERS) {
  const db = getWebDb();
  const key = `scheduler.${ledger}.orphan-cursor`;
  const table = sql.identifier(ledger);
  const keys = ORPHAN_LEDGERS[ledger];
  const column = (alias: string, name: string) =>
    sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const keyList = (alias: string) =>
    sql.join(
      keys.map((name) => column(alias, name)),
      sql`, `,
    );
  const id = (i: number) => i === 0 || i === keys.length - 1;
  const parseCursor = (value: unknown): string[] | null =>
    Array.isArray(value) &&
    value.length === keys.length &&
    value.every((part, i) => typeof part === "string" && (!id(i) || /^\d+$/.test(part)))
      ? value
      : null;
  const [setting] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, key));
  const cursor = parseCursor(setting?.value);
  const boundary = cursor?.map((value, i) =>
    id(i) ? sql`CAST(${value} AS UNSIGNED)` : sql`${value}`,
  );
  // 将复合键比较展开为索引范围，避免行值比较退化为从主键头部逐行过滤。
  const after = boundary
    ? keys.reduceRight(
        (next, name, i) => {
          const col = column("candidate", name);
          return sql`(${col} > ${boundary[i]} OR (${col} = ${boundary[i]} AND ${next}))`;
        },
        sql`FALSE`,
      )
    : sql`TRUE`;
  const source = sql`${table} AS candidate FORCE INDEX (PRIMARY)`;
  // 先记删除前的页尾，防止已删行导致 OFFSET 越界而跳过尚未扫描的下一页。
  const keyParts = keys.map((name, i) => {
    const col = column("candidate", name);
    return id(i) ? sql`CAST(${col} AS CHAR)` : col;
  });
  const [end] = await db
    .select({ cursorValue: sql<unknown>`JSON_ARRAY(${sql.join(keyParts, sql`, `)})` })
    .from(source)
    .where(after)
    .orderBy(keyList("candidate"))
    .limit(1)
    .offset(ORPHAN_SCAN_SIZE - 1);
  const result = await db.execute(sql`
    DELETE receipt FROM (
      SELECT ${keyList("page")} FROM (
        SELECT ${keyList("candidate")}, candidate.created_at
        FROM ${source} WHERE ${after} ORDER BY ${keyList("candidate")} LIMIT ${ORPHAN_SCAN_SIZE}
      ) AS page
      LEFT JOIN event_outbox AS parent ON parent.id = page.outbox_id
      WHERE parent.id IS NULL AND page.created_at < NOW() - INTERVAL 91 DAY
      ORDER BY page.created_at, ${keyList("page")}
      LIMIT ${ORPHAN_DELETE_SIZE}
    ) AS due
    STRAIGHT_JOIN ${table} AS receipt ON ${sql.join(
      keys.map((name) => sql`${column("receipt", name)} = ${column("due", name)}`),
      sql` AND `,
    )}
    LEFT JOIN event_outbox AS parent ON parent.id = receipt.outbox_id
    WHERE parent.id IS NULL AND receipt.created_at < NOW() - INTERVAL 91 DAY
  `);
  const removed = affectedRowsOf(result);
  if (removed < ORPHAN_DELETE_SIZE) {
    const next = parseCursor(end?.cursorValue);
    if (next || cursor) {
      const data = { value: next, updatedAt: sql`NOW()` };
      await db
        .insert(siteSettings)
        .values({ key, ...data })
        .onDuplicateKeyUpdate({ set: data });
    }
  }
  return removed;
}

export const API_TOKENS_CLEANUP_JOB_KEY = "api-tokens.cleanup";

export function apiTokensCleanupJob(overrides: Partial<JobDef> = {}): JobDef {
  return {
    key: API_TOKENS_CLEANUP_JOB_KEY,
    cron: "10 4 * * *",
    timeoutMs: 60_000,
    async run(): Promise<JobResult> {
      const stats = await cleanupStaleCredentialRows();
      const idempotency = await cleanupExpiredManageApiIdempotency();
      const notificationDeliveries = await cleanupExpiredNotificationDeliveries();
      const orphanNotificationDeliveries =
        await cleanupOrphanedNotificationLedger("notification_deliveries");
      const orphanNotificationReceipts =
        await cleanupOrphanedNotificationLedger("notification_receipts");
      return {
        summary:
          `tokens=${stats.tokens} sessions=${stats.sessions} emailTokens=${stats.emailTokens} ` +
          `idempotency=${idempotency} notificationDeliveries=${notificationDeliveries} ` +
          `orphanNotificationDeliveries=${orphanNotificationDeliveries} orphanNotificationReceipts=${orphanNotificationReceipts}`,
      };
    },
    ...overrides,
  };
}
