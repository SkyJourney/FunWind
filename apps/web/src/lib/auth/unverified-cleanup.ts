import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";
import { writeAudit } from "@/lib/audit";
import { lockActiveUserInTx } from "@/lib/identity";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { purgeUserDataInTx } from "./account-deletion-purge";

/**
 * 超期未验证账号清理（M11.3 清账）。
 *
 * 背景：开放注册且要求验证的账号，注册后必须先验证邮箱才能登录（登录门）。填错邮箱或不再打算使用的账号会
 * 一直占着用户名和邮箱。站长拍板：超过 7 天仍未验证的自动清理，释放用户名与邮箱。
 *
 * 复用账号注销用的 purgeUserDataInTx（用户名改占位、清邮箱、置 state=deleted），不另写一套删除逻辑——
 * 本库没有外键，引用完整性全靠应用层，另写一份会在新增引用用户的表时漂移。
 */

export const DEFAULT_UNVERIFIED_TTL_DAYS = 7;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * 「超期未验证」的 SQL 谓词。条件刻意收得很紧：
 *  - 登录门仍关着（login_verification_required）：只有开放注册且要求验证的账号才带这个标记，
 *    导入的历史账号与邀请注册账号永远不会被选中；
 *  - 从未验证过（email_verified_at 为空）、从未登录（last_login_at 为空）、没有任何会话行；
 *  - 创建时间早于 N 天前（库内时间是北京墙面时间，NOW() 在连接层已设为 +08:00）。
 * days 已在入口校验为正整数，这里直接拼进 INTERVAL。
 */
function overduePredicate(days: number) {
  return and(
    eq(users.state, "active"),
    eq(users.loginVerificationRequired, true),
    isNull(users.emailVerifiedAt),
    isNull(users.lastLoginAt),
    sql`${users.createdAt} < NOW() - INTERVAL ${sql.raw(String(days))} DAY`,
    sql`NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = ${users.id})`,
  );
}

/** 校验天数：必须是不小于 1 的整数，避免传错参数把刚注册的账号一并清掉 */
export function assertValidDays(days: number): number {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`天数必须是不小于 1 的整数，收到 ${String(days)}`);
  }
  return days;
}

export type OverdueAccount = { id: number; createdAt: string };

/** 列出超期未验证的账号（最早注册的优先），不改任何数据；dry-run 与正式执行共用 */
export async function findOverdueUnverifiedAccounts(
  days: number = DEFAULT_UNVERIFIED_TTL_DAYS,
  limit: number = DEFAULT_LIMIT,
): Promise<OverdueAccount[]> {
  assertValidDays(days);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT));
  return getWebDb()
    .select({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .where(overduePredicate(days))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(safeLimit);
}

/**
 * 清理单个账号。事务内先对用户行加锁并**重新核对全部条件**：
 * 从选出候选到真正清理之间，用户可能刚好点了验证链接，此时必须放过（返回 false）。
 * 与限制、角色授予同口径，注销冷静期与已注销账号也一律跳过。
 */
export async function purgeOverdueAccountIfStillEligible(
  userId: number,
  days: number,
): Promise<boolean> {
  assertValidDays(days);
  return withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const target = await lockActiveUserInTx(tx, userId);
      if (!target.ok) return false;
      const [row] = await tx
        .select({ id: users.id, createdAt: users.createdAt })
        .from(users)
        .where(and(eq(users.id, userId), overduePredicate(days)))
        .limit(1);
      if (!row) return false;
      await purgeUserDataInTx(tx, userId);
      // 审计只记账号 id、注册时间与天数，不记邮箱：邮箱可能就是填错的、属于陌生人
      await writeAudit(tx, {
        actorId: null,
        action: "account.unverified.purged",
        targetType: "user",
        targetId: userId,
        after: { createdAt: row.createdAt, olderThanDays: days },
        ip: null,
      });
      return true;
    }, POINTS_TX_OPTIONS),
  );
}

export type PurgeUnverifiedResult = {
  /** true = 只报告不删除 */
  dryRun: boolean;
  checked: number;
  purged: number;
  failed: number;
  /** 被选中（dry-run）或已清理（apply）的账号 id */
  ids: number[];
};

/**
 * 批处理入口。默认只报告（dryRun），必须显式 apply 才真正清理——破坏性操作默认安全。
 * 单个账号失败不影响其余账号，失败数计入 failed，由调用方决定退出码。
 */
export async function purgeOverdueUnverifiedAccounts(options: {
  apply: boolean;
  days?: number;
  limit?: number;
}): Promise<PurgeUnverifiedResult> {
  const days = assertValidDays(options.days ?? DEFAULT_UNVERIFIED_TTL_DAYS);
  const candidates = await findOverdueUnverifiedAccounts(days, options.limit ?? DEFAULT_LIMIT);
  if (!options.apply) {
    return {
      dryRun: true,
      checked: candidates.length,
      purged: 0,
      failed: 0,
      ids: candidates.map((c) => c.id),
    };
  }
  const ids: number[] = [];
  let failed = 0;
  for (const candidate of candidates) {
    try {
      if (await purgeOverdueAccountIfStillEligible(candidate.id, days)) ids.push(candidate.id);
    } catch {
      failed += 1;
    }
  }
  return { dryRun: false, checked: candidates.length, purged: ids.length, failed, ids };
}
