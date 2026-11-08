import "server-only";

import { and, eq, gt, isNull, notExists, or, sql } from "drizzle-orm";
import { emailLog, getWebDb, userRestrictions, users } from "@funwind/db";
import { recallRelaunchMail } from "./templates";
import type { MailMessage } from "./types";
import { getMailBrand } from "./brand";
import { trySendMail } from "@/lib/mail";

/** 召回邮件场景标识（email_log.scene）——防重与后台筛选都用它 */
export const RECALL_SCENE = "recall-relaunch";

export interface RecallEligible {
  id: number;
  username: string;
  email: string;
  /** false = 未认领（password_hash 为空），邮件走认领引导 */
  claimed: boolean;
}

export interface RecallPlan {
  /** 白名单内可发（active + 有邮箱 + 未被全局封禁 + 本次未发过） */
  eligible: number;
  /** 本次场景已成功发过的（重跑防重跳过） */
  alreadySent: number;
  /** 因封禁/注销/无邮箱被过滤的总数 */
  filtered: number;
  /** 可发清单（dry-run 抽样展示用；全量发送时内部复用同一查询） */
  samples: Array<Pick<RecallEligible, "id" | "username" | "email" | "claimed">>;
}

export interface RecallRunResult {
  sent: number;
  failed: number;
  batches: number;
}

/**
 * 收件人选择（M13 D4）：
 * · 白名单：state=active（注销行不扰）、email 非空、无生效中的全局封禁（kind=ban, scope_id=0，含永久）。
 *   forum_ban/mute 只限版块/发言，不挡召回——不拦。
 * · 防重：email_log 已有 (scene=recall-relaunch, user, status=sent) 的一律跳过——重跑/中断续跑不重复打扰。
 */
async function eligibleQuery() {
  const now = sql`NOW()`;
  // 两个子查询都必须与外层 users 行相关化（否则「存在任意封禁」会把全站过滤空）
  const banned = getWebDb()
    .select({ userId: userRestrictions.userId })
    .from(userRestrictions)
    .where(
      and(
        sql`${userRestrictions.userId} = ${users.id}`,
        eq(userRestrictions.kind, "ban"),
        eq(userRestrictions.scopeId, 0),
        or(isNull(userRestrictions.endsAt), gt(userRestrictions.endsAt, now)),
      ),
    );
  const sent = getWebDb()
    .select({ userId: emailLog.userId })
    .from(emailLog)
    .where(
      and(
        sql`${emailLog.userId} = ${users.id}`,
        eq(emailLog.scene, RECALL_SCENE),
        eq(emailLog.status, "sent"),
      ),
    );
  return getWebDb()
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      claimed: sql<number>`${users.passwordHash} IS NOT NULL`,
    })
    .from(users)
    .where(
      and(
        eq(users.state, "active"),
        sql`${users.email} IS NOT NULL AND ${users.email} <> ''`,
        notExists(banned),
        notExists(sent),
      ),
    )
    .orderBy(users.id)
    .then((rows) =>
      rows.map((r) => ({
        id: r.id,
        username: r.username,
        email: r.email ?? "",
        claimed: Number(r.claimed) === 1,
      })),
    );
}

/** 统计 + 抽样（dry-run 展示）：查总数、已发数、被过滤数与前 N 个可发样本。 */
export async function recallPlan(sampleSize = 10): Promise<RecallPlan> {
  const db = getWebDb();
  const eligibleRows = await eligibleQuery();
  const [{ n: sentN }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(emailLog)
    .where(and(eq(emailLog.scene, RECALL_SCENE), eq(emailLog.status, "sent")));
  const [{ n: totalN }] = await db.select({ n: sql<number>`count(*)` }).from(users);
  // filtered = 总数 - 可发 - 已发（可发集合已排除注销/无邮箱/封禁/已发，四者互斥故差值即被过滤数）
  return {
    eligible: eligibleRows.length,
    alreadySent: Number(sentN ?? 0),
    filtered: Math.max(0, Number(totalN ?? 0) - eligibleRows.length - Number(sentN ?? 0)),
    samples: eligibleRows.slice(0, sampleSize),
  };
}

/** 打码邮箱（dry-run 日志：a***@domain.com，不出完整地址到终端） */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]!}${"*".repeat(Math.max(3, at - 1))}${email.slice(at)}`;
}

export interface RecallBlastOptions {
  /** false = dry-run（默认）：只统计与抽样，不发送 */
  apply: boolean;
  batchSize?: number;
  batchIntervalMs?: number;
  /** 单封失败后的重试次数（默认 1；仍失败计 failed 并继续下一封） */
  retries?: number;
  /** 发送函数注入（测试用；默认 trySendMail——尽力而为，失败记 email_log failed） */
  send?: (to: string, message: MailMessage, userId: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** 进度回调（CLI 进度行） */
  onProgress?: (done: number, total: number, failed: number) => void;
}

/**
 * 批量召回发送器（S8 手动变体，D4）：
 * 分批限速（每批 batchSize 封、批间 sleep）+ email_log 场景防重 + 失败重试后仍失败不阻断。
 * 发送走 trySendMail（transport 已把每封信写进 email_log：sent/failed + error + messageId）。
 */
export async function runRecallBlast(opts: RecallBlastOptions): Promise<RecallRunResult> {
  const batchSize = opts.batchSize ?? 50;
  const batchIntervalMs = opts.batchIntervalMs ?? 10_000;
  const retries = opts.retries ?? 1;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const brand = await getMailBrand();
  const send = opts.send ?? ((to, message, userId) => trySendMail(to, message, { userId }));

  const rows = await eligibleQuery();
  const result: RecallRunResult = { sent: 0, failed: 0, batches: 0 };
  if (!opts.apply) return result;

  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    result.batches += 1;
    for (const row of batch) {
      const mail = recallRelaunchMail({ username: row.username, claimed: row.claimed }, brand);
      let ok = false;
      for (let attempt = 0; attempt <= retries && !ok; attempt++) {
        ok = await send(row.email, mail, row.id);
        if (!ok) await sleep(Math.min(2000, batchIntervalMs / 5)); // 短退避再试
      }
      if (ok) result.sent += 1;
      else result.failed += 1;
      done += 1;
      opts.onProgress?.(done, rows.length, result.failed);
    }
    if (i + batchSize < rows.length) await sleep(batchIntervalMs);
  }
  return result;
}
