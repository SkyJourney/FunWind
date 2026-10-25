import { and, desc, eq, sql } from "drizzle-orm";
import { getWebDb, normalizeKey, pointAccounts, pointLedger, users } from "@funwind/db";
import { clampPage } from "@/lib/queries/paging";

/**
 * 积分台账查询（/points 页）：余额快照 + 只增台账的分页。写路径一律在 lib/points（守卫测试）；这里只读。
 */

export const LEDGER_PER_PAGE = 20;

export interface LedgerItem {
  id: number;
  delta: number;
  balanceAfter: number;
  channel: string;
  note: string;
  refType: string | null;
  refId: number | null;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItem[];
  total: number;
  page: number;
  totalPages: number;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
}

const SELECTION = {
  id: pointLedger.id,
  delta: pointLedger.delta,
  balanceAfter: pointLedger.balanceAfter,
  channel: pointLedger.channel,
  note: pointLedger.note,
  refType: pointLedger.refType,
  refId: pointLedger.refId,
  createdAt: pointLedger.createdAt,
} as const;

/** 某用户的积分账户与台账分页；账户不存在（从未有任何积分）时余额为 0 */
export async function getLedgerPage(userId: number, rawPage: number): Promise<LedgerPage> {
  const db = getWebDb();
  const [account] = await db
    .select({
      balance: pointAccounts.balance,
      lifetimeEarned: pointAccounts.lifetimeEarned,
      lifetimeSpent: pointAccounts.lifetimeSpent,
    })
    .from(pointAccounts)
    .where(eq(pointAccounts.userId, userId))
    .limit(1);

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  const total = Number(n);
  const totalPages = Math.max(1, Math.ceil(total / LEDGER_PER_PAGE));
  const page = clampPage(rawPage, totalPages);

  const items =
    total === 0
      ? []
      : await db
          .select(SELECTION)
          .from(pointLedger)
          .where(eq(pointLedger.userId, userId))
          .orderBy(desc(pointLedger.id))
          .limit(LEDGER_PER_PAGE)
          .offset((page - 1) * LEDGER_PER_PAGE);

  return {
    items,
    total,
    page,
    totalPages,
    balance: account?.balance ?? 0,
    lifetimeEarned: account?.lifetimeEarned ?? 0,
    lifetimeSpent: account?.lifetimeSpent ?? 0,
  };
}

/**
 * 用户名 → 用户 id（/admin/points 调整表单按用户名定位）。
 * 身份口径与登录一致：走归一化键 username_key（大小写不敏感、さくら≠サクラ），不裸查 username 列；
 * 已注销（state≠active）账号不算命中。找不到返回 null。
 */
export async function findUserIdByName(username: string): Promise<number | null> {
  const [row] = await getWebDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.usernameKey, normalizeKey(username)), eq(users.state, "active")))
    .limit(1);
  return row?.id ?? null;
}
