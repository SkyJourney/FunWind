import { toDatetime } from "../config.js";

/**
 * 积分：只迁「期初余额」，不迁旧流水（起点 2013-02 且与余额对不上，站长决策）。
 * 余额 = 旧 credit1（青翼币，负数按 0）+ 银行存款本金（活期 + 定期）。
 * 其余积分类型（羽毛、入住资格证、credit4–8）全部丢弃。
 */

export interface OpeningAccount {
  userId: number;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  updatedAt: string;
}

export interface LedgerRow {
  userId: number;
  delta: number;
  balanceAfter: number;
  channel: "opening";
  idempotencyKey: string;
  note: string;
  createdAt: string;
}

export interface PointsResult {
  accounts: OpeningAccount[];
  ledger: LedgerRow[];
  stats: {
    users: number;
    totalCredit1: number;
    totalBank: number;
    total: number;
    negativeClamped: number[];
    orphanBalances: number;
    orphanBank: number;
    bankAccounts: number;
  };
}

export function transformPoints(
  balances: readonly { uid: number; credit1: number }[],
  bank: readonly { uid: number; deposit: number; ddeposit: number }[],
  userIds: ReadonlySet<number>,
  asOf: string,
): PointsResult {
  const stats: PointsResult["stats"] = {
    users: 0,
    totalCredit1: 0,
    totalBank: 0,
    total: 0,
    negativeClamped: [],
    orphanBalances: 0,
    orphanBank: 0,
    bankAccounts: 0,
  };
  const base = new Map<number, number>();
  for (const b of balances) {
    const uid = Number(b.uid);
    if (!userIds.has(uid)) {
      if (Number(b.credit1) !== 0) stats.orphanBalances++;
      continue;
    }
    const v = Number(b.credit1) || 0;
    if (v < 0) {
      stats.negativeClamped.push(uid);
      continue;
    }
    if (v > 0) base.set(uid, v);
  }
  const bankOf = new Map<number, number>();
  for (const b of bank) {
    const uid = Number(b.uid);
    const principal = Math.max(0, Number(b.deposit) || 0) + Math.max(0, Number(b.ddeposit) || 0);
    if (principal <= 0) continue;
    if (!userIds.has(uid)) {
      stats.orphanBank++;
      continue;
    }
    bankOf.set(uid, principal);
    stats.bankAccounts++;
  }

  const accounts: OpeningAccount[] = [];
  const ledger: LedgerRow[] = [];
  const uids = [...new Set([...base.keys(), ...bankOf.keys()])].sort((a, b) => a - b);
  for (const uid of uids) {
    let running = 0;
    const b = base.get(uid) ?? 0;
    if (b > 0) {
      running += b;
      stats.totalCredit1 += b;
      ledger.push({
        userId: uid,
        delta: b,
        balanceAfter: running,
        channel: "opening",
        idempotencyKey: `opening:${uid}`,
        note: "迁移期初余额（旧 credit1）",
        createdAt: asOf,
      });
    }
    const k = bankOf.get(uid) ?? 0;
    if (k > 0) {
      running += k;
      stats.totalBank += k;
      ledger.push({
        userId: uid,
        delta: k,
        balanceAfter: running,
        channel: "opening",
        idempotencyKey: `opening:bank:${uid}`,
        note: "迁移期初余额（银行存款结算：活期+定期本金）",
        createdAt: asOf,
      });
    }
    accounts.push({
      userId: uid,
      balance: running,
      lifetimeEarned: running,
      lifetimeSpent: 0,
      updatedAt: asOf,
    });
  }
  stats.users = accounts.length;
  stats.total = stats.totalCredit1 + stats.totalBank;
  return { accounts, ledger, stats };
}

// ---------- 签到 ----------

export interface CheckinRow {
  userId: number;
  checkinDate: string;
  reward: number;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * 签到历史取自旧站积分流水里 logtype='punch' 的记录（约 7.3 万条）：
 * 按「用户 × 北京时间自然日」去重，同日多条取最早一条的奖励；连签天数由日期重算，不依赖旧 punch 序列化串。
 * 新站只关心「当前连签」，所以每个用户只保留**最近一段连续签到**（以其最后一次签到日结尾的连续日期），
 * 更早的零散历史不迁（旧库即归档）。
 */
export function transformCheckins(
  logs: readonly { id: number; uid: number; affect: number; created_time: number }[],
  userIds: ReadonlySet<number>,
): {
  rows: CheckinRow[];
  stats: {
    logs: number;
    orphan: number;
    sameDayDuplicates: number;
    /** 有签到记录的用户数 */
    users: number;
    /** 去重后、因不在最近一段连续区间内而不迁的签到日 */
    olderDropped: number;
  };
} {
  const stats = { logs: logs.length, orphan: 0, sameDayDuplicates: 0, users: 0, olderDropped: 0 };
  const byUser = new Map<number, Map<string, number>>(); // uid → (day → reward)
  for (const l of [...logs].sort((a, b) => Number(a.id) - Number(b.id))) {
    const uid = Number(l.uid);
    const day = userIds.has(uid) ? toDatetime(Number(l.created_time))?.slice(0, 10) : undefined;
    if (!day) {
      stats.orphan++;
      continue;
    }
    const days = byUser.get(uid) ?? new Map<string, number>();
    if (days.has(day)) {
      stats.sameDayDuplicates++;
      continue;
    }
    days.set(day, Math.max(0, Number(l.affect) || 0));
    byUser.set(uid, days);
  }

  const rows: CheckinRow[] = [];
  for (const [uid, days] of [...byUser].sort((a, b) => a[0] - b[0])) {
    stats.users++;
    const sorted = [...days.keys()].sort();
    let start = sorted.length - 1;
    while (start > 0 && dayNumber(sorted[start]!) - dayNumber(sorted[start - 1]!) === 1) start--;
    stats.olderDropped += start;
    for (const day of sorted.slice(start)) {
      rows.push({ userId: uid, checkinDate: day, reward: days.get(day) ?? 0 });
    }
  }
  return { rows, stats };
}
