import { describe, expect, it } from "vitest";
import { transformCheckins, transformPoints } from "./points.js";

const ASOF = "2026-10-23 00:00:00";
const users = new Set([1, 2, 3, 4]);
const ts = (iso: string) => Math.floor(new Date(`${iso}+08:00`).getTime() / 1000);

describe("transformPoints", () => {
  it("每人一条期初分录；账户余额 = 台账之和；lifetimeEarned 同余额", () => {
    const r = transformPoints(
      [
        { uid: 1, credit1: 100 },
        { uid: 2, credit1: 0 },
      ],
      [],
      users,
      ASOF,
    );
    expect(r.accounts).toEqual([
      { userId: 1, balance: 100, lifetimeEarned: 100, lifetimeSpent: 0, updatedAt: ASOF },
    ]);
    expect(r.ledger).toEqual([
      expect.objectContaining({
        userId: 1,
        delta: 100,
        balanceAfter: 100,
        channel: "opening",
        idempotencyKey: "opening:1",
        createdAt: ASOF,
      }),
    ]);
  });

  it("银行存款（活期+定期本金）结算计入余额，另记一条分录，累计 balanceAfter 正确", () => {
    const r = transformPoints(
      [{ uid: 1, credit1: 50 }],
      [{ uid: 1, deposit: 10, ddeposit: 200 }],
      users,
      ASOF,
    );
    expect(r.ledger.map((l) => [l.idempotencyKey, l.delta, l.balanceAfter])).toEqual([
      ["opening:1", 50, 50],
      ["opening:bank:1", 210, 260],
    ]);
    expect(r.accounts[0]?.balance).toBe(260);
    expect(r.stats).toMatchObject({
      totalCredit1: 50,
      totalBank: 210,
      total: 260,
      bankAccounts: 1,
    });
  });

  it("只有银行存款也建账户；负余额按 0 处理并记录；已不存在的用户丢弃", () => {
    const r = transformPoints(
      [
        { uid: 2, credit1: -5 },
        { uid: 99, credit1: 700 },
      ],
      [
        { uid: 3, deposit: 0, ddeposit: 30 },
        { uid: 98, deposit: 5, ddeposit: 0 },
      ],
      users,
      ASOF,
    );
    expect(r.accounts.map((a) => [a.userId, a.balance])).toEqual([[3, 30]]);
    expect(r.stats).toMatchObject({ negativeClamped: [2], orphanBalances: 1, orphanBank: 1 });
  });

  it("账户与台账一致且输出有序（确定性）", () => {
    const rows = [
      { uid: 3, credit1: 3 },
      { uid: 1, credit1: 1 },
    ];
    const a = transformPoints(rows, [], users, ASOF);
    const b = transformPoints([...rows].reverse(), [], users, ASOF);
    expect(a).toEqual(b);
    for (const acc of a.accounts) {
      const sum = a.ledger.filter((l) => l.userId === acc.userId).reduce((s, l) => s + l.delta, 0);
      expect(sum).toBe(acc.balance);
    }
  });
});

describe("transformCheckins", () => {
  it("按北京时间自然日去重：同日多条取最早一条；跨日各算一次", () => {
    const r = transformCheckins(
      [
        { id: 1, uid: 1, affect: 3, created_time: ts("2013-02-04T23:30:00") },
        { id: 2, uid: 1, affect: 5, created_time: ts("2013-02-04T23:59:00") },
        { id: 3, uid: 1, affect: 2, created_time: ts("2013-02-05T00:10:00") },
      ],
      users,
    );
    expect(r.rows).toEqual([
      { userId: 1, checkinDate: "2013-02-04", reward: 3 },
      { userId: 1, checkinDate: "2013-02-05", reward: 2 },
    ]);
    expect(r.stats.sameDayDuplicates).toBe(1);
  });

  it("用户已不存在的丢弃；输入乱序结果相同；奖励不为负", () => {
    const logs = [
      { id: 2, uid: 2, affect: 1, created_time: ts("2014-01-01T08:00:00") },
      { id: 1, uid: 99, affect: 1, created_time: ts("2014-01-01T08:00:00") },
      { id: 3, uid: 1, affect: -4, created_time: ts("2014-01-02T08:00:00") },
    ];
    const a = transformCheckins(logs, users);
    expect(a.stats.orphan).toBe(1);
    expect(a.rows.every((r) => r.reward >= 0)).toBe(true);
    expect(transformCheckins([...logs].reverse(), users).rows).toEqual(a.rows);
  });
});
