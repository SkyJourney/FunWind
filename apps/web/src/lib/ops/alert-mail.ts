import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { emailLog, getWebDb } from "@funwind/db";
import { opsRunFailedMail } from "@/lib/mail/templates";
import { opsEmailEnabled, sendUserEmail } from "@/lib/notifications/email";

/**
 * 运维告警的**离站触达**（M17 Step 2）。
 *
 * 背景：`ops.alerts` 任务此前只调 `notify()` 写站内通知，从不发邮件——站长不打开站点就看不到。
 * M17 Step 0 实测：11-11 两次 storage 备份失败，站内通知按时送达 2 位管理员（时刻与 `*\/15` 扫描吻合），
 * 但 `email_log` 零告警邮件。**链路是好的，缺的是这一层**。
 *
 * 为什么不改 `notify()` 自动并联邮件：那是站内写库管线，邮件按既定架构由调用方显式附带
 * （见 modules/pm 的范式）。改它会自动波及全部通知类型，并破坏「场景类查用户偏好 / 强制类查站点开关」的分层。
 */

/** 告警邮件场景标识（email_log.scene）——防重与后台筛选都用它 */
export const OPS_ALERT_SCENE = "ops-run-failed";

/** 失败原因入邮件前的截断长度，与站内通知 data.error 同口径 */
const ERROR_MAX = 200;

export interface OpsFailureMail {
  task: string;
  runId: number;
  error: string;
}

export interface OpsAlertMailResult {
  sent: number;
  /** 该运行已成功发过（重扫防重跳过） */
  skipped: number;
  /**
   * 未送达数。注意语义：`sendUserEmail` 对「该管理员没有邮箱」同样返回 false，
   * 所以这里包含「无邮箱」与「SMTP 发送失败」两种情形——读摘要时不要一律当成发信故障。
   */
  failed: number;
}

/**
 * 该运行的告警邮件是否已成功发给该用户。
 *
 * **为什么查 email_log 而不是进程内 rateLimit**：告警任务每 15 分钟重扫近 7 天的失败记录，
 * 而 `rateLimit` 是进程级滑动窗口、重启即失忆——用它做主防重会导致重启后把整周的失败再发一遍。
 * `email_log` 是持久事实，且已有 (scene, user, status) 索引，零 schema 变更（照 lib/mail/recall.ts 范式）。
 *
 * **主题锚点必须带右全角括号**：`%运行 #1%` 会子串命中 `#10`、`#11`…，把不同运行的告警误判为已发。
 * 带上右括号后 `#1）` 不再匹配 `#10）`。模板主题格式与本查询是一对契约，改一处必须改另一处。
 */
export async function opsAlertMailSent(userId: number, runId: number): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ id: emailLog.id })
    .from(emailLog)
    .where(
      and(
        eq(emailLog.userId, userId),
        eq(emailLog.scene, OPS_ALERT_SCENE),
        eq(emailLog.status, "sent"),
        sql`${emailLog.subject} LIKE ${`%运行 #${runId}）%`}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * 给管理员发运维失败告警邮件（尽力而为）。站内通知由调用方先行写入；
 * 本函数只补离站触达，任何失败都不反噬站内告警与任务摘要。
 * 站点开关关闭时整体跳过（返回全零，不记 skipped——skipped 专指「已发过」）。
 */
export async function sendOpsAlertMails(
  admins: readonly number[],
  failures: readonly OpsFailureMail[],
): Promise<OpsAlertMailResult> {
  const result: OpsAlertMailResult = { sent: 0, skipped: 0, failed: 0 };
  if (admins.length === 0 || failures.length === 0) return result;
  if (!(await opsEmailEnabled())) return result;

  for (const f of failures) {
    const error = f.error.slice(0, ERROR_MAX);
    for (const userId of admins) {
      if (await opsAlertMailSent(userId, f.runId)) {
        result.skipped++;
        continue;
      }
      const ok = await sendUserEmail(userId, ({ brand }) =>
        opsRunFailedMail({ task: f.task, runId: f.runId, error }, brand),
      );
      if (ok) result.sent++;
      else result.failed++;
    }
  }
  return result;
}
